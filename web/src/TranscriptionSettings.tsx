import { useEffect, useState } from "react";
import { api } from "./api";

interface Info {
  model: string;
  engine: string;
  options: { id: string; label: string; mb: number }[];
}

// App local: qual modelo do Whisper usar (baixado na 1ª vez).
export function TranscriptionSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api<Info>("/api/settings/transcription").then(setInfo);
  }, []);
  if (!info || info.engine !== "sherpa") return null;

  return (
    <section className="card stack">
      <h3>Transcrição</h3>
      <p className="muted small">Tudo roda no seu computador. Modelos maiores transcrevem melhor, mas demoram mais.</p>
      {info.options.map((o) => (
        <label key={o.id} className="radio">
          <input
            type="radio"
            name="whisper"
            checked={info.model === o.id}
            onChange={async () => {
              await api("/api/settings/transcription", { method: "PUT", body: JSON.stringify({ model: o.id }) });
              setInfo({ ...info, model: o.id });
              setMsg("Salvo. Se for a primeira vez com este modelo, ele está sendo baixado (veja a barra no topo).");
            }}
          />
          <span>
            <strong>{o.label}</strong> <span className="muted small">· {o.mb} MB</span>
          </span>
        </label>
      ))}
      {msg && <p className="success small">{msg}</p>}
    </section>
  );
}
