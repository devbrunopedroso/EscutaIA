// Grava o áudio da aba (+ microfone, opcional) e envia ao servidor ao parar.

let recorder = null;
let streams = [];
let audioCtx = null;
let merger = null;
let micAdded = false;
let session = null;
let silenceTimer = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg });

async function start({ streamId, mic, meta, silenceMinutes }) {
  if (recorder) throw new Error("já existe uma gravação em andamento");
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  streams = [tab];
  audioCtx = new AudioContext();
  // Estéreo: canal esquerdo = seu microfone, direito = áudio da aba (os outros).
  // O servidor usa essa separação para saber quando é você falando.
  merger = audioCtx.createChannelMerger(2);
  micAdded = false;
  const mix = audioCtx.createMediaStreamDestination();
  mix.channelCount = 2;
  merger.connect(mix);
  const tabSource = audioCtx.createMediaStreamSource(tab);
  tabSource.connect(merger, 0, 1);
  // Capturar a aba silencia o som dela; devolvemos para os alto-falantes.
  tabSource.connect(audioCtx.destination);

  if (mic) await addMic();

  const chunks = [];
  session = { chunks, meta };
  recorder = new MediaRecorder(mix.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => upload().catch((e) => toBackground({ type: "failed", error: e.message }));
  recorder.start(10_000);

  // Se a aba fechar ou a captura cair, encerra e envia o que foi gravado.
  tab.getAudioTracks()[0].addEventListener("ended", () => endBy("capture-ended"));
  watchSilence(tabSource, silenceMinutes);
}

// Liga o microfone no canal esquerdo. Pode ser chamado no meio da gravação, logo
// depois que o usuário libera o microfone na janelinha de permissão.
async function addMic() {
  if (!audioCtx || micAdded) return micAdded;
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    streams.push(micStream);
    audioCtx.createMediaStreamSource(micStream).connect(merger, 0, 0);
    micAdded = true;
  } catch (e) {
    console.warn("microfone indisponível, gravando só a aba:", e);
  }
  return micAdded;
}

function endBy(reason) {
  if (recorder?.state !== "recording") return;
  recorder.stop();
  toBackground({ type: "recording-ended", reason });
}

// Para sozinho se o áudio da aba (os outros participantes) ficar em silêncio total
// por `minutes` minutos: sinal de que a reunião acabou e a aba ficou parada.
function watchSilence(source, minutes) {
  clearInterval(silenceTimer);
  if (!minutes || minutes <= 0) return;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let silentMs = 0;
  silenceTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    silentMs = rms < 0.0005 ? silentMs + 1000 : 0;
    if (silentMs >= minutes * 60_000) endBy("silence");
  }, 1000);
}

function cleanup() {
  clearInterval(silenceTimer);
  for (const st of streams) st.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  recorder = null;
  streams = [];
  audioCtx = null;
  merger = null;
  micAdded = false;
}

function stop() {
  if (recorder?.state === "recording") recorder.stop();
}

// ---------------- envio ao app (com fila no IndexedDB) ----------------
// Toda gravação é salva aqui antes de enviar e só é apagada depois que o app confirma.
// Se o app estiver fechado, ela espera e é enviada quando ele abrir.
const DB = "escutaia";
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pending", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("pending", mode);
    const req = fn(tx.objectStore("pending"));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const pendingAll = () => store("readonly", (s) => s.getAll());
const pendingPut = (rec) => store("readwrite", (s) => s.put(rec));
const pendingDel = (id) => store("readwrite", (s) => s.delete(id));

async function sendToApp(rec) {
  const app = await toBackground({ type: "get-app" });
  if (!app?.ok) return false;
  const form = new FormData();
  form.append("title", rec.meta.title);
  if (rec.meta.url) form.append("sourceUrl", rec.meta.url);
  if (rec.meta.platform) form.append("platform", rec.meta.platform);
  form.append("startedAt", rec.meta.startedAt);
  // Quem falou quando (legendas do Meet/Teams). Precisa vir antes do arquivo no multipart.
  if (rec.timeline?.length) form.append("speakerTimeline", JSON.stringify(rec.timeline));
  form.append("file", rec.blob, "reuniao.webm");
  const res = await fetch(`${app.url}/api/meetings`, { method: "POST", headers: { Authorization: `Bearer ${app.token}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `envio falhou (${res.status})`);
  return data.id;
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const rec of await pendingAll()) {
      let id;
      try {
        id = await sendToApp(rec);
      } catch (e) {
        console.warn("envio falhou, tento de novo depois:", e);
        id = false;
      }
      if (!id) break; // app fechado: espera a próxima tentativa
      await pendingDel(rec.id);
      await toBackground({ type: "uploaded", id, fromPending: rec.retried });
    }
  } finally {
    flushing = false;
    await toBackground({ type: "pending", count: (await pendingAll()).length, justSaved: false });
  }
}

async function upload() {
  clearInterval(silenceTimer);
  const { chunks, meta } = session;
  for (const s of streams) s.getTracks().forEach((t) => t.stop());
  await audioCtx?.close();
  recorder = null;
  streams = [];
  merger = null;
  micAdded = false;

  const blob = new Blob(chunks, { type: "audio/webm" });
  if (!blob.size) throw new Error("nada foi gravado");
  const { timeline = [] } = (await toBackground({ type: "get-timeline" }).catch(() => null)) ?? {};
  const rec = { id: crypto.randomUUID(), meta, timeline, blob, retried: false };
  await pendingPut(rec);

  let id = false;
  try {
    id = await sendToApp(rec);
  } catch (e) {
    console.warn("envio falhou:", e);
  }
  if (id) {
    await pendingDel(rec.id);
    await toBackground({ type: "uploaded", id });
  } else {
    await pendingPut({ ...rec, retried: true });
    await toBackground({ type: "pending", count: (await pendingAll()).length, justSaved: true });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  const run =
    msg.type === "start" ? start(msg) : msg.type === "add-mic" ? addMic() : msg.type === "flush" ? flush() : Promise.resolve(stop());
  run
    .then((result) => sendResponse({ ok: true, mic: msg.type === "start" ? micAdded : result }))
    .catch((e) => {
      // Falha ao iniciar volta só na resposta: avisar "failed" aqui faria o background
      // fechar este documento antes da resposta chegar, escondendo o motivo real.
      cleanup();
      sendResponse({ ok: false, error: `${e.name}: ${e.message}` });
    });
  return true;
});
