import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import type { ClaudeCredentials } from "./credentials.ts";

const INVALID = "Token do Claude inválido ou expirado. Gere outro em Configurações → Claude.";

async function viaApi(apiKey: string, system: string, prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  try {
    const stream = client.beta.messages.stream({
      model: config.claude.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("O Claude recusou o pedido");
    return msg.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new Error(INVALID);
    if (e instanceof Anthropic.RateLimitError) throw new Error("Limite de uso da API atingido. Tente mais tarde.");
    throw e;
  }
}

// Onde está o Claude Code. Procurado a cada uso (não só ao abrir o app), para
// funcionar logo depois de instalar. Apps abertos pelo Finder/Menu Iniciar não
// herdam o PATH do terminal, então também perguntamos ao shell de login.
let cached: { bin: string | null; at: number } | null = null;

export function findClaudeBin(): string | null {
  if (cached?.bin && fs.existsSync(cached.bin)) return cached.bin;
  if (cached && !cached.bin && Date.now() - cached.at < 30_000) return null;
  const bin = lookupClaudeBin();
  cached = { bin, at: Date.now() };
  return bin;
}

function lookupClaudeBin(): string | null {
  const home = os.homedir();
  const win = process.platform === "win32";
  const fixed = config.claude.bin && path.isAbsolute(config.claude.bin) ? [config.claude.bin] : [];
  const candidates = win
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA ?? "", "npm", "claude.cmd")]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        path.join(home, ".npm-global", "bin", "claude"),
        path.join(home, ".volta", "bin", "claude"),
        path.join(home, ".bun", "bin", "claude"),
      ];
  const found = [...fixed, ...candidates].find((p) => fs.existsSync(p));
  if (found) return found;
  try {
    const out = win
      ? execFileSync("where", ["claude"], { encoding: "utf8", timeout: 5000 })
      : execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude; whence -p claude 2>/dev/null; which claude"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    // "command -v" devolve o caminho ou, se for alias, "alias claude='/…/claude'".
    const paths = out.match(/(?:[A-Za-z]:)?[\\/][^\s'"=]*claude(?:\.exe|\.cmd)?/g) ?? [];
    return paths.map((p) => p.replace(/^~/, home)).find((p) => path.isAbsolute(p) && fs.existsSync(p)) ?? null;
  } catch {
    return null;
  }
}

const NO_CLI =
  process.platform === "win32"
    ? "o Claude Code não está instalado neste computador, e o token de assinatura (sk-ant-oat…) só funciona com ele. Instale no PowerShell com: irm https://claude.ai/install.ps1 | iex — e tente de novo. Ou use uma chave de API (sk-ant-api…), que não precisa do Claude Code."
    : "o Claude Code não está instalado neste computador, e o token de assinatura (sk-ant-oat…) só funciona com ele. Instale no Terminal com: curl -fsSL https://claude.ai/install.sh | bash — e tente de novo. Ou use uma chave de API (sk-ant-api…), que não precisa do Claude Code.";

// Assinatura (token sk-ant-oat…) ou login local: roda o Claude Code (`claude -p`).
function viaCli(oauthToken: string | null, system: string, prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // teria prioridade sobre o token
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  const bin = findClaudeBin();
  if (!bin) return Promise.reject(new Error(NO_CLI));
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ["-p", "--output-format", "text", "--system-prompt", system], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) =>
      reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? NO_CLI : `não consegui rodar o Claude Code (${bin}): ${e.message}`)),
    );
    proc.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      const detail = (err.trim() || out.trim()).slice(0, 500);
      if (/invalid|unauthori[sz]ed|401|expired|authenticat|log ?in/i.test(detail)) return reject(new Error(INVALID));
      reject(new Error(`claude -p saiu com ${code}: ${detail}`));
    });
    proc.stdin.end(prompt);
  });
}

export function complete(creds: ClaudeCredentials, system: string, prompt: string): Promise<string> {
  if (creds.kind === "api") return viaApi(creds.key, system, prompt);
  return viaCli(creds.kind === "oauth" ? creds.token : null, system, prompt);
}

export async function testCredentials(creds: ClaudeCredentials): Promise<void> {
  const answer = await complete(creds, "Responda exatamente com a palavra pedida.", "Responda apenas: ok");
  if (!answer) throw new Error("O Claude não respondeu");
}

export interface TranscriptSegment {
  start_ms: number;
  text: string;
  speaker?: string | null;
}

const ts = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export type Speakers = Record<string, string>;

// `speaker` nos segmentos é um rótulo ("me", "S1"...); o mapa traz os nomes exibidos.
export const formatTranscript = (segs: TranscriptSegment[], speakers: Speakers = {}) =>
  segs
    .map((s) => {
      const who = s.speaker ? (speakers[s.speaker] ?? s.speaker) : null;
      return `[${ts(s.start_ms)}]${who ? ` ${who}:` : ""} ${s.text}`;
    })
    .join("\n");

const SUMMARY_SYSTEM = `Você resume transcrições de reuniões em português do Brasil.
A transcrição foi gerada automaticamente e pode ter erros de reconhecimento; interprete pelo contexto.
Responda em Markdown com estas seções, omitindo as que não se aplicam:
## Resumo (3 a 5 frases)
## Pontos principais
## Decisões
## Próximos passos (com responsável e prazo quando citados)
## Perguntas em aberto
Cite o timestamp [hh:mm:ss] dos trechos mais importantes.
Quando a transcrição indicar quem fala, use esses nomes (inclusive como responsáveis dos próximos passos).
A identificação de falantes é automática e pode errar em trechos curtos.`;

export function summarize(
  creds: ClaudeCredentials,
  title: string,
  segs: TranscriptSegment[],
  speakers: Speakers = {},
): Promise<string> {
  const who = Object.values(speakers);
  const people = who.length ? `\nParticipantes identificados: ${who.join(", ")}` : "";
  return complete(creds, SUMMARY_SYSTEM, `Reunião: ${title}${people}\n\nTranscrição:\n${formatTranscript(segs, speakers)}`);
}

const ASK_SYSTEM = `Você responde perguntas sobre reuniões usando somente as transcrições fornecidas.
Responda em português do Brasil, de forma direta. Para cada afirmação, cite a reunião e o timestamp
no formato [Título @ hh:mm:ss]. Se a resposta não estiver nas transcrições, diga isso claramente.`;

export function ask(
  creds: ClaudeCredentials,
  question: string,
  meetings: { title: string; date: string; segments: TranscriptSegment[]; speakers?: Speakers }[],
) {
  const context = meetings
    .map((m) => `<reuniao titulo="${m.title.replace(/"/g, "'")}" data="${m.date}">\n${formatTranscript(m.segments, m.speakers)}\n</reuniao>`)
    .join("\n\n");
  return complete(creds, ASK_SYSTEM, `${context}\n\nPergunta: ${question}`);
}
