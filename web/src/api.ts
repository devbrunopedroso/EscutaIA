const TOKEN_KEY = "escutaia_token";

// App local: a janela abre o site com ?t=<token do app>. Guarda e tira da URL.
{
  const url = new URL(location.href);
  const t = url.searchParams.get("t");
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    url.searchParams.delete("t");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

// Dentro do app desktop (ponte exposta pelo ui-preload.js).
export const desktop = (window as unknown as { escutaiaDesktop?: { openRecorder(): void; startRecording(): void } })
  .escutaiaDesktop;

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && token && !desktop) {
    setToken(null);
    location.href = "/login";
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `erro ${res.status}`), { code: data.code as string | undefined });
  return data as T;
}

export type Status = "queued" | "transcribing" | "summarizing" | "ready" | "failed";

export interface MeetingSummary {
  id: string;
  title: string;
  status: Status;
  error: string | null;
  platform: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface Segment {
  idx: number;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  text: string;
}

export interface Meeting extends MeetingSummary {
  summary: string | null;
  summary_error: string | null;
  // rótulo ("me", "S1"...) -> nome exibido
  speakers: Record<string, string>;
  speakers_others: number | null;
  speakers_pending: boolean;
  has_timeline: boolean;
  source_url: string | null;
  segments: Segment[];
}

export interface SearchMatch {
  matchType: "MEETING_NAME" | "TRANSCRIPT_PHRASE";
  raw: string;
  highlight: string;
  startMs?: number;
  speaker?: string | null;
}

export interface SearchHit {
  id: string;
  title: string;
  status: Status;
  createdAt: string;
  durationMs: number | null;
  totalPhraseMatches: number;
  matches: SearchMatch[];
}

export interface Paged<T> {
  total: number;
  page: number;
  pages: number;
  results: T[];
}

export const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" });

export const STATUS_LABEL: Record<Status, string> = {
  queued: "Na fila",
  transcribing: "Transcrevendo…",
  summarizing: "Gerando resumo…",
  ready: "Pronta",
  failed: "Falhou",
};

const SPEAKER_COLORS = ["#4f46e5", "#0e9f6e", "#d97706", "#db2777", "#7c3aed", "#65a30d", "#dc2626", "#0369a1"];

export const speakerColor = (label: string | null) => {
  if (!label) return "var(--muted)";
  if (label === "me") return "#0891b2";
  return SPEAKER_COLORS[(Number(label.slice(1)) - 1) % SPEAKER_COLORS.length] ?? "var(--muted)";
};
