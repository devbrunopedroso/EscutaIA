import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, desktop, fmtDate, fmtTime, STATUS_LABEL, type MeetingSummary, type Paged } from "../api";
import { useExtension } from "../extension";

export function Meetings() {
  const [data, setData] = useState<Paged<MeetingSummary> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const browserExtension = useExtension();
  // No app, a extensão não é visível daqui: conta as extensões conectadas.
  const [pairedCount, setPairedCount] = useState<number | null>(null);
  useEffect(() => {
    if (desktop) api<unknown[]>("/api/local/clients").then((l) => setPairedCount(l.length)).catch(() => {});
  }, []);
  const extension = desktop ? pairedCount !== 0 : browserExtension;

  const load = useCallback(() => api<Paged<MeetingSummary>>("/api/meetings").then(setData).catch((e) => setError(e.message)), []);

  useEffect(() => {
    load();
  }, [load]);

  // Atualiza sozinho enquanto houver reunião sendo processada.
  const pending = data?.results.some((m) => !["ready", "failed"].includes(m.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [pending, load]);

  async function upload(file: File) {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("title", file.name.replace(/\.[^.]+$/, ""));
      form.append("file", file);
      await api("/api/meetings", { method: "POST", body: form });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h2>Minhas reuniões</h2>
        <label className="button">
          {uploading ? "Enviando…" : "Enviar gravação"}
          <input
            type="file"
            accept="audio/*,video/*"
            hidden
            disabled={uploading}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!extension && (
        <Link to="/instalar" className="card banner">
          <strong>Grave suas reuniões direto do navegador</strong>
          <span className="muted small">Instale a extensão do Chrome. Leva 1 minuto →</span>
        </Link>
      )}
      {data?.results.length === 0 && (
        <div className="card muted">
          Nenhuma reunião ainda. Grave uma com a extensão do Chrome ou envie um arquivo de áudio/vídeo.
        </div>
      )}
      {data?.results.map((m) => (
        <Link to={`/meetings/${m.id}`} key={m.id} className="card meeting-row">
          <div>
            <strong>{m.title}</strong>
            <div className="muted small">
              {fmtDate(m.created_at)}
              {m.duration_ms ? ` · ${fmtTime(m.duration_ms)}` : ""}
              {m.platform ? ` · ${m.platform}` : ""}
            </div>
          </div>
          <span className={`badge ${m.status}`}>{STATUS_LABEL[m.status]}</span>
        </Link>
      ))}
    </div>
  );
}
