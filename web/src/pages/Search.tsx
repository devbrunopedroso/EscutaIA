import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtDate, fmtTime, type Paged, type SearchHit } from "../api";
import { Highlight } from "../Highlight";
import { Markdown } from "../Markdown";

export function Search() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const [data, setData] = useState<Paged<SearchHit> | null>(null);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!q) return;
    setData(null);
    setAnswer(null);
    api<Paged<SearchHit>>(`/api/search?q=${encodeURIComponent(q)}&limit=20`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [q]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || !data?.results.length) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await api<{ answer: string }>("/api/ask", {
        method: "POST",
        body: JSON.stringify({ question, meetingIds: data.results.slice(0, 8).map((r) => r.id) }),
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

  return (
    <div className="stack">
      <h2>Resultados para “{q}”</h2>
      {error && <p className="error">{error}</p>}
      {data && <p className="muted">{data.total} reunião(ões) encontrada(s)</p>}

      {!!data?.results.length && (
        <form className="card stack" onSubmit={ask}>
          <strong>Perguntar ao Claude sobre estes resultados</strong>
          <div className="row">
            <input
              placeholder="Ex.: o que foi decidido sobre isso?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button disabled={asking}>{asking ? "Pensando…" : "Perguntar"}</button>
          </div>
          {answer && <Markdown text={answer} />}
        </form>
      )}

      {data?.results.map((hit) => {
        const title = hit.matches.find((m) => m.matchType === "MEETING_NAME");
        const phrases = hit.matches.filter((m) => m.matchType === "TRANSCRIPT_PHRASE");
        return (
          <div className="card stack" key={hit.id}>
            <Link to={`/meetings/${hit.id}`} className="title">
              {title ? <Highlight text={title.highlight} /> : hit.title}
            </Link>
            <div className="muted small">
              {fmtDate(hit.createdAt)}
              {hit.durationMs ? ` · ${fmtTime(hit.durationMs)}` : ""}
            </div>
            {phrases.map((p, i) => (
              <Link key={i} to={`/meetings/${hit.id}?t=${p.startMs}`} className="phrase">
                <span className="ts">{fmtTime(p.startMs ?? 0)}</span>
                <span>
                  {p.speaker && <strong className="who">{p.speaker}: </strong>}
                  <Highlight text={p.highlight} />
                </span>
              </Link>
            ))}
            {hit.totalPhraseMatches > phrases.length && (
              <Link to={`/meetings/${hit.id}?find=${encodeURIComponent(q)}`} className="small">
                Ver todas as {hit.totalPhraseMatches} ocorrências na transcrição
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
