import { useEffect, useState } from "react";

// A extensão (versão baixada deste servidor) injeta um content script que marca o
// <html> com data-escutaia-extension="<versão>" e responde a postMessage.
export function useExtension() {
  const read = () => document.documentElement.dataset.escutaiaExtension ?? null;
  const [version, setVersion] = useState<string | null>(read);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === window && e.data?.source === "escutaia-extension" && e.data.type === "ready") setVersion(read());
    };
    window.addEventListener("message", onMessage);
    // O content script roda em document_start, mas confere de novo por garantia.
    const t = setTimeout(() => setVersion(read()), 500);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(t);
    };
  }, []);

  return version;
}

export function connectExtension(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 3000);
    function done(ok: boolean) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(ok);
    }
    function onMessage(e: MessageEvent) {
      if (e.source !== window || e.data?.source !== "escutaia-extension") return;
      if (e.data.type === "connected") done(true);
      if (e.data.type === "connect-failed") done(false);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "escutaia-site", type: "connect", token }, location.origin);
  });
}

export const isChromium = () => /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
