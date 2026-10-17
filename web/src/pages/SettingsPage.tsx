import { useEffect, useState } from "react";
import { api, fmtDate } from "../api";
import { TranscriptionSettings } from "../TranscriptionSettings";

interface ClaudeStatus {
  configured: boolean;
  source: "user" | "server" | "cli" | null;
  kind: "oauth" | "api" | "cli" | null;
  hint: string | null;
  updatedAt: string | null;
  pendingSummaries: number;
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="link"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "✓ copiado" : "copiar"}
      </button>
    </div>
  );
}

const isWindows = navigator.userAgent.includes("Windows");

export function SettingsPage() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [tab, setTab] = useState<"oauth" | "api">("oauth");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | "pending" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api<ClaudeStatus>("/api/settings/claude").then(setStatus);
  useEffect(() => {
    load();
  }, []);

  async function run(kind: typeof busy, fn: () => Promise<string>) {
    setBusy(kind);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      load();
    }
  }

  const save = () =>
    run("save", async () => {
      await api("/api/settings/claude", { method: "PUT", body: JSON.stringify({ token }) });
      setToken("");
      return "Token salvo e testado com sucesso! ✓";
    });

  const summarizePending = () =>
    run("pending", async () => {
      const { queued } = await api<{ queued: number }>("/api/meetings/summarize-pending", { method: "POST" });
      return `Gerando ${queued} resumo(s) em segundo plano. Eles aparecem nas reuniões em alguns minutos.`;
    });

  const looksLike = token.trim().startsWith("sk-ant-oat") ? "oauth" : token.trim().startsWith("sk-ant-api") ? "api" : null;

  return (
    <div className="stack narrow">
      <h2>Configurações</h2>
      <TranscriptionSettings />

      <section className="card stack">
        <div className="row between">
          <h3>Claude (resumos e perguntas)</h3>
          {status && (
            <span className={`badge ${status.configured ? "ready" : "failed"}`}>
              {status.configured ? "Configurado" : "Não configurado"}
            </span>
          )}
        </div>

        {status?.source === "user" && (
          <div className="stack">
            <p>
              Usando o seu {status.kind === "api" ? "chave de API" : "token da assinatura"}{" "}
              <code>sk-ant-…{status.hint}</code>, salvo em {fmtDate(status.updatedAt!)}.
            </p>
            <div className="row">
              <button
                onClick={() =>
                  run("test", async () => {
                    await api("/api/settings/claude/test", { method: "POST" });
                    return "Funcionando! ✓";
                  })
                }
                disabled={!!busy}
              >
                {busy === "test" ? "Testando…" : "Testar"}
              </button>
              <button
                className="danger"
                onClick={() =>
                  confirm("Remover o token do Claude?") &&
                  run("remove", async () => {
                    await api("/api/settings/claude", { method: "DELETE" });
                    return "Token removido.";
                  })
                }
                disabled={!!busy}
              >
                Remover
              </button>
            </div>
          </div>
        )}
        {status?.source === "server" && (
          <p className="muted">
            O servidor já tem um Claude configurado para todos. Você pode usar o seu próprio token abaixo, se quiser.
          </p>
        )}
        {status?.source === "cli" && (
          <p className="muted">
            Usando o login do <strong>Claude Code</strong> deste computador. Se der erro, faça login nele (<code>claude</code>{" "}
            no terminal) ou cole um token abaixo.
          </p>
        )}

        {!!status?.configured && status.pendingSummaries > 0 && (
          <div className="card banner">
            <strong>{status.pendingSummaries} reunião(ões) sem resumo</strong>
            <button onClick={summarizePending} disabled={!!busy}>
              {busy === "pending" ? "Enviando…" : "Gerar resumos agora"}
            </button>
          </div>
        )}

        {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
      </section>

      <section className="card stack">
        <h3>{status?.source === "user" ? "Trocar o token" : "Conectar o Claude"}</h3>
        <div className="tabs">
          <button className={tab === "oauth" ? "active" : ""} onClick={() => setTab("oauth")}>
            Minha assinatura Claude <span className="muted small">(Pro/Max)</span>
          </button>
          <button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>
            Chave de API <span className="muted small">(pago por uso)</span>
          </button>
        </div>

        {tab === "oauth" ? (
          <ol className="steps">
            <li>
              <strong>Instale o Claude Code</strong> no seu computador (se ainda não tiver). Abra o{" "}
              {isWindows ? "PowerShell" : "Terminal"} e rode:
              <Copy
                text={
                  isWindows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash"
                }
              />
            </li>
            <li>
              <strong>Gere o token</strong> com:
              <Copy text="claude setup-token" />
              O navegador abre a página do Claude. Entre com a sua conta e clique em <em>Autorizar</em>.
            </li>
            <li>
              Volte ao terminal. Ele mostra um token longo que começa com <code>sk-ant-oat01-</code>.{" "}
              <strong>Copie o token inteiro</strong>, que é uma linha só.
            </li>
            <li>Cole aqui embaixo e clique em <strong>Salvar e testar</strong>.</li>
          </ol>
        ) : (
          <ol className="steps">
            <li>
              Acesse{" "}
              <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
                platform.claude.com → API keys
              </a>{" "}
              e entre com a sua conta.
            </li>
            <li>
              Clique em <strong>Create Key</strong>, dê um nome (ex.: EscutaIA) e copie a chave, que começa com{" "}
              <code>sk-ant-api03-</code>. Ela só aparece uma vez.
            </li>
            <li>
              Confira se há créditos em <em>Billing</em>. A API é cobrada por uso, normalmente centavos por reunião.
            </li>
            <li>Cole aqui embaixo e clique em <strong>Salvar e testar</strong>.</li>
          </ol>
        )}

        <div className="row">
          <input
            type="password"
            autoComplete="off"
            placeholder={tab === "oauth" ? "sk-ant-oat01-…" : "sk-ant-api03-…"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button onClick={save} disabled={!token.trim() || !!busy}>
            {busy === "save" ? "Testando…" : "Salvar e testar"}
          </button>
        </div>
        {token.trim() && !looksLike && (
          <p className="error small">O token deve começar com sk-ant-oat… (assinatura) ou sk-ant-api… (chave de API).</p>
        )}
        {looksLike && looksLike !== tab && (
          <p className="muted small">
            Isso é {looksLike === "oauth" ? "um token de assinatura" : "uma chave de API"}. Tudo bem, ele funciona assim
            mesmo.
          </p>
        )}

        <details className="small muted">
          <summary>Qual escolher? É seguro?</summary>
          <ul>
            <li>
              <strong>Assinatura:</strong> usa o seu plano Claude Pro/Max, sem custo extra, dentro dos limites do plano.
              O token vale cerca de 1 ano. É pessoal: cada pessoa deve usar o próprio.
            </li>
            <li>
              <strong>Chave de API:</strong> cobrada por uso na sua conta da API. É a indicada se uma empresa paga pelo
              uso de todos.
            </li>
            <li>
              O token fica <strong>criptografado</strong> no servidor e é usado só nas suas reuniões. Ele nunca mais é
              mostrado na tela; aparecem só os 4 últimos caracteres. Para revogar, clique em Remover aqui. Para uma
              chave de API, apague-a também no console.
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}
