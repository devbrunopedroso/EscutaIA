// Credenciais do Claude por usuário, configuradas pela tela de Configurações.
// Guardadas criptografadas (AES-256-GCM) com chave derivada do JWT_SECRET.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { findClaudeBin } from "./ai.ts";
import { pool } from "./db.ts";

export type ClaudeCredentials =
  | { kind: "api"; key: string } // sk-ant-api...  -> API, cobrado por uso
  | { kind: "oauth"; token: string } // sk-ant-oat...  -> assinatura, via `claude -p`
  | { kind: "cli" }; // dev: login que já existe no Claude Code desta máquina

export class ClaudeNotConfigured extends Error {
  code = "claude_not_configured";
  constructor() {
    super("Claude não configurado. Vá em Configurações → Claude e cole o seu token.");
  }
}

const KEY = crypto.createHash("sha256").update(`${config.jwtSecret}:claude-credentials`).digest();

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function parseSecret(raw: string): ClaudeCredentials {
  const value = raw.trim().replace(/\s+/g, "");
  if (/^sk-ant-oat\d*-[\w-]{20,}$/.test(value)) return { kind: "oauth", token: value };
  if (/^sk-ant-api\d*-[\w-]{20,}$/.test(value)) return { kind: "api", key: value };
  throw new Error("Isso não parece um token do Claude. Ele começa com sk-ant-oat… (assinatura) ou sk-ant-api… (chave de API).");
}

const secretOf = (c: ClaudeCredentials) => (c.kind === "api" ? c.key : c.kind === "oauth" ? c.token : "");

export async function saveUserCredentials(userId: string, creds: ClaudeCredentials): Promise<void> {
  await pool.query(
    `UPDATE users SET claude_secret = $2, claude_kind = $3, claude_hint = $4, claude_updated_at = now() WHERE id = $1`,
    [userId, encrypt(secretOf(creds)), creds.kind, secretOf(creds).slice(-4)],
  );
}

export async function deleteUserCredentials(userId: string): Promise<void> {
  await pool.query(
    "UPDATE users SET claude_secret = NULL, claude_kind = NULL, claude_hint = NULL, claude_updated_at = NULL WHERE id = $1",
    [userId],
  );
}

function serverCredentials(): ClaudeCredentials | null {
  if (process.env.ANTHROPIC_API_KEY) return { kind: "api", key: process.env.ANTHROPIC_API_KEY };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "oauth", token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  // Fora de produção, e no app local quando o Claude Code está instalado, aproveita o
  // login do Claude Code da própria máquina.
  if (process.env.NODE_ENV !== "production") return { kind: "cli" };
  if (config.local && findClaudeBin()) return { kind: "cli" };
  return null;
}

// Ordem: token do usuário > configuração do servidor (.env) > login local (dev).
export async function credentialsFor(userId: string): Promise<ClaudeCredentials> {
  const { rows } = await pool.query("SELECT claude_secret, claude_kind FROM users WHERE id = $1", [userId]);
  const row = rows[0];
  if (row?.claude_secret) {
    try {
      const secret = decrypt(row.claude_secret);
      return row.claude_kind === "api" ? { kind: "api", key: secret } : { kind: "oauth", token: secret };
    } catch {
      // JWT_SECRET mudou: o token salvo não abre mais; cai para o servidor.
    }
  }
  const server = serverCredentials();
  if (!server) throw new ClaudeNotConfigured();
  return server;
}

export async function credentialsStatus(userId: string) {
  const { rows } = await pool.query("SELECT claude_kind, claude_hint, claude_updated_at FROM users WHERE id = $1", [userId]);
  const r = rows[0];
  if (r?.claude_kind) return { configured: true, source: "user", kind: r.claude_kind, hint: r.claude_hint, updatedAt: r.claude_updated_at };
  const server = serverCredentials();
  return { configured: !!server, source: server ? (server.kind === "cli" ? "cli" : "server") : null, kind: server?.kind ?? null, hint: null, updatedAt: null };
}
