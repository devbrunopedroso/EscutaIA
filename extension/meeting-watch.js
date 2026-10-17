// Roda nas páginas de reunião (Meet, Zoom web, Teams web).
//  1) Avisa a extensão quando você sai da chamada: o botão de desligar estava na tela
//     e sumiu. Só tem efeito na aba que está sendo gravada (o background confere).
//  2) Enquanto esta aba é gravada, liga as legendas do Meet/Teams e anota QUEM está
//     falando e QUANDO. O servidor usa isso para dar nomes reais aos participantes.
// Seletores baseados no TranscripTonic (MIT), que acompanha as mudanças do Meet/Teams.

const PLATFORM = location.hostname.includes("meet.google.com")
  ? "meet"
  : location.hostname.includes("teams.")
    ? "teams"
    : location.hostname.includes("zoom.")
      ? "zoom"
      : "other";

const LEAVE_BUTTON = [
  'button[aria-label*="Leave call" i]',
  'button[aria-label*="Sair da chamada" i]',
  'button[aria-label*="Salir de la llamada" i]',
  "#hangup-button",
  '[data-tid="hangup-main-btn"]',
  '[data-tid="call-hangup"]',
  ".footer__leave-btn",
  ".footer__leave-btn-container",
  'button[aria-label="Leave"]',
  'button[aria-label="Sair"]',
].join(",");

const CAPTIONS_REGION = {
  meet: 'div[role="region"][tabindex="0"]',
  teams: '[data-tid="closed-caption-v2-virtual-list-content"]',
};

// Ícones do Meet são texto em uma fonte de símbolos: "call_end", "closed_caption_off"...
const meetIcon = (name) => [...document.querySelectorAll(".google-symbols")].find((e) => e.textContent.trim() === name);

const send = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

// ---------------- 1) fim da chamada ----------------
const ABSENT_FOR_MS = 8000; // tolera re-renderizações rápidas da interface
let seenInCall = false;
let absentSince = null;
let reported = false;

function checkInCall() {
  if (reported) return;
  const inCall = !!document.querySelector(LEAVE_BUTTON) || !!meetIcon("call_end");
  if (inCall) {
    seenInCall = true;
    absentSince = null;
    return;
  }
  if (!seenInCall) return;
  absentSince ??= Date.now();
  if (Date.now() - absentSince >= ABSENT_FOR_MS) {
    reported = true;
    send({ type: "meeting-ended" });
  }
}
setInterval(checkInCall, 1000);

// ---------------- 2) quem está falando (legendas) ----------------
const SELF = /^(você|voce|you|vous|tú|tu|du|sie)$/i;
let startedAt = null;
let observer = null;
let observedRegion = null;
let pending = [];
const lastByName = new Map();

function speakerOf(textEl) {
  // Meet: [nome][texto]; Teams: [nome][[texto]] (DOM observado pelo TranscripTonic).
  const nameEl = PLATFORM === "meet" ? textEl?.previousSibling : textEl?.parentElement?.previousSibling;
  const name = nameEl?.textContent?.trim();
  return name && name.length <= 80 && !SELF.test(name) ? name : null;
}

function record(textNode) {
  const name = speakerOf(textNode.parentElement);
  if (!name || startedAt === null) return;
  const t = Date.now() - startedAt;
  // No máximo um evento a cada 500 ms por pessoa: a legenda muda letra a letra.
  if (t - (lastByName.get(name) ?? -1e9) < 500) return;
  lastByName.set(name, t);
  pending.push({ t, name });
}

function textNodesIn(node) {
  if (node.nodeType === Node.TEXT_NODE) return [node];
  const out = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

function turnOnCaptions() {
  if (PLATFORM === "meet") {
    meetIcon("closed_caption_off")?.closest("button")?.click();
  } else if (PLATFORM === "teams") {
    // Atalho de legendas do Teams: Cmd+Shift+A (Mac) / Alt+Shift+C (Windows/Linux).
    const mac = navigator.platform.toLowerCase().includes("mac");
    document.dispatchEvent(
      new KeyboardEvent("keydown", mac
        ? { key: "a", code: "KeyA", metaKey: true, shiftKey: true, bubbles: true }
        : { key: "c", code: "KeyC", altKey: true, shiftKey: true, bubbles: true }),
    );
  }
}

function watchCaptions() {
  const selector = CAPTIONS_REGION[PLATFORM];
  if (!selector || observer) return;
  const region = document.querySelector(selector);
  if (!region) return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") record(m.target);
      else for (const n of m.addedNodes) textNodesIn(n).forEach(record);
    }
  });
  observer.observe(region, { characterData: true, childList: true, subtree: true });
  observedRegion = region;
}

let captionsTimer = null;
function startSpeakerTracking(startTime) {
  startedAt = startTime;
  pending = [];
  lastByName.clear();
  let tries = 0;
  turnOnCaptions();
  // A região das legendas pode demorar a aparecer (ou ser recriada pelo Meet).
  captionsTimer = setInterval(() => {
    // O Meet às vezes recria a região das legendas: reconecta na nova.
    if (observer && !observedRegion?.isConnected) {
      observer.disconnect();
      observer = null;
    }
    if (!observer) {
      watchCaptions();
      if (++tries === 5) turnOnCaptions();
    }
    if (pending.length) {
      send({ type: "timeline", events: pending });
      pending = [];
    }
  }, 2000);
}

function stopSpeakerTracking() {
  clearInterval(captionsTimer);
  observer?.disconnect();
  observer = null;
  observedRegion = null;
  if (pending.length) send({ type: "timeline", events: pending });
  pending = [];
  startedAt = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "meeting-tab") return;
  if (msg.type === "recording-started") startSpeakerTracking(msg.startedAt);
  if (msg.type === "recording-stopped") stopSpeakerTracking();
});
