import fs from "node:fs/promises";
import pg from "pg";
import { config } from "./config.ts";

// Mesma interface do `pg` nos dois modos:
//  - servidor (Docker): Postgres de verdade, via pg.Pool;
//  - app local: PGlite (Postgres em WASM, dentro do processo), sem nada para instalar.
export interface QueryResult {
  rows: any[];
  rowCount: number | null;
}
export interface Client {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  release(): void;
}
export interface Pool {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<Client>;
  end(): Promise<void>;
}

// O PGlite tem uma conexão só. A trava garante que uma transação aberta (BEGIN…COMMIT)
// não receba consultas de outra parte do app (API e worker) no meio.
function createPglitePool(dataDir: string): Pool {
  let dbPromise: Promise<any> | null = null;
  const db = () =>
    (dbPromise ??= (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      const { unaccent } = await import("@electric-sql/pglite/contrib/unaccent");
      await fs.mkdir(dataDir, { recursive: true });
      return PGlite.create(dataDir, { extensions: { unaccent } });
    })());

  let tail: Promise<void> = Promise.resolve();
  const lock = () => {
    let release!: () => void;
    const prev = tail;
    tail = new Promise<void>((r) => (release = r));
    return prev.then(() => release);
  };

  const run = async (text: string, params?: unknown[]): Promise<QueryResult> => {
    const d = await db();
    if (!params?.length && text.includes(";")) {
      // Vários comandos (migração): exec não aceita parâmetros.
      await d.exec(text);
      return { rows: [], rowCount: null };
    }
    const r = await d.query(text, params ?? []);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };

  return {
    async query(text, params) {
      const release = await lock();
      try {
        return await run(text, params);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query: run, release };
    },
    async end() {
      if (dbPromise) await (await dbPromise).close();
    },
  };
}

export const pool: Pool = config.pgliteDir
  ? createPglitePool(config.pgliteDir)
  : (new pg.Pool({ connectionString: config.databaseUrl }) as unknown as Pool);

export async function migrate(): Promise<void> {
  const sql = await fs.readFile(config.schemaPath, "utf8");
  // Lock evita que API e worker rodem a migração ao mesmo tempo (no PGlite é no-op).
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}

export async function waitForDb(tries = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
