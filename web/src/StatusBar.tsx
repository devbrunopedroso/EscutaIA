import { useEffect, useState } from "react";
import { api } from "./api";

interface Status {
  local: boolean;
  download: { name: string; received: number; total: number } | null;
  job: { id: string; title: string; stage: string } | null;
  queued: number;
}

// O que o app está fazendo agora: baixando modelos (1ª vez) ou processando uma reunião.
export function StatusBar() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<Status>("/api/status").then((v) => alive && setS(v)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!s || (!s.download && !s.job && !s.queued)) return null;
  const pct = s.download?.total ? Math.round((s.download.received / s.download.total) * 100) : null;
  return (
    <div className="statusbar">
      {s.download && (
        <span>
          ⬇ Baixando {s.download.name}
          {pct !== null && ` · ${pct}%`} (só na primeira vez)
          {pct !== null && <progress max={100} value={pct} />}
        </span>
      )}
      {s.job && (
        <span>
          ⚙ {s.job.stage}: “{s.job.title}”
        </span>
      )}
      {s.queued > 0 && <span className="muted">{s.queued} na fila</span>}
    </div>
  );
}
