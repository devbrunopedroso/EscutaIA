// Modelos baixados na primeira vez (ficam em WHISPER_MODELS_DIR). Todos são arquivos
// avulsos (sem .tar.bz2), para funcionar igual no Windows, macOS e Linux.
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
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

// SHA-256 publicado pelo Hugging Face (arquivos LFS) no cabeçalho x-linked-etag do
// redirecionamento. Os do GitHub não têm: nesses, conferimos só o tamanho.
// undefined = não deu para perguntar (offline); null = arquivo sem sha256 publicado.
async function expectedSha256(url: string): Promise<string | null | undefined> {
  if (!url.startsWith(HF)) return null;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    const etag = res.headers.get("x-linked-etag")?.replace(/"/g, "") ?? "";
    return /^[0-9a-f]{64}$/.test(etag) ? etag : null;
  } catch {
    return undefined;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url: string, dest: string, name: string, onProgress?: Progress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const expected = await expectedSha256(url);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  let last = 0;
  const hash = crypto.createHash("sha256");
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      if (onProgress && Date.now() - last > 500) {
        last = Date.now();
        onProgress({ name, received, total });
      }
      cb(null, chunk);
    },
  });
  // Temporário único: dois downloads do mesmo arquivo nunca escrevem no mesmo lugar.
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as any), counter, fs.createWriteStream(tmp));
    if (total && received !== total) throw new Error(`download incompleto (${received} de ${total} bytes): ${url}`);
    const got = hash.digest("hex");
    if (expected && got !== expected) throw new Error(`download corrompido (sha256 não confere): ${url}`);
    await fsp.rename(tmp, dest);
    await fsp.writeFile(`${dest}.ok`, expected ?? got);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  onProgress?.({ name, received, total: total || received });
}

// Arquivo baixado por versões antigas (sem marcador .ok): confere uma vez com o
// sha256 do Hugging Face; se não bater (ex.: download corrompido), apaga para baixar de novo.
async function verifyLegacy(url: string, dest: string): Promise<boolean> {
  const expected = await expectedSha256(url);
  if (expected === undefined) return true; // offline: usa como está e confere na próxima vez
  if (expected === null) {
    // Sem sha256 publicado (GitHub, arquivos pequenos): aceita, como antes.
    await fsp.writeFile(`${dest}.ok`, "");
    return true;
  }
  const got = await sha256File(dest);
  if (got === expected) {
    await fsp.writeFile(`${dest}.ok`, expected);
    return true;
  }
  console.warn(`[modelos] ${path.basename(dest)} corrompido (sha256 ${got.slice(0, 12)}…, esperado ${expected.slice(0, 12)}…); baixando de novo`);
  await fsp.rm(dest, { force: true });
  return false;
}

// Um download por arquivo, mesmo se "prepare" e uma transcrição pedirem ao mesmo tempo.
const inflight = new Map<string, Promise<void>>();

async function ensureFile(url: string, dest: string, name: string, onProgress?: Progress) {
  if (fs.existsSync(dest) && (fs.existsSync(`${dest}.ok`) || (await verifyLegacy(url, dest)))) return;
  let p = inflight.get(dest);
  if (!p) {
    console.log(`[modelos] baixando ${url}`);
    p = download(url, dest, name, onProgress).finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  await p;
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
    await ensureFile(f.url, dest, name, onProgress);
    out.push(dest);
  }
  return out;
}
