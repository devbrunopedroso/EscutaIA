// Service worker: conversa com o app EscutaIA (que roda no computador, em
// 127.0.0.1:47821) e controla o documento offscreen, onde o MediaRecorder roda.
//
// A gravação para sozinha (e é enviada ao app) quando a reunião acaba:
//  - o content script da reunião avisa que você saiu da chamada (meeting-watch.js);
//  - a aba gravada é fechada;
//  - o áudio da aba fica em silêncio total por N minutos (offscreen.js).
// Se o app estiver fechado na hora de enviar, a gravação fica guardada (IndexedDB do
// offscreen) e é enviada quando o app abrir.

const OFFSCREEN_URL = "offscreen.html";
const APP_PORTS = [47821, 47822, 47823, 47824, 47825];

const STOP_REASONS = {
  user: "Você parou a gravação.",
  "meeting-ended": "A reunião terminou.",
  "tab-closed": "A aba da reunião foi fechada.",
  silence: "A reunião ficou em silêncio.",
  "capture-ended": "A captura da aba foi interrompida.",
};

// ---------------- app local ----------------
async function findApp() {
  const { appPort } = await chrome.storage.local.get("appPort");
  for (const port of [appPort, ...APP_PORTS.filter((p) => p !== appPort)].filter(Boolean)) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) });
      const data = await res.json();
      if (data.app === "escutaia") {
        if (port !== appPort) await chrome.storage.local.set({ appPort: port });
        return { port, version: data.version, url: `http://127.0.0.1:${port}` };
      }
    } catch {
      // nada nesta porta
    }
  }
  return null;
}

// closed (app fechado) | unpaired (precisa conectar) | ready
async function appStatus() {
  const app = await findApp();
  if (!app) return { state: "closed" };
  const { appToken } = await chrome.storage.local.get("appToken");
  if (!appToken) return { state: "unpaired", ...app };
  try {
    const res = await fetch(`${app.url}/api/status`, { headers: { Authorization: `Bearer ${appToken}` } });
    if (res.status === 401) {
      await chrome.storage.local.remove("appToken"); // desconectada no app
      return { state: "unpaired", ...app };
    }
  } catch {
    return { state: "closed" };
  }
  return { state: "ready", ...app, token: appToken };
}

async function pair() {
  const app = await findApp();
  if (!app) throw new Error("O app EscutaIA não está aberto.");
  const res = await fetch(`${app.url}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `erro ${res.status}`);
  await chrome.storage.local.set({ appToken: data.token });
}

// Abre o app pelo link escutaia:// (o Chrome pergunta "Abrir EscutaIA?").
async function openApp() {
  const tab = await chrome.tabs.create({ url: "escutaia://open", active: true });
  setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 8000);
}

// ---------------- gravação ----------------
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Gravar o áudio da aba da reunião",
  });
}

async function closeOffscreenIfIdle() {
  const state = await getState();
  const { pendingUploads = 0 } = await chrome.storage.local.get("pendingUploads");
  if (!state.recording && !state.uploading && !pendingUploads) await chrome.offscreen.closeDocument().catch(() => {});
}

async function getState() {
  const { state = {} } = await chrome.storage.session.get("state");
  return state;
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: next });
  await chrome.action.setBadgeText({ text: next.recording ? "REC" : next.uploading ? "…" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  return next;
}

const tellTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, { target: "meeting-tab", ...msg }).catch(() => {});

async function stopRecording(reason) {
  const state = await getState();
  if (!state.recording) return;
  if (state.tabId) tellTab(state.tabId, { type: "recording-stopped" });
  await setState({ recording: false, uploading: true, stopReason: reason });
  await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
}

// Gravações guardadas esperando o app: tenta enviar (o offscreen guarda no IndexedDB).
async function flushPending() {
  const { pendingUploads = 0 } = await chrome.storage.local.get("pendingUploads");
  if (!pendingUploads) return;
  const status = await appStatus();
  if (status.state !== "ready") return;
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: "offscreen", type: "flush" }).catch(() => {});
}

function notify(id, title, message, buttons) {
  chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1, buttons });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const app = await findApp();
  if (id.startsWith("meeting:") && app) chrome.tabs.create({ url: `${app.url}/meetings/${id.slice("meeting:".length)}` });
  if (id.startsWith("pending:")) openApp();
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener((id) => id.startsWith("pending:") && openApp());

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.recording && state.tabId === tabId) await stopRecording("tab-closed");
});

// Ao abrir o navegador e de tempos em tempos: envia o que ficou esperando o app.
chrome.runtime.onStartup.addListener(flushPending);
chrome.alarms.create("flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === "flush" && flushPending());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return;
  (async () => {
    switch (msg.type) {
      case "app-status": {
        const status = await appStatus();
        if (status.state === "ready") flushPending();
        const { pendingUploads = 0 } = await chrome.storage.local.get("pendingUploads");
        const { token: _t, ...safe } = status;
        return { ok: true, ...safe, pendingUploads };
      }
      case "pair":
        await pair();
        return { ok: true };
      case "open-app":
        await openApp();
        return { ok: true };
      case "start": {
        const status = await appStatus();
        if (status.state !== "ready")
          return { ok: false, error: status.state === "closed" ? "Abra o app EscutaIA antes de gravar." : "Conecte a extensão ao app primeiro." };
        const { silenceMinutes = 5 } = await chrome.storage.local.get("silenceMinutes");
        await ensureOffscreen();
        // `target` vem por último: a mensagem original tem target "background" e o
        // spread não pode sobrescrever o destino.
        const res = await chrome.runtime.sendMessage({ ...msg, silenceMinutes, target: "offscreen", type: "start" });
        if (!res?.ok) {
          await closeOffscreenIfIdle();
          return { ok: false, error: res?.error ?? "falha ao iniciar a gravação" };
        }
        await setState({
          recording: true,
          uploading: false,
          error: null,
          lastId: null,
          stopReason: null,
          mic: !!res.mic,
          tabId: msg.tabId,
          title: msg.meta.title,
          startedAt: msg.meta.startedAt,
        });
        // Meet/Teams: o content script liga as legendas e anota quem fala.
        await chrome.storage.session.set({ timeline: [] });
        tellTab(msg.tabId, { type: "recording-started", startedAt: Date.parse(msg.meta.startedAt) });
        return { ok: true };
      }
      // A janelinha de permissão avisa que o microfone foi liberado: entra na gravação atual.
      case "mic-granted": {
        const state = await getState();
        if (!state.recording) return { ok: true };
        const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "add-mic" });
        await setState({ mic: !!res?.mic });
        return { ok: true };
      }
      case "stop":
        await stopRecording("user");
        return { ok: true };
      // Do content script da reunião: só vale para a aba que está sendo gravada.
      case "meeting-ended": {
        const state = await getState();
        if (state.recording && sender.tab?.id === state.tabId) await stopRecording("meeting-ended");
        return { ok: true };
      }
      case "timeline": {
        const state = await getState();
        if (!state.recording || sender.tab?.id !== state.tabId || !Array.isArray(msg.events)) return { ok: true };
        const { timeline = [] } = await chrome.storage.session.get("timeline");
        if (timeline.length < 50_000) await chrome.storage.session.set({ timeline: timeline.concat(msg.events) });
        return { ok: true };
      }
      // ---------- mensagens do offscreen ----------
      case "get-timeline": {
        const { timeline = [] } = await chrome.storage.session.get("timeline");
        return { ok: true, timeline };
      }
      case "get-app": {
        const status = await appStatus();
        return status.state === "ready" ? { ok: true, url: status.url, token: status.token } : { ok: false, state: status.state };
      }
      case "recording-ended": {
        const state = await getState();
        if (state.tabId) tellTab(state.tabId, { type: "recording-stopped" });
        if (state.recording) await setState({ recording: false, uploading: true, stopReason: msg.reason ?? "capture-ended" });
        return { ok: true };
      }
      case "pending": {
        // Gravação guardada porque o app estava fechado.
        await chrome.storage.local.set({ pendingUploads: msg.count });
        const state = await setState({ uploading: false });
        if (msg.justSaved)
          notify(
            `pending:${Date.now()}`,
            "Abra o EscutaIA para enviar a gravação",
            `“${state.title ?? "Reunião"}” está guardada no navegador e será enviada assim que o app abrir.`,
            [{ title: "Abrir EscutaIA" }],
          );
        return { ok: true };
      }
      case "uploaded": {
        const state = await setState({ uploading: false, lastId: msg.id });
        if (!msg.fromPending && state.stopReason !== "user")
          notify(
            `meeting:${msg.id}`,
            "Gravação enviada ao EscutaIA ✓",
            `${STOP_REASONS[state.stopReason] ?? ""} “${state.title}” já está sendo transcrita no app.`,
          );
        await closeOffscreenIfIdle();
        return { ok: true };
      }
      case "failed": {
        const state = await setState({ recording: false, uploading: false, error: msg.error });
        await closeOffscreenIfIdle();
        notify(`failed:${Date.now()}`, "Falha na gravação", `${state.title ?? "Reunião"}: ${msg.error}`);
        return { ok: true };
      }
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
