// Worker: pega reuniões da fila, transcreve, identifica quem fala e gera o resumo com o
// Claude. O cálculo pesado roda numa thread (computeClient). No Docker, vários workers
// podem rodar em paralelo (FOR UPDATE SKIP LOCKED).
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { summarize } from "./ai.ts";
import { compute } from "./computeClient.ts";
import { credentialsFor } from "./credentials.ts";
import type { Labeled, SpeakerTimeline } from "./diarize.ts";
import type { WhisperSize } from "./models.ts";
import { notifyApp } from "./pairing.ts";
import type { Segment } from "./transcribe.ts";

const POLL_MS = 3000;

// Status para a tela (GET /api/status).
export const workerStatus = { current: null as null | { id: string; title: string; stage: string; since: number } };

// Modelo do Whisper escolhido em Configurações (app local) ou WHISPER_MODEL (Docker).
export async function whisperSize(): Promise<WhisperSize> {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'whisper_model'");
  return (rows[0]?.value ?? config.whisper.model) as WhisperSize;
}

interface Job {
  id: string;
  user_id: string;
  title: string;
  audio_path: string;
  user_name: string;
  speakers_others: number | null;
  speaker_timeline: SpeakerTimeline | null;
}

const JOB_COLUMNS = `id, user_id, title, audio_path, speakers_others, speaker_timeline,
  (SELECT coalesce(nullif(name, ''), 'Você') FROM users WHERE users.id = meetings.user_id) AS user_name`;

async function claimNext() {
  const { rows } = await pool.query(
    `UPDATE meetings SET status = 'transcribing', error = NULL, claimed_at = now()
     WHERE id = (SELECT id FROM meetings WHERE status = 'queued' ORDER BY created_at
                 FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING ${JOB_COLUMNS}`,
  );
  return rows[0] as Job | undefined;
}

// Pedido da tela: refazer quem fala (ex.: "1 pessoa além de você").
async function claimSpeakerJob() {
  const { rows } = await pool.query(
    `UPDATE meetings SET speakers_pending = false
     WHERE id = (SELECT id FROM meetings WHERE speakers_pending AND status = 'ready' ORDER BY created_at
                 FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING ${JOB_COLUMNS}, speakers`,
  );
  return rows[0] as (Job & { speakers: Record<string, string> }) | undefined;
}

async function relabelMeeting(m: Job & { speakers: Record<string, string> }) {
  const { rows: segs } = await pool.query("SELECT idx, start_ms, end_ms, text FROM segments WHERE meeting_id = $1 ORDER BY idx", [m.id]);
  const t = Date.now();
  workerStatus.current = { id: m.id, title: m.title, stage: "Identificando quem fala", since: Date.now() };
  const result = await compute<{ segments: Labeled[]; speakers: Record<string, string> }>("label", {
    audioPath: m.audio_path,
    segments: segs,
    opts: { meName: m.speakers.me ?? m.user_name, others: m.speakers_others, timeline: m.speaker_timeline },
  }).finally(() => (workerStatus.current = null));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE segments s SET speaker = u.spk FROM unnest($2::int[], $3::text[]) AS u(idx, spk)
       WHERE s.meeting_id = $1 AND s.idx = u.idx`,
      [m.id, segs.map((s) => s.idx), result.segments.map((s) => s.speaker)],
    );
    await client.query("UPDATE meetings SET speakers = $2 WHERE id = $1", [m.id, JSON.stringify(result.speakers)]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(`[worker] falantes refeitos ${m.id}: ${Object.values(result.speakers).join(", ")} (${Date.now() - t} ms)`);
}

async function processMeeting(m: Job) {
  console.log(`[worker] transcrevendo ${m.id} (${m.title})`);
  const stage = (s: string) => (workerStatus.current = { id: m.id, title: m.title, stage: s, since: Date.now() });
  stage("Transcrevendo");
  const raw = await compute<Segment[]>("transcribe", { audioPath: m.audio_path, size: await whisperSize() });
  let segments: Labeled[] = raw.map((s) => ({ ...s, speaker: null }));
  let speakers: Record<string, string> = {};
  if (config.diarization.enabled && segments.length) {
    try {
      const t = Date.now();
      stage("Identificando quem fala");
      ({ segments, speakers } = await compute<{ segments: Labeled[]; speakers: Record<string, string> }>("label", {
        audioPath: m.audio_path,
        segments,
        opts: { meName: m.user_name, others: m.speakers_others, timeline: m.speaker_timeline },
      }));
      console.log(`[worker] falantes de ${m.id}: ${Object.values(speakers).join(", ")} (${Date.now() - t} ms)`);
    } catch (e) {
      // Sem diarização a reunião continua utilizável; só não terá nomes.
      console.error(`[worker] diarização falhou para ${m.id}:`, e);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM segments WHERE meeting_id = $1", [m.id]);
    if (segments.length) {
      await client.query(
        `INSERT INTO segments (meeting_id, idx, start_ms, end_ms, text, speaker)
         SELECT $1, i - 1, s, e, t, spk
         FROM unnest($2::int[], $3::int[], $4::text[], $5::text[]) WITH ORDINALITY AS u(s, e, t, spk, i)`,
        [
          m.id,
          segments.map((s) => s.start_ms),
          segments.map((s) => s.end_ms),
          segments.map((s) => s.text),
          segments.map((s) => s.speaker),
        ],
      );
    }
    await client.query("UPDATE meetings SET status = 'summarizing', duration_ms = $2, speakers = $3 WHERE id = $1", [
      m.id,
      segments.at(-1)?.end_ms ?? 0,
      JSON.stringify(speakers),
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // A busca já funciona a partir daqui; o resumo é um extra. Se falhar (ex.: Claude
  // não configurado), o site mostra o motivo e um botão para gerar depois.
  let summary: string | null = null;
  let summaryError: string | null = null;
  if (segments.length) {
    stage("Gerando resumo");
    try {
      summary = await summarize(await credentialsFor(m.user_id), m.title, segments, speakers);
    } catch (e) {
      console.error(`[worker] resumo falhou para ${m.id}: ${(e as Error).message}`);
      summaryError = (e as Error).message;
    }
  }
  await pool.query("UPDATE meetings SET status = 'ready', summary = $2, summary_error = $3 WHERE id = $1", [
    m.id,
    summary,
    summaryError,
  ]);
  workerStatus.current = null;
  notifyApp({ type: "meeting-ready", id: m.id, title: m.title, summary: !!summary });
  console.log(`[worker] pronto ${m.id}: ${segments.length} trechos`);
}

export async function startWorker(): Promise<void> {
  // Reuniões presas (worker caiu no meio) voltam para a fila. O prazo evita roubar
  // o trabalho de outro worker que ainda está processando; no app local só há um.
  await pool.query(
    `UPDATE meetings SET status = 'queued'
     WHERE status IN ('transcribing', 'summarizing')
       AND (claimed_at < now() - interval '6 hours' OR $1)`,
    [config.local],
  );
  console.log(`[worker] pronto (motor ${config.whisper.engine}, falantes ${config.diarization.enabled ? "on" : "off"})`);

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));

  while (!stopping) {
    const m = await claimNext();
    if (!m) {
      const job = await claimSpeakerJob();
      if (job) {
        await relabelMeeting(job).catch((e) => console.error(`[worker] refazer falantes falhou ${job.id}:`, e));
        continue;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    try {
      await processMeeting(m);
    } catch (e) {
      workerStatus.current = null;
      console.error(`[worker] falhou ${m.id}:`, e);
      await pool.query("UPDATE meetings SET status = 'failed', error = $2 WHERE id = $1", [m.id, (e as Error).message.slice(0, 2000)]);
    }
  }
}
