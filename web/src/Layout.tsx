import { useState } from "react";
import { Link, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { desktop, setToken } from "./api";
import { StatusBar } from "./StatusBar";
import { RecordingBanner, RecordingControl } from "./RecordingControl";
import { useExtension } from "./extension";

export function Layout() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const extension = useExtension();

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Escuta<span className="ia">IA</span>
        </Link>
        <form
          className="searchbox"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <input
            type="search"
            placeholder="Buscar em títulos e transcrições…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        <RecordingControl />
        <Link to="/instalar" className="small">
          {desktop ? "Extensão" : extension ? "Instalar" : <span className="pill">Instalar</span>}
        </Link>
        <Link to="/configuracoes" className="small" title="Configurações">
          ⚙ Configurações
        </Link>
        {!desktop && (
          <button
            className="link"
            onClick={() => {
              setToken(null);
              navigate("/login");
            }}
          >
            Sair
          </button>
        )}
      </header>
      <RecordingBanner />
      <StatusBar />
      <main>
        <Outlet />
      </main>
      <footer className="credits">
        EscutaIA · Criado por <strong>DEVONTRAVEL</strong>
      </footer>
    </>
  );
}
