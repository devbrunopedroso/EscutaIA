// Identificação de quem fala.
//
// Gravações da extensão chegam em estéreo: canal esquerdo = microfone do usuário,
// canal direito = áudio da aba (os outros participantes). Isso separa "você" dos
// demais com segurança, e a diarização (sherpa-onnx, roda em CPU) separa os
// participantes da aba entre si. Uploads mono passam inteiros pela diarização.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { config } from "./config.ts";
import { ensureModelFiles, MODEL_SETS, type Progress } from "./models.ts";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;
const FRAME = SAMPLE_RATE / 10; // RMS em janelas de 100 ms
export const ME = "me";

// Segmentação pyannote 3.0 + embeddings nemo_en_titanet_small (escolhido comparando
// 3 modelos em áudio em português; ver README).
export async function ensureDiarizationModels(onProgress?: Progress): Promise<{ segmentation: string; embedding: string }> {
  const [segmentation, embedding] = await ensureModelFiles("Identificação de falantes", MODEL_SETS.diarization(), onProgress);
  return { segmentation, embedding };
}

interface Decoded {
  // Amostras usadas na diarização: canal da aba (estéreo) ou o áudio todo (mono).
  samples: Float32Array;
  // RMS por janela de 100 ms; mic só existe em gravações estéreo.
  rmsOthers: Float32Array;
  rmsMic: Float32Array | null;
}

// Decodifica para float32 16 kHz via ffmpeg, em streaming, sem arquivos temporários.
// Sempre decodifica em 2 canais: arquivo mono vira L = R. Se os canais forem praticamente
// iguais, é mono (upload pelo site); senão é a gravação estéreo da extensão/app.
function decode(file: string, stereo = true): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const ch = stereo ? 2 : 1;
    const proc = spawn(config.ffmpeg, ["-nostdin", "-loglevel", "error", "-i", file, "-ac", String(ch), "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parts: Float32Array[] = [];
    const rmsOthers: number[] = [];
    const rmsMic: number[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let frameN = 0, sumO = 0, sumM = 0;
    let diff = 0, energy = 0; // para saber se os canais são diferentes (estéreo de verdade)
    let err = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const bytesPerFrame = 4 * ch;
      const usable = buf.length - (buf.length % bytesPerFrame);
      carry = buf.subarray(usable);
      const n = usable / bytesPerFrame;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let other: number;
        if (stereo) {
          const mic = buf.readFloatLE(i * 8);
          other = buf.readFloatLE(i * 8 + 4);
          sumM += mic * mic;
          diff += (mic - other) * (mic - other);
          energy += mic * mic + other * other;
        } else {
          other = buf.readFloatLE(i * 4);
        }
        out[i] = other;
        sumO += other * other;
        if (++frameN === FRAME) {
          rmsOthers.push(Math.sqrt(sumO / FRAME));
          if (stereo) rmsMic.push(Math.sqrt(sumM / FRAME));
          frameN = sumO = sumM = 0;
        }
      }
      parts.push(out);
    });
    proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (decode) saiu com ${code}: ${err.trim()}`));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const samples = new Float32Array(total);
      let off = 0;
      for (const p of parts) samples.set(p, (off += p.length) - p.length);
      const reallyStereo = stereo && energy > 0 && diff > energy * 1e-4;
      resolve({ samples, rmsOthers: Float32Array.from(rmsOthers), rmsMic: reallyStereo ? Float32Array.from(rmsMic) : null });
    });
  });
}

interface Turn {
  start: number;
  end: number;
  speaker: number;
}

// Grupos de voz com menos fala que isso (no total) não viram uma pessoa nova: falas
// curtas ("Oi.", "Estou!") dão uma impressão de voz fraca demais em áudio comprimido
// de Meet/Teams. Medido em reuniões reais: Meet 4→1 grupos (certo), Teams 8→3.
const MIN_SPEAKER_SECONDS = 3;

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function runDiarization(
  samples: Float32Array,
  models: { segmentation: string; embedding: string },
  numSpeakers: number | null,
): Turn[] {
  const sherpa = require("sherpa-onnx-node");
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models.segmentation }, numThreads: config.whisper.threads },
    embedding: { model: models.embedding, numThreads: config.whisper.threads },
    clustering: numSpeakers ? { numClusters: numSpeakers } : { numClusters: -1, threshold: config.diarization.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const turns: Turn[] = sd.process(samples);
  return numSpeakers ? turns : absorbSmallGroups(turns, samples, models.embedding);
}

// Junta cada grupo pequeno ao grupo grande com a voz mais parecida (impressão de voz
// calculada sobre toda a fala do grupo, bem mais confiável que fala por fala).
function absorbSmallGroups(turns: Turn[], samples: Float32Array, embeddingModel: string): Turn[] {
  const groups = new Map<number, { seconds: number; parts: Float32Array[] }>();
  for (const t of turns) {
    const g = groups.get(t.speaker) ?? { seconds: 0, parts: [] };
    g.seconds += t.end - t.start;
    g.parts.push(samples.subarray(Math.floor(t.start * SAMPLE_RATE), Math.floor(t.end * SAMPLE_RATE)));
    groups.set(t.speaker, g);
  }
  if (groups.size <= 1) return turns;
  let big = [...groups].filter(([, g]) => g.seconds >= MIN_SPEAKER_SECONDS).map(([k]) => k);
  if (!big.length) big = [[...groups].sort((a, b) => b[1].seconds - a[1].seconds)[0][0]];
  if (big.length === groups.size) return turns;

  const sherpa = require("sherpa-onnx-node");
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: embeddingModel, numThreads: config.whisper.threads });
  const embed = (parts: Float32Array[]) => {
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) all.set(p, (off += p.length) - p.length);
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: all });
    return extractor.compute(stream) as Float32Array;
  };
  const bigEmb = new Map(big.map((k) => [k, embed(groups.get(k)!.parts)]));
  const target = new Map<number, number>();
  for (const [k, g] of groups) {
    if (bigEmb.has(k)) continue;
    const e = embed(g.parts);
    let best = big[0], bestSim = -Infinity;
    for (const [bk, be] of bigEmb) {
      const sim = cosine(e, be);
      if (sim > bestSim) [best, bestSim] = [bk, sim];
    }
    target.set(k, best);
  }
  return turns.map((t) => ({ ...t, speaker: target.get(t.speaker) ?? t.speaker }));
}

const mean = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  const lo = Math.max(0, from), hi = Math.min(a.length, to);
  for (let i = lo; i < hi; i++) s += a[i];
  return hi > lo ? s / (hi - lo) : 0;
};

export interface Labeled {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}

// Quem estava falando segundo a própria plataforma (legendas do Meet/Teams lidas pela
// extensão). t = ms desde o início da gravação.
export type SpeakerTimeline = { t: number; name: string }[];

export interface LabelOptions {
  meName: string;
  // Quantas pessoas falaram além de você (informado na tela). null = automático.
  others?: number | null;
  timeline?: SpeakerTimeline | null;
  onProgress?: Progress;
}

// As legendas aparecem um pouco depois da fala; a janela compensa esse atraso.
function nameFromTimeline(timeline: SpeakerTimeline, startMs: number, endMs: number): string | null {
  const votes = new Map<string, number>();
  for (const ev of timeline) {
    if (ev.t < startMs - 1000 || ev.t > endMs + 3000) continue;
    votes.set(ev.name, (votes.get(ev.name) ?? 0) + 1);
  }
  let best: string | null = null, n = 0;
  for (const [name, c] of votes) if (c > n) [best, n] = [name, c];
  return best;
}

// Devolve os segmentos com `speaker` = "me" | "S1" | "S2"... e o mapa de nomes.
export async function labelSpeakers(
  audioPath: string,
  segments: { start_ms: number; end_ms: number; text: string }[],
  opts: LabelOptions,
): Promise<{ segments: Labeled[]; speakers: Record<string, string> }> {
  const audio = await decode(audioPath);

  // 1) Você: o canal do microfone domina (a aba não devolve a sua própria voz).
  const isMe = segments.map((seg) => {
    if (!audio.rmsMic) return false;
    const f0 = Math.floor(seg.start_ms / 100), f1 = Math.ceil(seg.end_ms / 100);
    const mic = mean(audio.rmsMic, f0, f1);
    return mic > 0.005 && mic > 2 * mean(audio.rmsOthers, f0, f1);
  });

  // 2) Os outros: diarização (automática ou com o número informado).
  let turns: Turn[] = [];
  if (opts.others !== 1) {
    turns = runDiarization(audio.samples, await ensureDiarizationModels(opts.onProgress), opts.others ?? null);
  }

  const order = new Map<string, string>(); // chave do grupo (ou nome) -> rótulo S1, S2...
  const names = new Map<string, string>(); // rótulo -> nome exibido
  const labelFor = (key: string, name?: string) => {
    if (!order.has(key)) {
      const label = `S${order.size + 1}`;
      order.set(key, label);
      names.set(label, name ?? `Participante ${order.size}`);
    }
    return order.get(key)!;
  };

  const clusterOf = (seg: { start_ms: number; end_ms: number }): number | null => {
    if (opts.others === 1) return 0;
    const s = seg.start_ms / 1000, e = seg.end_ms / 1000;
    const overlap = new Map<number, number>();
    for (const t of turns) {
      const o = Math.min(e, t.end) - Math.max(s, t.start);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
    }
    let best: number | null = null, bestOverlap = 0;
    for (const [spk, o] of overlap) if (o > bestOverlap) [best, bestOverlap] = [spk, o];
    if (best === null && turns.length) {
      const mid = (s + e) / 2;
      best = turns.reduce((a, t) => (Math.abs((t.start + t.end) / 2 - mid) < Math.abs((a.start + a.end) / 2 - mid) ? t : a)).speaker;
    }
    return best;
  };

  // 3) Nomes reais (legendas): cada nome vira um participante; trechos sem legenda
  //    herdam o nome mais votado do seu grupo de voz.
  const timeline = opts.timeline?.length ? opts.timeline : null;
  const clusters = segments.map((seg, i) => (isMe[i] ? null : clusterOf(seg)));
  const segNames = segments.map((seg, i) => (isMe[i] || !timeline ? null : nameFromTimeline(timeline, seg.start_ms, seg.end_ms)));
  const clusterName = new Map<number, string>();
  if (timeline) {
    const votes = new Map<number, Map<string, number>>();
    clusters.forEach((c, i) => {
      if (c === null || !segNames[i]) return;
      const v = votes.get(c) ?? new Map<string, number>();
      v.set(segNames[i]!, (v.get(segNames[i]!) ?? 0) + 1);
      votes.set(c, v);
    });
    for (const [c, v] of votes) clusterName.set(c, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  }

  const labeled = segments.map((seg, i): Labeled => {
    if (isMe[i]) return { ...seg, speaker: ME };
    const name = segNames[i] ?? (clusters[i] !== null ? clusterName.get(clusters[i]!) : undefined);
    if (name) return { ...seg, speaker: labelFor(`name:${name}`, name) };
    if (clusters[i] === null) return { ...seg, speaker: null };
    return { ...seg, speaker: labelFor(`cluster:${clusters[i]}`) };
  });

  const speakers: Record<string, string> = {};
  if (labeled.some((s) => s.speaker === ME)) speakers[ME] = opts.meName;
  for (const [label, name] of names) speakers[label] = name;
  return { segments: labeled, speakers };
}
