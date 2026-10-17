import { marked } from "marked";
import DOMPurify from "dompurify";

export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }));
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
