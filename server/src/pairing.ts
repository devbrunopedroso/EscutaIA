// Pareamento da extensão com o app local. O pedido aparece numa janela do próprio app
// (processo principal do Electron), então um site qualquer não consegue se conectar
// sem a pessoa ver e aprovar.
import crypto from "node:crypto";

// Canal com o app: o servidor roda como processo filho do Electron (Node.js embutido),
// com IPC do Node (process.send). Sem o app (Docker, testes), não há canal.
const send = process.send?.bind(process);
const waiting = new Map<string, (allow: boolean) => void>();
process.on("message", (data: any) => {
  if (data?.type === "pair-reply") waiting.get(data.id)?.(!!data.allow);
});

// Se o app fechar (ou travar), o servidor não fica órfão rodando em segundo plano.
if (send) process.on("disconnect", () => process.exit(0));

let busy = false;

export async function askUserToPair(name: string): Promise<boolean> {
  if (!send) return process.env.PAIR_AUTO_ALLOW === "1"; // testes sem o app
  if (busy) return false; // um pedido por vez: evita enxurrada de janelas
  busy = true;
  try {
    const id = crypto.randomUUID();
    const answer = new Promise<boolean>((resolve) => {
      waiting.set(id, resolve);
      setTimeout(() => resolve(false), 120_000);
    });
    send({ type: "pair-request", id, name });
    return await answer;
  } finally {
    busy = false;
  }
}

// Avisos para o app (ex.: reunião pronta → notificação).
export function notifyApp(msg: Record<string, unknown>) {
  send?.(msg);
}
