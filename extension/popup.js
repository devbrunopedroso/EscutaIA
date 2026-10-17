const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg });

// Página de download (app + extensão). Definida em config.json ao gerar o pacote.
const SITE = await fetch(chrome.runtime.getURL("config.json"))
  .then((r) => r.json())
  .then((c) => c.site)
  .catch(() => null);

const PLATFORMS = [
  [/meet\.google\.com/, "meet"],
  [/zoom\.(us|com)/, "zoom"],
  [/teams\.(microsoft|live|cloud\.microsoft)/, "teams"],
];

function showError(e) {
  $("error").textContent = e ? (e.message ?? String(e)) : "";
}

function show(section) {
  for (const id of ["checking", "closed", "unpaired", "ready"]) $(id).hidden = id !== section;
}

let app = { state: "checking" };

async function render() {
  app = await bg({ type: "app-status" });
  const { state = {} } = await chrome.storage.session.get("state");
  // Gravando, mostra os controles mesmo se o app fechou no meio (a gravação fica guardada).
  show(state.recording || state.uploading ? "ready" : app.state);
  $("download").hidden = !SITE;
  if (SITE) $("download").href = SITE;
  $("pending").hidden = !app.pendingUploads;
  $("pending").textContent = app.pendingUploads
    ? `${app.pendingUploads} gravação(ões) esperando o app abrir para serem enviadas.`
    : "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("tab").textContent = tab?.title ?? "";
  $("start").hidden = !!state.recording || !!state.uploading;
  $("stop").hidden = !state.recording;
  $("auto").hidden = !state.recording;
  $("status").textContent = state.recording
    ? `Gravando desde ${new Date(state.startedAt).toLocaleTimeString("pt-BR")}${state.mic ? " (com microfone)" : " (só a aba)"}`
    : state.uploading
      ? "Enviando gravação ao app…"
      : state.lastId
        ? "Enviado! O app já está transcrevendo."
        : "";
  if (state.error) showError(state.error);
}

$("open-app").addEventListener("click", () => bg({ type: "open-app" }));
$("open-ui").addEventListener("click", (e) => {
  e.preventDefault();
  if (app.url) chrome.tabs.create({ url: app.url });
});

$("pair").addEventListener("click", async () => {
  showError(null);
  $("pair").disabled = true;
  $("pair").textContent = "Aprove na janela do EscutaIA…";
  try {
    const res = await bg({ type: "pair" });
    if (!res?.ok) throw new Error(res?.error ?? "não consegui conectar");
    await render();
  } catch (err) {
    showError(err);
  } finally {
    $("pair").disabled = false;
    $("pair").textContent = "Conectar ao app";
  }
});

async function micAllowed() {
  const p = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  return p?.state === "granted";
}

// Abre uma janelinha (não uma aba) centralizada sobre o Chrome, que pede o microfone.
// O pedido não aparece dentro do popup e o documento offscreen não consegue pedir.
async function openMicDialog() {
  const win = await chrome.windows.getCurrent();
  const width = 420, height = 300;
  await chrome.windows.create({
    url: chrome.runtime.getURL("mic.html"),
    type: "popup",
    width,
    height,
    left: Math.round((win.left ?? 0) + ((win.width ?? width) - width) / 2),
    top: Math.round((win.top ?? 0) + ((win.height ?? height) - height) / 3),
    focused: true,
  });
}

$("start").addEventListener("click", async () => {
  showError(null);
  try {
    const wantMic = $("mic").checked;
    const micReady = wantMic && (await micAllowed());
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const meta = {
      title: tab.title || "Reunião",
      url: tab.url,
      platform: PLATFORMS.find(([re]) => re.test(tab.url ?? ""))?.[1] ?? null,
      startedAt: new Date().toISOString(),
    };
    // A gravação começa já; se faltar a permissão do microfone, ele entra assim que for liberado.
    const res = await bg({ type: "start", streamId, tabId: tab.id, mic: micReady, meta });
    if (!res?.ok) throw new Error(res?.error ?? "não consegui iniciar");
    if (wantMic && !micReady) await openMicDialog();
    render();
  } catch (err) {
    showError(err);
  }
});

$("stop").addEventListener("click", async () => {
  await bg({ type: "stop" });
  render();
});

// Minutos de silêncio total na aba até parar sozinho (0 = nunca).
chrome.storage.local.get("silenceMinutes").then(({ silenceMinutes = 5 }) => ($("silence").value = String(silenceMinutes)));
$("silence").addEventListener("change", (e) => chrome.storage.local.set({ silenceMinutes: Number(e.target.value) }));

chrome.storage.session.onChanged.addListener(render);
render();
// Enquanto o popup está aberto, percebe quando o app abre/fecha.
setInterval(render, 2000);
