// Modelos baixados na primeira vez (ficam em WHISPER_MODELS_DIR). Todos são arquivos
// avulsos (sem .tar.bz2), para funcionar igual no Windows, macOS e Linux.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.ts";

const HF = "https://huggingface.co";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export type WhisperSize = "base" | "small" | "turbo";
export const WHISPER_SIZES: Record<WhisperSize, { label: string; mb: number }> = {
  base: { label: "Rápido (qualidade básica)", mb: 151 },
  small: { label: "Equilibrado (recomendado)", mb: 357 },
  turbo: { label: "Melhor qualidade (mais lento)", mb: 987 },
};

const whisperFiles = (size: WhisperSize) =>
  ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"].map((f) => ({
    url: `${HF}/csukuangfj/sherpa-onnx-whisper-${size}/resolve/main/${size}-${f}`,
    file: `sherpa-whisper-${size}/${size}-${f}`,
  }));

export const MODEL_SETS = {
  whisper: (size: WhisperSize) => whisperFiles(size),
  vad: () => [{ url: `${GH}/asr-models/silero_vad.onnx`, file: "silero_vad.onnx" }],
  diarization: () => [
    { url: `${HF}/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`, file: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx" },
    { url: `${GH}/speaker-recongition-models/nemo_en_titanet_small.onnx`, file: "nemo_en_titanet_small.onnx" },
  ],
};

export type Progress = (p: { name: string; received: number; total: number }) => void;

async function download(url: string, dest: string, name: string, onProgress?: Progress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress && Date.now() - last > 500) {
        last = Date.now();
        onProgress({ name, received, total });
      }
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as any), counter, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  onProgress?.({ name, received, total: total || received });
}

// Baixa o que faltar e devolve os caminhos locais na mesma ordem.
export async function ensureModelFiles(
  name: string,
  files: { url: string; file: string }[],
  onProgress?: Progress,
): Promise<string[]> {
  const out = [];
  for (const f of files) {
    const dest = path.join(config.whisper.modelsDir, f.file);
    if (!fs.existsSync(dest)) {
      console.log(`[modelos] baixando ${f.url}`);
      await download(f.url, dest, name, onProgress);
    }
    out.push(dest);
  }
  return out;
}
