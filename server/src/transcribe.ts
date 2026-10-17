// Transcrição. Dois motores:
//  - "sherpa": Whisper (int8) do sherpa-onnx, embutido no app; VAD corta a fala em trechos
//    curtos (até 8 s), o que dá timestamps precisos e evita repetições do Whisper.
//  - "whispercpp": binário whisper-cli (imagem Docker).
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { ensureModelFiles, MODEL_SETS, type Progress, type WhisperSize } from "./models.ts";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;

export interface Segment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    proc.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} saiu com ${code}: ${err.trim()}`))));
  });
}

// "[Música]", "[BLANK_AUDIO]", "(risos)"… e textos que só repetem a mesma frase.
function clean(text: string): string {
  let t = text.trim();
  if (/^[\[(].*[\])]$/.test(t)) return "";
  // Whisper às vezes entra em loop: "o que você quer fazer com o que você quer fazer…".
  const words = t.split(/\s+/);
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i + n * 3 <= words.length; i++) {
      const gram = words.slice(i, i + n).join(" ");
      let reps = 1;
      while (words.slice(i + reps * n, i + (reps + 1) * n).join(" ") === gram) reps++;
      if (reps >= 3) return words.slice(0, i + n).join(" ") + "…";
    }
  }
  return t;
}

// ---------------- sherpa-onnx ----------------
let recognizer: any = null;
let recognizerSize: WhisperSize | null = null;

async function sherpaRecognizer(size: WhisperSize, onProgress?: Progress) {
  if (recognizer && recognizerSize === size) return recognizer;
  const [encoder, decoder, tokens] = await ensureModelFiles(`Whisper ${size}`, MODEL_SETS.whisper(size), onProgress);
  const sherpa = require("sherpa-onnx-node");
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: { encoder, decoder, language: config.whisper.language, task: "transcribe" },
      tokens,
      numThreads: config.whisper.threads,
      provider: "cpu",
    },
  });
  recognizerSize = size;
  return recognizer;
}

async function transcribeSherpa(audioPath: string, size: WhisperSize, onProgress?: Progress): Promise<Segment[]> {
  const rec = await sherpaRecognizer(size, onProgress);
  const [vadModel] = await ensureModelFiles("Detector de fala", MODEL_SETS.vad(), onProgress);
  const sherpa = require("sherpa-onnx-node");
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: vadModel, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.25, maxSpeechDuration: 8, windowSize: 512 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
    },
    60,
  );
  const window = vad.config.sileroVad.windowSize;
  const out: Segment[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: seg.samples });
      rec.decode(stream);
      const text = clean(rec.getResult(stream).text);
      const start = Math.round((seg.start / SAMPLE_RATE) * 1000);
      if (text) out.push({ start_ms: start, end_ms: start + Math.round((seg.samples.length / SAMPLE_RATE) * 1000), text });
    }
  };

  // ffmpeg → PCM float 16 kHz mono, em fluxo (reunião longa não precisa caber na memória).
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(config.ffmpeg, ["-nostdin", "-loglevel", "error", "-i", audioPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let carry: Buffer = Buffer.alloc(0);
    let pending = new Float32Array(0);
    let err = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = buf.subarray(usable);
      const floats = new Float32Array(usable / 4);
      for (let i = 0; i < floats.length; i++) floats[i] = buf.readFloatLE(i * 4);
      const all = new Float32Array(pending.length + floats.length);
      all.set(pending);
      all.set(floats, pending.length);
      let i = 0;
      for (; i + window <= all.length; i += window) {
        vad.acceptWaveform(all.subarray(i, i + window));
        drain();
      }
      pending = all.slice(i);
    });
    proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${code}: ${err.trim()}`))));
  });
  vad.flush();
  drain();
  return out;
}

// ---------------- whisper.cpp ----------------
interface WhisperJson {
  transcription: { offsets: { from: number; to: number }; text: string }[];
}

async function transcribeWhisperCpp(audioPath: string, onProgress?: Progress): Promise<Segment[]> {
  const [model] = await ensureModelFiles(
    `Whisper ${config.whisper.model}`,
    [{ url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${config.whisper.model}.bin`, file: `ggml-${config.whisper.model}.bin` }],
    onProgress,
  );
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "escutaia-"));
  try {
    const wav = path.join(dir, "audio.wav");
    await run(config.ffmpeg, ["-nostdin", "-loglevel", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const out = path.join(dir, "out");
    await run(config.whisper.bin, [
      "-m", model,
      "-f", wav,
      "-l", config.whisper.language,
      "-t", String(config.whisper.threads),
      // Trechos curtos dão timestamps precisos para a busca pular ao ponto certo.
      "--max-len", "60",
      "--split-on-word",
      "-oj",
      "-of", out,
      "-np",
    ]);
    const json: WhisperJson = JSON.parse(await fsp.readFile(`${out}.json`, "utf8"));
    return json.transcription
      .map((s) => ({ start_ms: s.offsets.from, end_ms: s.offsets.to, text: clean(s.text) }))
      .filter((s) => s.text);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export function transcribe(audioPath: string, opts: { size?: WhisperSize; onProgress?: Progress } = {}): Promise<Segment[]> {
  if (!fs.existsSync(audioPath)) throw new Error(`arquivo de áudio não encontrado: ${audioPath}`);
  return config.whisper.engine === "sherpa"
    ? transcribeSherpa(audioPath, opts.size ?? (config.whisper.model as WhisperSize), opts.onProgress)
    : transcribeWhisperCpp(audioPath, opts.onProgress);
}

// Gravações do MediaRecorder (extensão/app) vêm sem duração nem índice, e o player
// não consegue pular para um trecho. Reempacotar (sem recodificar) resolve.
export async function fixWebm(file: string) {
  if (path.extname(file) !== ".webm") return;
  const tmp = `${file}.fixed.webm`;
  try {
    await run(config.ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", file, "-c", "copy", tmp]);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    console.warn(`[transcrição] não consegui reempacotar ${file}:`, (e as Error).message);
  }
}
