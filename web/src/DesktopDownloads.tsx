import { useEffect, useState } from "react";
import { api } from "./api";

interface Installer {
  file: string;
  version: string;
  os: "mac" | "win" | "linux";
  arch: "arm64" | "x64";
  format: "dmg" | "exe" | "AppImage" | "deb";
  size: number;
  url: string;
}

const OS_NAME = { mac: "macOS", win: "Windows", linux: "Linux" } as const;
const ARCH_NAME = { arm64: "ARM (Apple M1/M2…, Snapdragon)", x64: "Intel/AMD (x64)" } as const;

// Melhor palpite do sistema do visitante (a arquitetura nem sempre é exposta pelo navegador).
function detect(): { os: Installer["os"] | null; arch: Installer["arch"] } {
  const ua = navigator.userAgent;
  const os = /Mac/i.test(ua) ? "mac" : /Win/i.test(ua) ? "win" : /Linux/i.test(ua) ? "linux" : null;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  // Macs novos são todos Apple Silicon; o navegador costuma se declarar "Intel" mesmo assim.
  const arch = os === "mac" || /arm|aarch64/i.test(ua) || uaData?.platform === "arm" ? "arm64" : "x64";
  return { os, arch };
}

export function DesktopDownloads() {
  const [list, setList] = useState<Installer[] | null>(null);
  useEffect(() => {
    api<Installer[]>("/api/downloads").then(setList).catch(() => setList([]));
  }, []);
  if (!list) return null;

  const { os, arch } = detect();
  const mine = list.filter((i) => i.os === os);
  const best = mine.find((i) => i.arch === arch && i.format !== "deb") ?? mine[0];
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

  return (
    <section className="card stack">
      <h3>App para computador</h3>
      <p className="muted">
        Grava reuniões de <strong>qualquer programa</strong>: Zoom, Teams e Meet no app, WhatsApp, Slack… Captura o som do
        computador e o seu microfone e envia para cá. Fica no canto da tela (bandeja) e para sozinho no silêncio.
      </p>
      {!list.length ? (
        <p className="muted small">Os instaladores ainda não foram publicados neste servidor (veja o README: “App desktop”).</p>
      ) : (
        <>
          {best && (
            <a className="button big" href={best.url} download>
              ⬇ Baixar para {OS_NAME[best.os]} · {ARCH_NAME[best.arch].split(" ")[0]} ({mb(best.size)})
            </a>
          )}
          <details>
            <summary className="small">Outros sistemas e formatos</summary>
            <ul className="downloads">
              {list.map((i) => (
                <li key={i.file}>
                  <a href={i.url} download>
                    {OS_NAME[i.os]} · {ARCH_NAME[i.arch]} · .{i.format}
                  </a>{" "}
                  <span className="muted small">{mb(i.size)}</span>
                </li>
              ))}
            </ul>
          </details>
          {best?.os === "mac" && (
            <p className="muted small">
              <strong>Mac:</strong> abra o .dmg e arraste o EscutaIA para Aplicativos. Na 1ª vez, clique com o botão direito no
              app → <em>Abrir</em> (o app ainda não é assinado pela Apple). Ao gravar, permita “Gravar áudio do sistema” e o
              microfone.
            </p>
          )}
          {best?.os === "win" && (
            <p className="muted small">
              <strong>Windows:</strong> se aparecer “O Windows protegeu o computador”, clique em <em>Mais informações → Executar
              assim mesmo</em> (o app ainda não é assinado).
            </p>
          )}
          {best?.os === "linux" && (
            <p className="muted small">
              <strong>Linux:</strong> .deb para Debian/Ubuntu (<code>sudo apt install ./arquivo.deb</code>) ou AppImage para
              qualquer distribuição (<code>chmod +x</code> e abrir).
            </p>
          )}
          <p className="muted small">Depois de instalar, entre com o endereço deste servidor: <code>{location.origin}</code></p>
        </>
      )}
    </section>
  );
}
