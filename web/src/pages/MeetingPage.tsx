import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtDate, fmtTime, getToken, speakerColor, STATUS_LABEL, type Meeting } from "../api";
import { Speakers } from "../Speakers";
import { Markdown } from "../Markdown";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function MeetingPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [m, setM] = useState<Meeting | null>(null);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(0);
  const [find, setFind] = useState(params.get("find") ?? "");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [resummarizing, setResummarizing] = useState(false);
  const [reassigning, setReassigning] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const seeked = useRef(false);

  const load = useCallback(() => api<Meeting>(`/api/meetings/${id}`).then(setM).catch((e) => setError(e.message)), [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Atualiza sozinho enquanto a reunião é processada ou a identificação é refeita.
  const busy = !!m && (!["ready", "failed"].includes(m.status) || m.speakers_pending);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  // ?t=<ms> vindo da busca: pula para o trecho quando o áudio carregar.
  const startAt = Number(params.get("t") ?? NaN);
  function onLoaded() {
    if (!seeked.current && Number.isFinite(startAt) && audio.current) {
      audio.current.currentTime = startAt / 1000;
      seeked.current = true;
    }
  }

  const activeIdx = useMemo(() => {
    if (!m) return -1;
    let idx = -1;
    for (const s of m.segments) if (s.start_ms <= current) idx = s.idx;
    return idx;
  }, [m, current]);

  useEffect(() => {
    document.getElementById(`seg-${activeIdx}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  const findNorm = norm(find.trim());
  const matchCount = findNorm ? (m?.segments.filter((s) => norm(s.text).includes(findNorm)).length ?? 0) : 0;

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    try {
      const res = await api<{ answer: string }>("/api/ask", {
        method: "POST",
        body: JSON.stringify({ question, meetingIds: [id] }),
      });
      setAnswer(res.answer);
    } catch (err) {
      const e = err as Error & { code?: string };
      setAnswer(
        e.code === "claude_not_configured"
          ? `**${e.message}**\n\n[Abrir Configurações → Claude](/configuracoes)`
          : `**Erro:** ${e.message}`,
      );
    } finally {
      setAsking(false);
    }
  }

  async function resummarize() {
    setResummarizing(true);
    try {
      const { summary } = await api<{ summary: string }>(`/api/meetings/${id}/summary`, { method: "POST" });
      setM((prev) => (prev ? { ...prev, summary, summary_error: null } : prev));
    } catch (err) {
      const message = (err as Error).message;
      setM((prev) => (prev ? { ...prev, summary_error: message } : prev));
    } finally {
      setResummarizing(false);
    }
  }

  async function reassign(idx: number, speaker: string) {
    setReassigning(null);
    await api(`/api/meetings/${id}/segments/${idx}`, { method: "PATCH", body: JSON.stringify({ speaker }) });
    load();
  }

  async function remove() {
    if (!confirm("Apagar esta reunião e a gravação?")) return;
    await api(`/api/meetings/${id}`, { method: "DELETE" });
    navigate("/");
  }

  if (error) return <p className="error">{error}</p>;
  if (!m) return <p className="muted">Carregando…</p>;

  return (
    <div className="meeting">
      <div className="stack">
        <div className="row between">
          <div>
            <h2>{m.title}</h2>
            <div className="muted small">
              {fmtDate(m.created_at)}
              {m.duration_ms ? ` · ${fmtTime(m.duration_ms)}` : ""} · <span className={`badge ${m.status}`}>{STATUS_LABEL[m.status]}</span>
            </div>
          </div>
          <div className="row">
            {m.status === "failed" && (
              <button onClick={() => api(`/api/meetings/${id}/retry`, { method: "POST" }).then(() => location.reload())}>
                Reprocessar
              </button>
            )}
            <button className="danger" onClick={remove}>
              Apagar
            </button>
          </div>
        </div>
        {m.error && <p className="error">{m.error}</p>}
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={`/api/meetings/${id}/audio?token=${encodeURIComponent(getToken() ?? "")}`}
          onLoadedMetadata={onLoaded}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime * 1000)}
        />

        {Object.keys(m.speakers).length > 0 && (
          <Speakers
            meeting={m}
            onChange={(speakers) => setM((prev) => (prev ? { ...prev, speakers } : prev))}
            onReload={load}
          />
        )}

        <section className="card">
          <div className="row between">
            <h3>Resumo</h3>
            {m.status === "ready" && m.segments.length > 0 && m.summary && (
              <button className="link" onClick={resummarize} disabled={resummarizing}>
                {resummarizing ? "Gerando…" : "Refazer resumo"}
              </button>
            )}
          </div>
          {m.summary ? (
            <Markdown text={m.summary} />
          ) : m.summary_error ? (
            <div className="notice stack">
              <span>
                <strong>Não foi possível gerar o resumo.</strong> {m.summary_error}
              </span>
              <div className="row">
                {/n[ãa]o configurado|inv[áa]lido|expirado/i.test(m.summary_error) && (
                  <Link to="/configuracoes" className="button">
                    Configurar Claude
                  </Link>
                )}
                <button onClick={resummarize} disabled={resummarizing}>
                  {resummarizing ? "Gerando…" : "Gerar resumo"}
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">O resumo aparece aqui quando o processamento terminar.</p>
          )}
        </section>

        <form className="card stack" onSubmit={ask}>
          <h3>Perguntar ao Claude</h3>
          <div className="row">
            <input placeholder="Ex.: quais foram os próximos passos?" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button disabled={asking || !m.segments.length}>{asking ? "Pensando…" : "Perguntar"}</button>
          </div>
          {answer && <Markdown text={answer} />}
        </form>
      </div>

      <aside className="card transcript">
        <div className="row between">
          <h3>Transcrição</h3>
          <input className="find" placeholder="Procurar…" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
        {findNorm && <p className="muted small">{matchCount} trecho(s) com “{find}”</p>}
        {!m.segments.length && <p className="muted">Ainda sem transcrição.</p>}
        {m.segments.map((s, i) => {
          const hit = findNorm && norm(s.text).includes(findNorm);
          if (findNorm && !hit) return null;
          // Mostra o nome só quando o falante muda (ou quando o filtro esconde o anterior).
          const showName = s.speaker && (findNorm || m.segments[i - 1]?.speaker !== s.speaker);
          const seek = () => {
            if (audio.current) {
              audio.current.currentTime = s.start_ms / 1000;
              audio.current.play();
            }
          };
          return (
            <div
              key={s.idx}
              id={`seg-${s.idx}`}
              role="button"
              tabIndex={0}
              className={`seg ${s.idx === activeIdx ? "active" : ""} ${hit ? "hit" : ""}`}
              style={{ borderLeftColor: speakerColor(s.speaker) }}
              onClick={seek}
              onKeyDown={(e) => e.key === "Enter" && seek()}
            >
              <span className="ts">{fmtTime(s.start_ms)}</span>
              <span>
                {reassigning === s.idx ? (
                  <select
                    autoFocus
                    className="who-select"
                    value={s.speaker ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => setReassigning(null)}
                    onChange={(e) => reassign(s.idx, e.target.value)}
                  >
                    {Object.entries(m.speakers).map(([label, name]) => (
                      <option key={label} value={label}>
                        {name}
                      </option>
                    ))}
                    <option value="new">+ Novo participante</option>
                  </select>
                ) : (
                  (showName || Object.keys(m.speakers).length > 0) && (
                    <button
                      className={`who ${showName ? "" : "who-hover"}`}
                      style={{ color: speakerColor(s.speaker) }}
                      title="Trocar quem disse"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReassigning(s.idx);
                      }}
                    >
                      {s.speaker ? (m.speakers[s.speaker] ?? s.speaker) : "?"}
                    </button>
                  )
                )}
                {s.text}
              </span>
            </div>
          );
        })}
      </aside>
    </div>
  );
}
