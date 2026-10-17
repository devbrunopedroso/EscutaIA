import { useEffect, useState } from "react";
import { api, fmtDate } from "./api";

interface Client {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

// Página do site para baixar a extensão (definida no build: VITE_SITE_URL).
const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || "https://escutaia.devontravel.com.br/";

// Dentro do app: extensões do Chrome conectadas a este computador.
export function LocalExtensions() {
  const [list, setList] = useState<Client[] | null>(null);
  const load = () => api<Client[]>("/api/local/clients").then(setList);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="stack narrow">
      <h2>Extensão do Chrome</h2>
      <p className="muted">
        A extensão grava reuniões do Google Meet, Teams e Zoom <strong>no navegador</strong> e envia para este app, que
        transcreve tudo aqui no seu computador. Para reuniões em apps (Zoom, Teams, WhatsApp…), use o botão{" "}
        <strong>● Gravar</strong> no topo.
      </p>
      <section className="card stack">
        <h3>Como conectar</h3>
        <ol className="steps">
          <li>
            Instale a extensão “EscutaIA — Gravador de reuniões”
            {SITE_URL ? (
              <>
                {" "}
                pela{" "}
                <a href={SITE_URL} target="_blank" rel="noreferrer">
                  página de download
                </a>
              </>
            ) : (
              " (pasta extension/ do projeto, em chrome://extensions → Carregar sem compactação)"
            )}
            .
          </li>
          <li>Com este app aberto, clique no ícone da extensão → <strong>Conectar ao app</strong>.</li>
          <li>
            Uma janela do EscutaIA pergunta se você permite: clique em <strong>Permitir</strong>.
          </li>
        </ol>
      </section>
      <section className="card stack">
        <h3>Extensões conectadas</h3>
        {!list?.length && <p className="muted">Nenhuma ainda.</p>}
        {list?.map((c) => (
          <div key={c.id} className="row between">
            <div>
              <strong>{c.name}</strong>
              <div className="muted small">
                conectada em {fmtDate(c.created_at)}
                {c.last_seen_at && ` · último uso ${fmtDate(c.last_seen_at)}`}
              </div>
            </div>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm("Desconectar esta extensão? Ela vai precisar pedir permissão de novo.")) return;
                await api(`/api/local/clients/${c.id}`, { method: "DELETE" });
                load();
              }}
            >
              Desconectar
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
