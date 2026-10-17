import { useEffect, useState } from "react";
import { api, getToken } from "../api";
import { connectExtension, isChromium, useExtension } from "../extension";
import { DesktopDownloads } from "../DesktopDownloads";
import { LocalExtensions } from "../LocalExtensions";
import { desktop } from "../api";

interface PublicConfig {
  extensionStoreUrl: string | null;
  extensionVersion: string | null;
}

export function ExtensionPage() {
  if (desktop) return <LocalExtensions />;
  return <ServerInstallPage />;
}

function ServerInstallPage() {
  const installed = useExtension();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "failed">("idle");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<PublicConfig>("/api/config").then(setCfg).catch(() => setCfg({ extensionStoreUrl: null, extensionVersion: null }));
  }, []);

  async function connect() {
    setStatus("connecting");
    setStatus((await connectExtension(getToken() ?? "")) ? "connected" : "failed");
  }

  const outdated = installed && cfg?.extensionVersion && installed !== cfg.extensionVersion;

  return (
    <div className="stack narrow">
      <h2>Instalar</h2>
      <DesktopDownloads />
      <h3>Extensão do Chrome</h3>
      <p className="muted">
        A extensão grava o áudio da reunião (Google Meet, Zoom e Teams no navegador) e envia para o EscutaIA. Funciona
        no Chrome, Edge e Brave, no Windows, Mac e Linux.
      </p>

      {!isChromium() && (
        <div className="card error">Abra esta página no Google Chrome (ou Edge/Brave) para instalar a extensão.</div>
      )}

      {installed ? (
        <div className="card stack">
          <strong>✓ Extensão instalada (versão {installed})</strong>
          {outdated && (
            <p className="muted small">
              Há uma versão nova ({cfg!.extensionVersion}). Baixe de novo, substitua a pasta e clique em ↻ na página de
              extensões.
            </p>
          )}
          {status === "connected" ? (
            <p>
              <strong>Pronto! A extensão está conectada à sua conta.</strong> Abra uma reunião e clique no ícone do
              EscutaIA → <em>Gravar esta aba</em>.
            </p>
          ) : (
            <>
              <p>Falta só conectar a extensão à sua conta:</p>
              <button className="big" onClick={connect} disabled={status === "connecting"}>
                {status === "connecting" ? "Conectando…" : "Conectar extensão"}
              </button>
              {status === "failed" && (
                <p className="error small">Não consegui conectar. Recarregue esta página (F5) e tente de novo.</p>
              )}
            </>
          )}
        </div>
      ) : cfg?.extensionStoreUrl ? (
        <div className="card stack">
          <a className="button big" href={cfg.extensionStoreUrl} target="_blank" rel="noreferrer">
            Adicionar ao Chrome
          </a>
          <p className="muted small">Depois de instalar, volte aqui e recarregue a página para conectar sua conta.</p>
        </div>
      ) : (
        <div className="card stack">
          <a className="button big" href="/api/extension.zip" download>
            ⬇ Baixar extensão
          </a>
          <p className="muted small">
            A extensão ainda não está na Chrome Web Store, então a instalação é manual. É só uma vez e leva 1 minuto:
          </p>
          <ol className="steps">
            <li>
              <strong>Descompacte</strong> o arquivo <code>escutaia-extension.zip</code> (duplo clique). Vai aparecer a
              pasta <code>escutaia-extension</code>. Guarde-a num lugar fixo (ex.: Documentos), porque o Chrome usa a
              pasta direto.
            </li>
            <li>
              Abra uma nova aba e vá para{" "}
              <button
                className="link inline"
                onClick={() => {
                  navigator.clipboard.writeText("chrome://extensions");
                  setCopied(true);
                }}
              >
                <code>chrome://extensions</code> {copied ? "✓ copiado" : "(copiar)"}
              </button>
              . Por segurança, o navegador não deixa um site abrir esse endereço, então cole na barra.
            </li>
            <li>
              Ative o <strong>Modo do desenvolvedor</strong> (chave no canto superior direito).
            </li>
            <li>
              Clique em <strong>Carregar sem compactação</strong> e escolha a pasta <code>escutaia-extension</code>.
            </li>
            <li>
              Fixe o ícone: clique no quebra-cabeça 🧩 da barra do Chrome e no alfinete ao lado de{" "}
              <em>EscutaIA Recorder</em>.
            </li>
            <li>
              <strong>Volte para esta página e recarregue (F5)</strong>. Vai aparecer o botão “Conectar extensão”.
            </li>
          </ol>
          <details>
            <summary className="small">Linux: instalar pelo terminal</summary>
            <pre className="small">{`cd ~ && curl -o escutaia-extension.zip ${location.origin}/api/extension.zip
unzip -o escutaia-extension.zip
# depois siga os passos 2 a 6 acima escolhendo ~/escutaia-extension`}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
