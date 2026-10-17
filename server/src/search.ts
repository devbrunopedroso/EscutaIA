import { pool } from "./db.ts";

// Marcadores de destaque. Usamos caracteres de controle em vez de HTML para que o
// front renderize o destaque sem precisar confiar no texto da transcrição.
export const HL_START = "\u0001";
export const HL_END = "\u0002";
const HL_OPTS = `StartSel=${HL_START}, StopSel=${HL_END}, MaxFragments=1, MaxWords=30, MinWords=12`;
const TITLE_HL_OPTS = `StartSel=${HL_START}, StopSel=${HL_END}, HighlightAll=true`;
const MAX_PHRASES = 5;

export type MatchType = "MEETING_NAME" | "TRANSCRIPT_PHRASE";

export interface SearchHit {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  durationMs: number | null;
  score: number;
  totalPhraseMatches: number;
  matches: { matchType: MatchType; raw: string; highlight: string; startMs?: number; speaker?: string | null }[];
}

// Mesma ideia do tl;dv: um resultado por reunião, com a lista de "matches"
// (título e até 5 frases da transcrição com timestamp para pular no player).
export async function searchMeetings(userId: string, q: string, limit: number, offset: number) {
  const { rows } = await pool.query(
    `
    WITH q AS (SELECT websearch_to_tsquery('pt_unaccent', $2) AS q),
    seg AS (
      SELECT s.meeting_id, s.start_ms, s.text, s.speaker,
             ts_rank(s.tsv, q.q) AS rank,
             row_number() OVER (PARTITION BY s.meeting_id ORDER BY ts_rank(s.tsv, q.q) DESC, s.start_ms) AS rn
      FROM segments s JOIN meetings m ON m.id = s.meeting_id, q
      WHERE m.user_id = $1 AND s.tsv @@ q.q
    ),
    agg AS (
      SELECT meeting_id,
             count(*)::int AS total,
             sum(rank) AS rank,
             jsonb_agg(jsonb_build_object('raw', text, 'startMs', start_ms, 'speaker', speaker) ORDER BY start_ms)
               FILTER (WHERE rn <= ${MAX_PHRASES}) AS phrases
      FROM seg GROUP BY meeting_id
    )
    SELECT m.id, m.title, m.status, m.created_at, m.duration_ms, m.speakers,
           (m.title_tsv @@ q.q) AS title_match,
           ts_headline('pt_unaccent', m.title, q.q, '${TITLE_HL_OPTS}') AS title_hl,
           coalesce(agg.total, 0) AS total_phrase_matches,
           coalesce(agg.phrases, '[]'::jsonb) AS phrases,
           coalesce(agg.rank, 0) + CASE WHEN m.title_tsv @@ q.q THEN 1 ELSE 0 END AS score,
           count(*) OVER () AS total_hits,
           q.q::text AS tsquery
    FROM meetings m CROSS JOIN q
    LEFT JOIN agg ON agg.meeting_id = m.id
    WHERE m.user_id = $1 AND (m.title_tsv @@ q.q OR agg.meeting_id IS NOT NULL)
    ORDER BY score DESC, m.created_at DESC
    LIMIT $3 OFFSET $4
    `,
    [userId, q, limit, offset],
  );

  // Destaca as frases depois do LIMIT, para não rodar ts_headline em todo o acervo.
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const matches: SearchHit["matches"] = [];
    if (r.title_match) matches.push({ matchType: "MEETING_NAME", raw: r.title, highlight: r.title_hl });
    if (r.phrases.length) {
      const { rows: hl } = await pool.query(
        // $2 já é o tsquery normalizado; to_tsquery aplicaria o stemmer de novo e perderia o destaque.
        `SELECT ts_headline('pt_unaccent', t, $2::tsquery, '${HL_OPTS}') AS h
         FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY i`,
        [r.phrases.map((p: { raw: string }) => p.raw), r.tsquery],
      );
      r.phrases.forEach((p: { raw: string; startMs: number; speaker: string | null }, i: number) =>
        matches.push({
          matchType: "TRANSCRIPT_PHRASE",
          raw: p.raw,
          highlight: hl[i].h,
          startMs: p.startMs,
          speaker: p.speaker ? (r.speakers[p.speaker] ?? p.speaker) : null,
        }),
      );
    }
    hits.push({
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      durationMs: r.duration_ms,
      score: Number(r.score),
      totalPhraseMatches: r.total_phrase_matches,
      matches,
    });
  }
  const total = rows.length ? Number(rows[0].total_hits) : 0;
  return { total, page: Math.floor(offset / limit) + 1, pages: Math.ceil(total / limit), pageSize: limit, results: hits };
}
