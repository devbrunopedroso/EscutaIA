import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { pool } from "./db.ts";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const TOKEN_TTL_S = 60 * 60 * 24 * 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split("$");
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string) => crypto.createHmac("sha256", config.jwtSecret).update(data).digest("base64url");

export function issueToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_S }));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function verifyToken(token: string): string | null {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) return null;
  const expected = sign(`${head}.${body}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
  return payload.sub;
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

// ---------------- modo local (app desktop) ----------------
// Um único usuário: a pessoa do computador. Acessam a API a janela do app (token do app)
// e extensões que a pessoa aprovou numa janela do app (token por extensão, salvo como hash).
let localUserId: string | null = null;

export async function ensureLocalUser(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash) VALUES ('local@meetnotes', $1, 'local')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [config.localUserName],
  );
  return (localUserId = rows[0].id);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const sameSecret = (a: string, b: string) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function localUserFor(token: string): Promise<string | null> {
  if (config.localToken && sameSecret(token, config.localToken)) return localUserId;
  const { rows } = await pool.query(
    "UPDATE local_clients SET last_seen_at = now() WHERE token_hash = $1 RETURNING id",
    [sha256(token)],
  );
  return rows[0] ? localUserId : null;
}

export async function createLocalClient(name: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO local_clients (name, token_hash) VALUES ($1, $2)", [name.slice(0, 120), sha256(token)]);
  return token;
}

// Aceita `Authorization: Bearer` e, para <audio src>, `?token=`.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { token?: string })?.token;
  const userId = !token ? null : config.local ? await localUserFor(token) : verifyToken(token);
  if (!userId) return reply.code(401).send({ error: "não autenticado" });
  req.userId = userId;
}
