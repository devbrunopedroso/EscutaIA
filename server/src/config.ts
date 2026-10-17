import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));

// Dois modos:
//  - servidor (Docker, multiusuário): Postgres, whisper.cpp, login por conta;
//  - app local (ESCUTAIA_LOCAL=1, iniciado pelo app desktop): PGlite, Whisper do
//    sherpa-onnx, um único usuário (a pessoa do computador), API só em 127.0.0.1.
const local = env.ESCUTAIA_LOCAL === "1";

export const config = {
  local,
  host: env.HOST ?? (local ? "127.0.0.1" : "0.0.0.0"),
  port: Number(env.PORT ?? (local ? 47821 : 3000)),
  databaseUrl: env.DATABASE_URL ?? "postgres://meetnotes:meetnotes@localhost:5432/meetnotes",
  // Pasta do PGlite (Postgres embutido). Definida no modo local.
  pgliteDir: env.PGLITE_DIR ? path.resolve(env.PGLITE_DIR) : null,
  schemaPath: env.SCHEMA_PATH ?? path.join(here, "schema.sql"),
  // No modo local, o próprio token do app serve de segredo (criptografia do token do Claude).
  jwtSecret: env.JWT_SECRET ?? env.LOCAL_TOKEN ?? "dev-secret-troque-em-producao",
  // Modo local: token gerado pelo app; quem o tem (a janela do app e a extensão pareada) acessa a API.
  localToken: env.LOCAL_TOKEN ?? null,
  localUserName: env.LOCAL_USER_NAME ?? os.userInfo().username,
  dataDir: path.resolve(env.DATA_DIR ?? "./data"),
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : null,
  extensionDir: path.resolve(env.EXTENSION_DIR ?? "../extension"),
  // Instaladores do app desktop (saída do electron-builder) oferecidos na página "Instalar".
  downloadsDir: path.resolve(env.DOWNLOADS_DIR ?? "../desktop/dist"),
  // Endereço público (ex.: https://escutaia.suaempresa.com). Sem ele, usa o Host da requisição.
  publicUrl: env.PUBLIC_URL?.replace(/\/+$/, "") || null,
  // Link da extensão na Chrome Web Store, depois de publicada: o site mostra "Adicionar ao Chrome".
  extensionStoreUrl: env.EXTENSION_STORE_URL || null,
  ffmpeg: env.FFMPEG_PATH ?? "ffmpeg",
  whisper: {
    // "whispercpp" (binário whisper-cli, Docker) ou "sherpa" (embutido, app local).
    engine: env.TRANSCRIBER ?? (local ? "sherpa" : "whispercpp"),
    bin: env.WHISPER_BIN ?? "whisper-cli",
    modelsDir: path.resolve(env.WHISPER_MODELS_DIR ?? "./models"),
    model: env.WHISPER_MODEL ?? "small",
    language: env.WHISPER_LANG ?? "pt",
    threads: Number(env.WHISPER_THREADS ?? Math.max(2, Math.min(8, os.cpus().length - 2))),
  },
  diarization: {
    enabled: (env.DIARIZATION ?? "on") !== "off",
    // Menor = separa mais vozes; maior = junta mais. 0.5 funcionou bem nos testes.
    threshold: Number(env.DIARIZATION_THRESHOLD ?? 0.5),
  },
  claude: {
    model: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    // Caminho do Claude Code. Apps abertos pelo Finder/Menu Iniciar não herdam o PATH do terminal.
    bin: env.CLAUDE_BIN ?? "claude",
    // As credenciais vêm da tela de Configurações (por usuário) ou do .env; ver credentials.ts.
  },
};

if (!local && config.jwtSecret === "dev-secret-troque-em-producao" && env.NODE_ENV === "production") {
  throw new Error("Defina JWT_SECRET em produção");
}
if (local && !config.localToken) throw new Error("Modo local: defina LOCAL_TOKEN");
