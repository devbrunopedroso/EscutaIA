import { useState } from "react";
import { api, fmtTime, speakerColor, type Meeting } from "./api";

interface Props {
  meeting: Meeting;
  onChange: (speakers: Record<string, string>) => void;
  // Recarrega a reunião inteira (quando trechos mudam de participante).
  onReload: () => void;
}

// Participantes: tempo de fala, renomear (o mesmo nome junta dois) e refazer a
// identificação informando quantas pessoas falaram.
export function Speakers({ meeting, onChange, onReload }: Props) {
  const { id, speakers, segments } = meeting;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [others, setOthers] = useState<string>(meeting.speakers_others ? String(meeting.speakers_others) : "auto");
  const [error, setError] = useState("");

  const talk = new Map<string, number>();
  for (const s of segments) if (s.speaker) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + (s.end_ms - s.start_ms));
  const total = [...talk.values()].reduce((a, b) => a + b, 0) || 1;
  const labels = Object.keys(speakers).sort((a, b) => (talk.get(b) ?? 0) - (talk.get(a) ?? 0));

  async function save(label: string) {
    setEditing(null);
    const name = draft.trim();
    if (!name || name === speakers[label]) return;
    const res = await api<{ speakers: Record<string, string>; merged: number }>(`/api/meetings/${id}/speakers`, {
      method: "PATCH",
      body: JSON.stringify({ [label]: name }),
    });
    if (res.merged) onReload();
    else onChange(res.speakers);
  }

  async function redo() {
    setError("");
    try {
      await api(`/api/meetings/${id}/speakers/redo`, {
        method: "POST",
        body: JSON.stringify({ others: others === "auto" ? null : Number(others) }),
      });
      onReload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card stack">
      <div className="row between">
        <h3>Participantes</h3>
        <span className="muted small">clique no nome para renomear</span>
      </div>
      {meeting.speakers_pending ? (
        <p className="muted">Refazendo a identificação de quem fala…</p>
      ) : (
        labels.map((label) => {
          const ms = talk.get(label) ?? 0;
          return (
            <div key={label} className="speaker">
              <span className="dot" style={{ background: speakerColor(label) }} />
              {editing === label ? (
                <input
                  autoFocus
                  value={draft}
                  list="speaker-names"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => save(label)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save(label);
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button
                  className="link name"
                  onClick={() => {
                    setDraft(speakers[label]);
                    setEditing(label);
                  }}
                >
                  {speakers[label]}
                  {label === "me" && <span className="muted small"> (microfone)</span>}
                </button>
              )}
              <div className="bar">
                <div style={{ width: `${(ms / total) * 100}%`, background: speakerColor(label) }} />
              </div>
              <span className="muted small">
                {fmtTime(ms)} · {Math.round((ms / total) * 100)}%
              </span>
            </div>
          );
        })
      )}
      <datalist id="speaker-names">
        {Object.values(speakers).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="redo">
        <span className="small">Quantas pessoas falaram além de você?</span>
        <select value={others} onChange={(e) => setOthers(e.target.value)} disabled={meeting.speakers_pending}>
          <option value="auto">Automático</option>
          {Array.from({ length: 10 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
        <button onClick={redo} disabled={meeting.speakers_pending}>
          Refazer
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">
        Dica: renomear um participante com o nome de outro junta os dois. Refazer a identificação recomeça os nomes. Na transcrição, clique no nome de uma fala para
        trocar quem disse.
        {meeting.has_timeline && " Os nomes vieram das legendas do Meet/Teams."}
      </p>
    </section>
  );
}
