import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.ts";
import { migrate, pool, waitForDb } from "./db.ts";
import { createLocalClient, ensureLocalUser, hashPassword, issueToken, requireAuth, verifyPassword } from "./auth.ts";
import { compute, downloads } from "./computeClient.ts";
import { WHISPER_SIZES, type WhisperSize } from "./models.ts";
import { askUserToPair } from "./pairing.ts";
import { startWorker, whisperSize, workerStatus } from "./worker.ts";
import { searchMeetings } from "./search.ts";
import { ask, summarize, testCredentials } from "./ai.ts";
import {
  ClaudeNotConfigured,
  credentialsFor,
  credentialsStatus,
  deleteUserCredentials,
  parseSecret,
  saveUserCredentials,
} from "./credentials.ts";
import { buildExtensionZip, extensionInfo, publicOrigin } from "./extension.ts";

// trustProxy: atrás de Caddy/nginx, usa X-Forwarded-Proto/Host para montar o endereço público.
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: true });
// Falhas do Claude viram mensagens claras para o site (com código para ele mostrar
// o atalho "Configurar Claude").
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof ClaudeNotConfigured) return reply.code(412).send({ error: err.message, code: err.code });
  const status = err.statusCode;
  if (status && status < 500) return reply.code(status).send({ error: err.message });
  app.log.error(err);
  return reply.code(502).send({ error: err.message });
});

// App local: a API só escuta em 127.0.0.1 e só aceita chamadas da extensão e da
// própria janela do app (um site aberto no navegador não consegue usá-la).
const APP_VERSION = process.env.APP_VERSION ?? "dev";
const localOrigin = (origin: string) =>
  origin.startsWith("chrome-extension://") || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
await app.register(cors, {
  origin: config.local ? (origin, cb) => cb(null, !origin || localOrigin(origin)) : true,
  allowedHeaders: ["Authorization", "Content-Type"],
});
await app.register(multipart, { limits: { fileSize: 2 * 1024 ** 3, files: 1 } });

const audioDir = path.join(config.dataDir, "audio");
await fsp.mkdir(audioDir, { recursive: true });

const userJson = (u: { id: string; email: string; name: string | null }) => ({ id: u.id, email: u.email, name: u.name });
const MAX_ASK_CHARS = 1_500_000; // ~400k tokens de transcrição por pergunta

// Linha do tempo de quem falou, lida pela extensão nas legendas do Meet/Teams.
function parseTimeline(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const events = (JSON.parse(raw) as unknown[])
      .filter((e): e is { t: number; name: string } => {
        const ev = e as { t?: unknown; name?: unknown };
        return typeof ev?.t === "number" && typeof ev?.name === "string" && !!ev.name.trim();
      })
      .slice(0, 50_000)
      .map((e) => ({ t: Math.round(e.t), name: e.name.trim().slice(0, 80) }));
    return events.length ? JSON.stringify(events) : null;
  } catch {
    return null;
  }
}

app.get("/api/health", async () => ({ ok: true, app: "escutaia", local: config.local, version: APP_VERSION }));

// Pareamento da extensão (só no app local): a pessoa aprova numa janela do app.
app.post<{ Body: { name?: string } }>("/api/pair", async (req, reply) => {
  if (!config.local) return reply.code(404).send({ error: "não disponível" });
  const origin = req.headers.origin ?? "";
  if (!origin.startsWith("chrome-extension://")) return reply.code(403).send({ error: "só a extensão pode se conectar" });
  const name = `${(req.body?.name ?? "Extensão do Chrome").slice(0, 60)} (${origin.slice("chrome-extension://".length, "chrome-extension://".length + 8)}…)`;
  if (!(await askUserToPair(name))) return reply.code(403).send({ error: "conexão recusada no app" });
  return { token: await createLocalClient(name) };
});

// Público: o site usa para decidir entre "Adicionar ao Chrome" (loja) e baixar o zip.
app.get("/api/config", async () => ({
  extensionStoreUrl: config.extensionStoreUrl,
  extensionVersion: (await extensionInfo().catch(() => null))?.version ?? null,
}));

// Instaladores do app desktop: EscutaIA-<versão>-<so>-<arq>.<ext> (nomes do electron-builder).
const INSTALLER = /^EscutaIA-([\d.]+)-(mac|win|linux)-(arm64|x64|x86_64|amd64)\.(dmg|exe|AppImage|deb)$/;
app.get("/api/downloads", async () => {
  const files = await fsp.readdir(config.downloadsDir).catch(() => [] as string[]);
  const out = [];
  for (const file of files) {
    const m = INSTALLER.exec(file);
    if (!m) continue;
    const { size } = await fsp.stat(path.join(config.downloadsDir, file));
    const arch = m[3] === "x86_64" || m[3] === "amd64" ? "x64" : m[3];
    out.push({ file, version: m[1], os: m[2], arch, format: m[4], size, url: `/downloads/${encodeURIComponent(file)}` });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
});

app.get<{ Params: { file: string } }>("/downloads/:file", async (req, reply) => {
  if (!INSTALLER.test(req.params.file)) return reply.code(404).send({ error: "arquivo não encontrado" });
  return reply.header("Content-Disposition", `attachment; filename="${req.params.file}"`).sendFile(req.params.file, config.downloadsDir);
});

app.get("/api/extension.zip", async (req, reply) => {
  const zip = await buildExtensionZip(publicOrigin(req));
  return reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", 'attachment; filename="escutaia-extension.zip"')
    .send(Buffer.from(zip));
});

// ---------- auth (só no modo servidor; o app local tem um usuário só) ----------
if (!config.local) {
app.post<{ Body: { email: string; password: string; name?: string } }>("/api/auth/signup", async (req, reply) => {
  const email = req.body?.email?.trim().toLowerCase();
  const password = req.body?.password ?? "";
  if (!email?.includes("@") || password.length < 8)
    return reply.code(400).send({ error: "email inválido ou senha com menos de 8 caracteres" });
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [email, req.body.name?.trim() || null, await hashPassword(password)],
  );
  if (!rows[0]) return reply.code(409).send({ error: "email já cadastrado" });
  return { token: issueToken(rows[0].id), user: userJson(rows[0]) };
});

app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (req, reply) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [req.body?.email?.trim().toLowerCase()]);
  if (!rows[0] || !(await verifyPassword(req.body.password ?? "", rows[0].password_hash)))
    return reply.code(401).send({ error: "email ou senha incorretos" });
  return { token: issueToken(rows[0].id), user: userJson(rows[0]) };
});
}

// ---------- rotas autenticadas ----------
await app.register(async (api) => {
  api.addHook("preHandler", requireAuth);

  // O que o app está fazendo agora: download de modelos e reunião em processamento.
  api.get("/api/status", async () => {
    const { rows } = await pool.query(
      "SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued FROM meetings",
    );
    return { local: config.local, download: downloads.current, job: workerStatus.current, queued: rows[0].queued };
  });

  // Modelo de transcrição (app local).
  api.get("/api/settings/transcription", async () => ({
    model: await whisperSize(),
    engine: config.whisper.engine,
    options: Object.entries(WHISPER_SIZES).map(([id, v]) => ({ id, ...v })),
  }));
  api.put<{ Body: { model?: string } }>("/api/settings/transcription", async (req, reply) => {
    const model = req.body?.model as WhisperSize;
    if (!(model in WHISPER_SIZES)) return reply.code(400).send({ error: "modelo inválido" });
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('whisper_model', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(model)],
    );
    // Já baixa o novo modelo em segundo plano.
    compute("prepare", { size: model, diarization: config.diarization.enabled }).catch((e) => app.log.error(e));
    return { model };
  });

  // Extensões conectadas ao app local (para revogar).
  api.get("/api/local/clients", async () => {
    const { rows } = await pool.query("SELECT id, name, created_at, last_seen_at FROM local_clients ORDER BY created_at DESC");
    return rows;
  });
  api.delete<{ Params: { id: string } }>("/api/local/clients/:id", async (req) => {
    await pool.query("DELETE FROM local_clients WHERE id = $1", [req.params.id]);
    return { ok: true };
  });

  api.get("/api/me", async (req) => {
    const { rows } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [req.userId]);
    return userJson(rows[0]);
  });

  // Upload vindo da extensão (ou do site): multipart com `file` + campos opcionais.
  api.post("/api/meetings", async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "envie o arquivo no campo `file`" });
    const field = (name: string) => {
      const f = part.fields[name] as { value?: string } | undefined;
      return typeof f?.value === "string" && f.value.trim() ? f.value.trim() : null;
    };
    const ext = path.extname(part.filename || "").slice(0, 10) || ".webm";
    const { rows } = await pool.query(
      `INSERT INTO meetings (user_id, title, source_url, platform, started_at, audio_path, status, speaker_timeline)
       VALUES ($1, $2, $3, $4, $5, '', 'failed', $6) RETURNING id`,
      [
        req.userId,
        field("title") ?? part.filename ?? "Reunião sem título",
        field("sourceUrl"),
        field("platform"),
        field("startedAt"),
        parseTimeline(field("speakerTimeline")),
      ],
    );
    const id = rows[0].id;
    const file = path.join(audioDir, `${id}${ext}`);
    await pipeline(part.file, fs.createWriteStream(file));
    if (part.file.truncated) {
      await pool.query("DELETE FROM meetings WHERE id = $1", [id]);
      await fsp.rm(file, { force: true });
      return reply.code(413).send({ error: "arquivo grande demais" });
    }
    // Só entra na fila depois que o arquivo terminou de gravar.
    await pool.query("UPDATE meetings SET audio_path = $2, status = 'queued' WHERE id = $1", [id, file]);
    return reply.code(201).send({ id, status: "queued" });
  });

  api.get<{ Querystring: { page?: string; limit?: string } }>("/api/meetings", async (req) => {
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { rows } = await pool.query(
      `SELECT id, title, status, error, platform, source_url, duration_ms, created_at, started_at,
              count(*) OVER () AS total
       FROM meetings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.userId, limit, (page - 1) * limit],
    );
    const total = rows.length ? Number(rows[0].total) : 0;
    return { total, page, pages: Math.ceil(total / limit), results: rows.map(({ total: _, ...r }) => r) };
  });

  api.get<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, title, status, error, platform, source_url, duration_ms, summary, summary_error, speakers,
              speakers_others, speakers_pending, speaker_timeline IS NOT NULL AS has_timeline, created_at, started_at
       FROM meetings WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ error: "reunião não encontrada" });
    const segs = await pool.query(
      "SELECT idx, start_ms, end_ms, speaker, text FROM segments WHERE meeting_id = $1 ORDER BY idx",
      [req.params.id],
    );
    return { ...rows[0], segments: segs.rows };
  });

  api.get<{ Params: { id: string } }>("/api/meetings/:id/audio", async (req, reply) => {
    const { rows } = await pool.query("SELECT audio_path FROM meetings WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.userId,
    ]);
    if (!rows[0]?.audio_path) return reply.code(404).send({ error: "áudio não encontrado" });
    return reply.sendFile(path.basename(rows[0].audio_path), path.dirname(rows[0].audio_path));
  });

  api.patch<{ Params: { id: string }; Body: { title?: string } }>("/api/meetings/:id", async (req, reply) => {
    const title = req.body?.title?.trim();
    if (!title) return reply.code(400).send({ error: "título vazio" });
    const { rowCount } = await pool.query("UPDATE meetings SET title = $3 WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.userId,
      title,
    ]);
    return rowCount ? { ok: true } : reply.code(404).send({ error: "reunião não encontrada" });
  });

  // Renomear falantes: { "S1": "Ana", "me": "Bruno" }. Só rótulos que já existem.
  // Dar a um participante o nome de outro JUNTA os dois (corrige a identificação).
  api.patch<{ Params: { id: string }; Body: Record<string, string> }>("/api/meetings/:id/speakers", async (req, reply) => {
    const { rows } = await pool.query("SELECT speakers FROM meetings WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    if (!rows[0]) return reply.code(404).send({ error: "reunião não encontrada" });
    const speakers: Record<string, string> = { ...rows[0].speakers };
    const merges: [string, string][] = [];
    for (const [label, raw] of Object.entries(req.body ?? {})) {
      const name = typeof raw === "string" ? raw.trim().slice(0, 80) : "";
      if (!(label in speakers) || !name) continue;
      const same = Object.keys(speakers).find((l) => l !== label && speakers[l].toLocaleLowerCase() === name.toLocaleLowerCase());
      // "me" nunca some: se for juntar com "me", os outros entram nele.
      if (same) merges.push(label === "me" ? [same, label] : [label, same]);
      else speakers[label] = name;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [from, into] of merges) {
        await client.query("UPDATE segments SET speaker = $3 WHERE meeting_id = $1 AND speaker = $2", [req.params.id, from, into]);
        delete speakers[from];
      }
      await client.query("UPDATE meetings SET speakers = $2 WHERE id = $1", [req.params.id, JSON.stringify(speakers)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { speakers, merged: merges.length };
  });

  // Trocar quem disse um trecho: { speaker: "S2" } ou { speaker: "new" } (novo participante).
  api.patch<{ Params: { id: string; idx: string }; Body: { speaker?: string } }>(
    "/api/meetings/:id/segments/:idx",
    async (req, reply) => {
      const { rows } = await pool.query("SELECT speakers FROM meetings WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
      if (!rows[0]) return reply.code(404).send({ error: "reunião não encontrada" });
      const speakers: Record<string, string> = { ...rows[0].speakers };
      let label = req.body?.speaker ?? "";
      if (label === "new") {
        const n = Math.max(0, ...Object.keys(speakers).filter((k) => k !== "me").map((k) => Number(k.slice(1)))) + 1;
        label = `S${n}`;
        speakers[label] = `Participante ${n}`;
      }
      if (!(label in speakers)) return reply.code(400).send({ error: "participante inválido" });
      const { rowCount } = await pool.query("UPDATE segments SET speaker = $3 WHERE meeting_id = $1 AND idx = $2", [
        req.params.id,
        Number(req.params.idx),
        label,
      ]);
      if (!rowCount) return reply.code(404).send({ error: "trecho não encontrado" });
      // Remove participantes que ficaram sem nenhuma fala.
      const used = await pool.query("SELECT DISTINCT speaker FROM segments WHERE meeting_id = $1 AND speaker IS NOT NULL", [req.params.id]);
      const alive = new Set(used.rows.map((r) => r.speaker));
      for (const k of Object.keys(speakers)) if (!alive.has(k)) delete speakers[k];
      await pool.query("UPDATE meetings SET speakers = $2 WHERE id = $1", [req.params.id, JSON.stringify(speakers)]);
      return { speakers, speaker: label };
    },
  );

  // Refazer quem fala: { others: 1 } = só mais 1 pessoa além de você; { others: null } = automático.
  api.post<{ Params: { id: string }; Body: { others?: number | null } }>("/api/meetings/:id/speakers/redo", async (req, reply) => {
    const others = req.body?.others == null ? null : Math.round(Number(req.body.others));
    if (others !== null && !(others >= 1 && others <= 20)) return reply.code(400).send({ error: "informe de 1 a 20 pessoas" });
    const { rowCount } = await pool.query(
      `UPDATE meetings SET speakers_others = $3, speakers_pending = true
       WHERE id = $1 AND user_id = $2 AND status = 'ready'`,
      [req.params.id, req.userId, others],
    );
    return rowCount ? { ok: true } : reply.code(409).send({ error: "a reunião ainda não está pronta" });
  });

  // Refaz o resumo (ex.: depois de renomear os participantes).
  api.post<{ Params: { id: string } }>("/api/meetings/:id/summary", async (req, reply) => {
    const { rows } = await pool.query("SELECT title, speakers FROM meetings WHERE id = $1 AND user_id = $2 AND status = 'ready'", [
      req.params.id,
      req.userId,
    ]);
    if (!rows[0]) return reply.code(409).send({ error: "a reunião ainda não está pronta" });
    const segs = await pool.query("SELECT start_ms, speaker, text FROM segments WHERE meeting_id = $1 ORDER BY idx", [req.params.id]);
    try {
      const summary = await summarize(await credentialsFor(req.userId), rows[0].title, segs.rows, rows[0].speakers);
      await pool.query("UPDATE meetings SET summary = $2, summary_error = NULL WHERE id = $1", [req.params.id, summary]);
      return { summary };
    } catch (e) {
      await pool.query("UPDATE meetings SET summary_error = $2 WHERE id = $1", [req.params.id, (e as Error).message]);
      throw e;
    }
  });

  // Gera, em segundo plano, os resumos que falharam (ex.: antes de configurar o Claude).
  api.post("/api/meetings/summarize-pending", async (req) => {
    const creds = await credentialsFor(req.userId);
    const { rows } = await pool.query(
      `SELECT id, title, speakers FROM meetings
       WHERE user_id = $1 AND status = 'ready' AND summary IS NULL
         AND EXISTS (SELECT 1 FROM segments WHERE meeting_id = meetings.id)
       ORDER BY created_at DESC`,
      [req.userId],
    );
    (async () => {
      for (const m of rows) {
        try {
          const segs = await pool.query("SELECT start_ms, speaker, text FROM segments WHERE meeting_id = $1 ORDER BY idx", [m.id]);
          const summary = await summarize(creds, m.title, segs.rows, m.speakers);
          await pool.query("UPDATE meetings SET summary = $2, summary_error = NULL WHERE id = $1", [m.id, summary]);
        } catch (e) {
          await pool.query("UPDATE meetings SET summary_error = $2 WHERE id = $1", [m.id, (e as Error).message]);
        }
      }
    })().catch((e) => app.log.error(e));
    return { queued: rows.length };
  });

  // ---------- configurações: Claude ----------
  api.get("/api/settings/claude", async (req) => {
    const status = await credentialsStatus(req.userId);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM meetings WHERE user_id = $1 AND status = 'ready' AND summary IS NULL
         AND EXISTS (SELECT 1 FROM segments WHERE meeting_id = meetings.id)`,
      [req.userId],
    );
    return { ...status, pendingSummaries: rows[0].n };
  });

  // Recebe o token colado na tela, testa com uma chamada mínima e só então salva.
  api.put<{ Body: { token?: string } }>("/api/settings/claude", async (req, reply) => {
    let creds;
    try {
      creds = parseSecret(req.body?.token ?? "");
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    try {
      await testCredentials(creds);
    } catch (e) {
      return reply.code(422).send({ error: `O teste falhou: ${(e as Error).message}` });
    }
    await saveUserCredentials(req.userId, creds);
    return credentialsStatus(req.userId);
  });

  api.post("/api/settings/claude/test", async (req) => {
    await testCredentials(await credentialsFor(req.userId));
    return { ok: true };
  });

  api.delete("/api/settings/claude", async (req) => {
    await deleteUserCredentials(req.userId);
    return credentialsStatus(req.userId);
  });

  api.delete<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
    const { rows } = await pool.query("DELETE FROM meetings WHERE id = $1 AND user_id = $2 RETURNING audio_path", [
      req.params.id,
      req.userId,
    ]);
    if (!rows[0]) return reply.code(404).send({ error: "reunião não encontrada" });
    if (rows[0].audio_path) await fsp.rm(rows[0].audio_path, { force: true });
    return { ok: true };
  });

  api.post<{ Params: { id: string } }>("/api/meetings/:id/retry", async (req, reply) => {
    const { rowCount } = await pool.query(
      "UPDATE meetings SET status = 'queued', error = NULL WHERE id = $1 AND user_id = $2 AND status = 'failed'",
      [req.params.id, req.userId],
    );
    return rowCount ? { ok: true } : reply.code(409).send({ error: "só dá para reprocessar reuniões com falha" });
  });

  // ---------- busca ----------
  api.get<{ Querystring: { q?: string; page?: string; limit?: string } }>("/api/search", async (req, reply) => {
    const q = req.query.q?.trim();
    if (!q) return reply.code(400).send({ error: "parâmetro q vazio" });
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const page = Math.max(Number(req.query.page) || 1, 1);
    return searchMeetings(req.userId, q, limit, (page - 1) * limit);
  });

  // ---------- perguntas ao Claude ----------
  // meetingIds: pergunta sobre reuniões específicas. q: usa a busca para escolher as reuniões.
  api.post<{ Body: { question: string; meetingIds?: string[]; q?: string } }>("/api/ask", async (req, reply) => {
    const question = req.body?.question?.trim();
    if (!question) return reply.code(400).send({ error: "pergunta vazia" });
    let ids = req.body.meetingIds ?? [];
    if (!ids.length) {
      const found = await searchMeetings(req.userId, req.body.q?.trim() || question, 8, 0);
      ids = found.results.map((r) => r.id);
    }
    if (!ids.length) return { answer: "Não encontrei reuniões relacionadas a essa pergunta.", meetings: [] };

    const { rows: meetings } = await pool.query(
      `SELECT id, title, created_at, speakers FROM meetings
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND status IN ('summarizing', 'ready')`,
      [req.userId, ids],
    );
    const { rows: segs } = await pool.query(
      "SELECT meeting_id, start_ms, speaker, text FROM segments WHERE meeting_id = ANY($1::uuid[]) ORDER BY meeting_id, idx",
      [meetings.map((m) => m.id)],
    );
    let budget = MAX_ASK_CHARS;
    const ordered = ids.flatMap((id) => meetings.filter((m) => m.id === id));
    const context = [];
    for (const m of ordered) {
      const segments = segs.filter((s) => s.meeting_id === m.id);
      const size = segments.reduce((n, s) => n + s.text.length + 16, 0);
      if (size > budget) break;
      budget -= size;
      context.push({ title: m.title, date: new Date(m.created_at).toISOString().slice(0, 10), segments, speakers: m.speakers });
    }
    if (!context.length) return reply.code(422).send({ error: "as reuniões encontradas ainda não foram transcritas" });
    const answer = await ask(await credentialsFor(req.userId), question, context);
    return { answer, meetings: ordered.slice(0, context.length).map((m) => ({ id: m.id, title: m.title })) };
  });
});

// ---------- site (build do Vite) ----------
if (config.webDist && fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/") ? reply.code(404).send({ error: "rota não encontrada" }) : reply.sendFile("index.html"),
  );
} else {
  // sendFile do áudio precisa do decorator mesmo sem o site.
  await app.register(fastifyStatic, { root: audioDir, serve: false });
}

await waitForDb();
await migrate();
if (config.local) {
  await ensureLocalUser();
  // App local: worker no mesmo processo (o cálculo pesado já roda numa thread) e
  // download dos modelos logo na 1ª abertura, para a 1ª reunião não esperar.
  startWorker().catch((e) => app.log.error(e));
  compute("prepare", { size: await whisperSize(), diarization: config.diarization.enabled }).catch((e) =>
    app.log.error(`download dos modelos falhou: ${(e as Error).message}`),
  );
}
await app.listen({ port: config.port, host: config.host });
