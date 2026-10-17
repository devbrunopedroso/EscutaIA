// O servidor marca os trechos encontrados com \u0001 ... \u0002 (sem HTML),
// então o texto da transcrição nunca é interpretado como HTML.
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}
