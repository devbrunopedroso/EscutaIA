// Thread de cálculo: transcrição e identificação de quem fala são chamadas nativas
// síncronas e demoradas. Rodando aqui, a API continua respondendo (a extensão não
// acha que o app travou) enquanto uma reunião é processada.
import { parentPort } from "node:worker_threads";
import { labelSpeakers } from "./diarize.ts";
import { ensureDiarizationModels } from "./diarize.ts";
import { ensureModelFiles, MODEL_SETS, type WhisperSize } from "./models.ts";
import { fixWebm, transcribe } from "./transcribe.ts";

const port = parentPort!;
port.on("message", async ({ id, op, args }) => {
  const onProgress = (p: { name: string; received: number; total: number }) => port.postMessage({ type: "progress", ...p });
  try {
    let result: unknown;
    if (op === "transcribe") {
      await fixWebm(args.audioPath);
      result = await transcribe(args.audioPath, { size: args.size, onProgress });
    } else if (op === "label") {
      result = await labelSpeakers(args.audioPath, args.segments, { ...args.opts, onProgress });
    } else if (op === "prepare") {
      // Baixa tudo de antemão (primeira abertura do app), para a 1ª reunião não esperar.
      await ensureModelFiles(`Whisper ${args.size}`, MODEL_SETS.whisper(args.size as WhisperSize), onProgress);
      await ensureModelFiles("Detector de fala", MODEL_SETS.vad(), onProgress);
      if (args.diarization) await ensureDiarizationModels(onProgress);
    } else throw new Error(`operação desconhecida: ${op}`);
    port.postMessage({ type: "done", id, result });
  } catch (e) {
    port.postMessage({ type: "done", id, error: (e as Error).message });
  }
});
