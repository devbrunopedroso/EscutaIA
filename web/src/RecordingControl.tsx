import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { desktop, type RecordingState } from "./api";

// Botão do topo (só dentro do app): Gravar → "● Gravando 12:03 ■ Parar" → Enviando… → Enviado.
export function RecordingControl() {
  const [s, setS] = useState<RecordingState | null>(null);
  useEffect(() => {
    if (!desktop) return;
    desktop.getRecordingState().then(setS);
    return desktop.onRecordingState(setS);
  }, []);
  if (!desktop) return null;

  if (s?.recording)
    return (
      <span className="rec-live" title="Gravando o som do computador e o seu microfone">
        <span className="rec-dot" /> Gravando <strong>{s.elapsed ?? "0:00"}</strong>
        <button className="rec-stop" onClick={() => desktop?.stopRecording()}>
          ■ Parar
        </button>
      </span>
    );
  if (s?.starting) return <span className="rec-live muted">Iniciando…</span>;
  if (s?.uploading) return <span className="rec-live muted">Enviando gravação…</span>;
  return (
    <button className="rec" onClick={() => desktop?.startRecording()} title="Gravar o som do computador (Zoom, Teams, WhatsApp…)">
      ● Gravar
    </button>
  );
}

// Faixa abaixo do topo: o que está acontecendo + onde ver a gravação na barra de menus.
export function RecordingBanner() {
  const [s, setS] = useState<RecordingState | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    desktop.getRecordingState().then(setS);
    return desktop.onRecordingState(setS);
  }, []);
  if (!desktop || !s) return null;
  const mac = desktop.platform === "darwin";

  if (s.recording)
    return (
      <div className="rec-banner live">
        <strong>🔴 Gravando “{s.title}”.</strong> Pode minimizar o app e voltar à sua reunião.{" "}
        {mac
          ? "O tempo aparece na barra de menus (canto superior direito, ao lado do relógio): clique no ícone vermelho do EscutaIA para parar."
          : "O ícone vermelho do EscutaIA na bandeja do sistema (perto do relógio) mostra que está gravando: clique nele para parar."}{" "}
        <Link to="/ajuda/gravacao">Não encontra o ícone?</Link>
      </div>
    );
  if (s.starting && s.hint) return <div className="rec-banner warn">{s.hint}</div>;
  if (s.error && !s.recording)
    return (
      <div className="rec-banner warn">
        <strong>Não foi possível gravar:</strong> {s.error} <Link to="/ajuda/gravacao">Ajuda</Link>
      </div>
    );
  if (s.lastId && s.lastId !== dismissedId)
    return (
      <div className="rec-banner ok">
        ✓ Gravação enviada: “{s.title}” já está sendo transcrita.{" "}
        <Link to={`/meetings/${s.lastId}`}>Abrir</Link>{" "}
        <button className="link" onClick={() => setDismissedId(s.lastId)}>
          fechar
        </button>
      </div>
    );
  return null;
}
