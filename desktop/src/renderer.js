// Interface + gravador. Grava em estéreo como a extensão do Chrome:
// canal esquerdo = seu microfone, direito = som do computador (os outros participantes).
// Assim o servidor identifica quando é você falando.

const $ = (id) => document.getElementById(id);
const api = window.escutaia;
let settings = null;

// Estado da gravação também vai para a janela principal do app (e para a bandeja).
const report = (patch) => api.recordingState(patch);

function showError(e) {
  const msg = e ? (e.message ?? String(e)) : "";
  $("error").textContent = msg;
  if (msg) report({ starting: false, error: msg });
}

function showHint(msg) {
  $("error").textContent = msg;
  report({ hint: msg });
}

// ---------------- captura ----------------

async function systemAudioStream() {
  // O processo principal responde com áudio "loopback" do sistema (Windows: WASAPI;
  // macOS: CoreAudio Tap; Linux: PulseAudio/PipeWire, testado num Debian).
  // No macOS, a 1ª vez abre o pedido "Gravar áudio do sistema"; sem resposta, a
  // captura fica esperando, então avisamos o que fazer.
  const hint = setTimeout(() => {
    if (settings.platform === "darwin")
      showHint("Clique em “Permitir” no aviso do macOS para gravar o áudio do sistema. Se não apareceu: Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema → EscutaIA.");
  }, 4000);
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).finally(() => clearTimeout(hint));
  showError(null);
  report({ hint: null });
  display.getVideoTracks().forEach((t) => t.stop()); // só o áudio interessa
  const tracks = display.getAudioTracks();
  if (!tracks.length) {
    throw new Error(
      settings.platform === "darwin"
        ? "O macOS não liberou o som do computador. Em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema, permita o EscutaIA e abra o app de novo."
        : "Não consegui capturar o som do computador.",
    );
  }
  return new MediaStream(tracks);
}

async function micStream() {
  if (!(await api.micAccess())) throw new Error("O microfone foi negado nas configurações do sistema.");
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

const rms = (analyser, buf) => {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
};

// Monta a captura: retorna o stream estéreo e medidores de nível por canal.
async function openCapture(withMic) {
  const streams = [await systemAudioStream()];
  const ctx = new AudioContext();
  const merger = ctx.createChannelMerger(2);
  const out = ctx.createMediaStreamDestination();
  out.channelCount = 2;
  merger.connect(out);

  const meter = (source) => {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    source.connect(a);
    const buf = new Float32Array(a.fftSize);
    return () => rms(a, buf);
  };

  const sys = ctx.createMediaStreamSource(streams[0]);
  sys.connect(merger, 0, 1);
  const levelSystem = meter(sys);
  let levelMic = () => 0;
  if (withMic) {
    try {
      const m = await micStream();
      streams.push(m);
      const src = ctx.createMediaStreamSource(m);
      src.connect(merger, 0, 0);
      levelMic = meter(src);
    } catch (e) {
      showError(`Gravando sem microfone: ${e.message}`);
    }
  }
  const close = () => {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    ctx.close();
  };
  const source = streams[0].getAudioTracks()[0]?.label ?? "";
  return { stream: out.stream, levelSystem, levelMic, close, source };
}

// ---------------- gravação ----------------
let rec = null; // { capture, recorder, chunks, startedAt, timer, silentMs, title }
let afterStop = null;

const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const scale = (v) => Math.min(1, v * 8); // RMS de fala fica ~0.02–0.1

async function start() {
  showError(null);
  if (rec) return;
  report({ starting: true, error: null, hint: null, lastId: null });
  const capture = await openCapture(settings.mic);
  const chunks = [];
  const recorder = new MediaRecorder(capture.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(10_000);
  const startedAt = new Date();
  const title = $("title").value.trim() || `Reunião de ${startedAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
  rec = { capture, recorder, chunks, startedAt, title, silentMs: 0 };
  rec.timer = setInterval(tick, 1000);
  report({ starting: false, recording: true, title, startedAt: startedAt.toISOString(), elapsed: "0:00" });
  render();
}

function tick() {
  const sys = rec.capture.levelSystem();
  const mic = rec.capture.levelMic();
  $("lvl-system").value = scale(sys);
  $("lvl-mic").value = scale(mic);
  const elapsed = fmt(Date.now() - rec.startedAt);
  $("status").textContent = `Gravando · ${elapsed}`;
  api.recordingState({ recording: true, elapsed });
  // Silêncio total no som do computador por N minutos = reunião acabou.
  rec.silentMs = sys < 0.0005 && mic < 0.0005 ? rec.silentMs + 1000 : 0;
  if (settings.silenceMinutes > 0 && rec.silentMs >= settings.silenceMinutes * 60_000) stop("A reunião ficou em silêncio.");
}

async function stop(reason = null) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  await new Promise((resolve) => {
    r.recorder.onstop = resolve;
    r.recorder.stop();
  });
  r.capture.close();
  report({ recording: false, uploading: true, elapsed: null });
  $("status").textContent = "Enviando gravação…";
  $("record").disabled = true;
  try {
    const blob = new Blob(r.chunks, { type: "audio/webm" });
    const { id, pending } = await api.upload(await blob.arrayBuffer(), {
      title: r.title,
      startedAt: r.startedAt.toISOString(),
      stopReason: reason,
    });
    if (pending) {
      // Servidor fora do ar: o app guardou a gravação e envia sozinho quando ele voltar.
      report({ uploading: false, lastId: null, title: r.title, error: null, hint: null });
      $("status").textContent = "Gravação guardada. Ela será enviada sozinha assim que o EscutaIA estiver pronto.";
    } else {
      report({ uploading: false, lastId: id, title: r.title, error: null });
      $("status").textContent = "Enviado! A transcrição já começou — o app avisa quando terminar.";
    }
    $("title").value = "";
  } catch (e) {
    // Só chega aqui se o servidor recusou o arquivo (falhas de conexão ficam na fila do
    // app). Não perde a gravação: oferece salvar o arquivo.
    $("status").textContent = "";
    report({ uploading: false });
    showError(`Falha ao enviar: ${e.message}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(r.chunks, { type: "audio/webm" }));
    a.download = `${r.title.replace(/[\\/:*?"<>|]/g, "-")}.webm`;
    a.click();
  } finally {
    $("record").disabled = false;
    render();
    afterStop?.();
  }
}

// Testa os dois canais por 5 s, sem gravar.
async function testAudio(seconds = 5) {
  showError(null);
  const capture = await openCapture(settings.mic);
  let maxSystem = 0, maxMic = 0;
  await new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const s = capture.levelSystem(), m = capture.levelMic();
      maxSystem = Math.max(maxSystem, s);
      maxMic = Math.max(maxMic, m);
      $("lvl-system").value = scale(s);
      $("lvl-mic").value = scale(m);
      if (Date.now() - started >= seconds * 1000) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
  capture.close();
  $("lvl-system").value = 0;
  $("lvl-mic").value = 0;
  return { maxSystem, maxMic, source: capture.source };
}

// ---------------- interface ----------------
function render() {
  $("mic").checked = settings.mic;
  $("silence").value = String(settings.silenceMinutes);
  $("login-item").hidden = settings.openAtLogin === null;
  $("openAtLogin").checked = !!settings.openAtLogin;
  $("record").textContent = rec ? "■ Parar e enviar" : "● Gravar reunião";
  $("record").classList.toggle("stop", !!rec);
  $("test").disabled = !!rec;
}

$("record").addEventListener("click", () => (rec ? stop() : start()).catch(showError));
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  try {
    const r = await testAudio();
    $("status").textContent =
      r.maxSystem > 0.002
        ? `✓ Som do computador capturado${r.source ? ` (${r.source})` : ""}.`
        : `Nenhum som do computador${r.source ? ` em “${r.source}”` : ""}. Toque algo (um vídeo) durante o teste.`;
  } catch (e) {
    showError(e);
  } finally {
    $("test").disabled = false;
  }
});
$("mic").addEventListener("change", async (e) => (settings = await api.setSettings({ mic: e.target.checked })));
$("silence").addEventListener("change", async (e) => (settings = await api.setSettings({ silenceMinutes: Number(e.target.value) })));
$("openAtLogin").addEventListener("change", async (e) => (settings = await api.setSettings({ openAtLogin: e.target.checked })));
$("open").addEventListener("click", (e) => (e.preventDefault(), api.open("/")));

api.onCommand(async (cmd) => {
  if (cmd === "start") start().catch(showError);
  if (cmd === "stop") stop().catch(showError);
  if (cmd === "stop-and-quit") {
    afterStop = () => api.quitNow();
    stop("O app foi fechado.").catch(showError);
  }
  if (cmd === "selftest") {
    try {
      settings.mic = false;
      const result = await testAudio(5);
      const devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => `${d.kind}: ${d.label}`);
      api.selftestResult({ ok: true, ...result, devices });
    } catch (e) {
      api.selftestResult({ ok: false, error: e.message });
    }
  }
});

settings = await api.getSettings();
render();
