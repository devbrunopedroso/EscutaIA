import { spawn } from "node:child_process";
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

// Assinatura (token sk-ant-oat…) ou login local: roda o Claude Code (`claude -p`).
function viaCli(oauthToken: string | null, system: string, prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // teria prioridade sobre o token
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return new Promise((resolve, reject) => {
    const proc = spawn(config.claude.bin, ["-p", "--output-format", "text", "--system-prompt", system], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => reject(new Error(`não consegui rodar o Claude Code (\`claude\`): ${e.message}`)));
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
