import { Worker } from "node:worker_threads";

// Estado exibido na tela (GET /api/status): download de modelos em andamento.
export const downloads = { current: null as null | { name: string; received: number; total: number; at: number } };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  // No app empacotado o servidor é um bundle .mjs; COMPUTE_ENTRY aponta para o bundle da thread.
  const entry = process.env.COMPUTE_ENTRY ?? new URL("./compute.ts", import.meta.url);
  const w = new Worker(entry);
  w.on("message", (m) => {
    if (m.type === "progress") {
      downloads.current = m.received >= m.total && m.total > 0 ? null : { name: m.name, received: m.received, total: m.total, at: Date.now() };
      return;
    }
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.result);
  });
  const fail = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  };
  w.on("error", fail);
  w.on("exit", (code) => code && fail(new Error(`thread de cálculo saiu com ${code}`)));
  return (worker = w);
}

export function compute<T>(op: "transcribe" | "label" | "prepare", args: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  const w = getWorker();
  // Enquanto houver trabalho, a thread segura o processo (senão o worker do Docker
  // poderia encerrar no meio de uma transcrição); ociosa, não impede o processo de sair.
  w.ref();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, args });
  }).finally(() => {
    if (!pending.size) {
      downloads.current = null;
      worker?.unref();
    }
  });
}
