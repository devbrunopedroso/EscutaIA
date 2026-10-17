// Worker como processo separado (imagem Docker). No app local, o worker roda dentro
// do processo do servidor (index.ts).
import { migrate, waitForDb } from "./db.ts";
import { startWorker } from "./worker.ts";

await waitForDb();
await migrate();
await startWorker();
