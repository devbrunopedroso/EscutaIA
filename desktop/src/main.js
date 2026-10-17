// EscutaIA desktop: o EscutaIA completo, rodando no computador da pessoa.
//  - Servidor local (API + banco PGlite + transcrição + identificação de falantes + Claude)
//    num processo separado, escutando só em 127.0.0.1:47821. A extensão do Chrome envia as
//    gravações para ele.
//  - Janela principal: o site do EscutaIA (reuniões, busca, perguntas).
//  - Gravador: grava o som do computador + microfone (Zoom/Teams/Meet desktop, WhatsApp…).
//
// Som do sistema no gravador (ver README):
//  - Windows: getDisplayMedia + audio "loopback" (WASAPI).
//  - macOS 14.2+: getDisplayMedia + "loopback" via CoreAudio Tap; exige a chave
//    NSAudioCaptureUsageDescription no Info.plist (package.json → build.mac).
//  - Linux: getDisplayMedia + "loopback" via PulseAudio/PipeWire (testado em Debian 12).
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  session,
  desktopCapturer,
  Notification,
  shell,
  systemPreferences,
  nativeImage,
  dialog,
} = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const PORTS = [47821, 47822, 47823, 47824, 47825]; // a extensão procura o app nessas portas
const selftestOut = process.argv.find((a) => a.startsWith("--selftest="))?.slice("--selftest=".length);

// Testes automatizados: pasta de dados separada (não mexe nos dados da pessoa).
if (process.env.ESCUTAIA_USER_DATA) app.setPath("userData", process.env.ESCUTAIA_USER_DATA);
// O app se chamava "MeetNotes": na 1ª abertura como EscutaIA, traz as reuniões,
// modelos e configurações da pasta antiga.
else {
  const oldDir = path.join(app.getPath("appData"), "MeetNotes");
  const newDir = app.getPath("userData");
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
    } catch (e) {
      console.error("não consegui migrar os dados do MeetNotes:", e);
    }
  }
}

// ---------------- configurações ----------------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = { mic: true, silenceMinutes: 5, localToken: null };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    // primeira execução
  }
  // Token da API local: só a janela do app e as extensões aprovadas o recebem.
  if (!settings.localToken) {
    settings.localToken = crypto.randomBytes(32).toString("base64url");
    saveSettings();
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  // Versões antigas guardavam login de servidor aqui; não servem mais.
  const { server: _s, user: _u, tokenEnc: _t, tokenPlain: _p, ...keep } = settings;
  fs.writeFileSync(settingsFile(), JSON.stringify(keep, null, 2), { mode: 0o600 });
}

// ---------------- servidor local ----------------
let server = null;
let serverPort = null;
let quitting = false;
let restarts = 0;

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });

// Apps abertos pelo Finder/Menu Iniciar não herdam o PATH do terminal: procura o Claude Code.
function findClaude() {
  const home = os.homedir();
  const candidates = isWin
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA ?? "", "npm", "claude.cmd")]
    : [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude", path.join(home, ".npm-global", "bin", "claude")];
  return candidates.find((p) => fs.existsSync(p)) ?? "claude";
}

// O servidor roda num Node.js oficial que vai dentro do app (build/fetch-node.mjs): o
// sherpa-onnx usa "external buffers", que o V8 do Electron proíbe.
function nodePath() {
  const exe = isWin ? "node.exe" : "node";
  if (app.isPackaged) return path.join(process.resourcesPath, "node", exe);
  const osName = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
  const dev = path.join(ROOT, "build", "node", `${osName}-${process.arch}`, exe);
  return fs.existsSync(dev) ? dev : "node";
}

function ffmpegPath() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

async function startServer() {
  if (!serverPort) {
    for (const p of PORTS) {
      if (await portFree(p)) {
        serverPort = p;
        break;
      }
    }
    if (!serverPort) throw new Error(`as portas ${PORTS.join(", ")} estão ocupadas`);
  }
  const data = app.getPath("userData");
  const logFile = fs.createWriteStream(path.join(data, "server.log"), { flags: "a" });
  server = spawn(nodePath(), [path.join(ROOT, "server", "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ESCUTAIA_LOCAL: "1",
      PORT: String(serverPort),
      LOCAL_TOKEN: settings.localToken,
      LOCAL_USER_NAME: os.userInfo().username,
      APP_VERSION: app.getVersion(),
      PGLITE_DIR: path.join(data, "db"),
      DATA_DIR: path.join(data, "data"),
      WHISPER_MODELS_DIR: path.join(data, "models"),
      WEB_DIST: path.join(ROOT, "web"),
      COMPUTE_ENTRY: path.join(ROOT, "server", "compute.mjs"),
      FFMPEG_PATH: ffmpegPath(),
      CLAUDE_BIN: findClaude(),
    },
  });
  server.stdout?.pipe(logFile);
  server.stderr?.pipe(logFile);
  server.on("message", onServerMessage);
  server.on("error", (e) => dialog.showErrorBox("EscutaIA", `Não consegui iniciar o servidor local: ${e.message}`));
  server.on("exit", (code) => {
    server = null;
    if (quitting) return;
    // Caiu: reinicia (com limite, para não ficar em loop se algo estiver quebrado).
    if (++restarts <= 5) setTimeout(() => startServer().catch(console.error), 1000 * restarts);
    else dialog.showErrorBox("EscutaIA", `O servidor local parou (código ${code}). Veja ${path.join(data, "server.log")}.`);
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("o servidor local não respondeu");
}

async function onServerMessage(msg) {
  if (msg?.type === "pair-request") {
    // A extensão pediu para se conectar: a pessoa aprova aqui (um site não consegue).
    if (process.env.ESCUTAIA_E2E_AUTO_PAIR === "1") return server?.send({ type: "pair-reply", id: msg.id, allow: true });
    showMain();
    const { response } = await dialog.showMessageBox(mainWin, {
      type: "question",
      buttons: ["Permitir", "Recusar"],
      defaultId: 0,
      cancelId: 1,
      message: "Conectar a extensão do Chrome ao EscutaIA?",
      detail: `${msg.name} quer enviar gravações de reuniões para este app.\n\nSe não foi você que clicou em “Conectar” na extensão agora, clique em Recusar.`,
    });
    server?.send({ type: "pair-reply", id: msg.id, allow: response === 0 });
  }
  if (msg?.type === "meeting-ready") {
    const n = new Notification({
      title: "Reunião pronta ✓",
      body: `“${msg.title}” foi transcrita${msg.summary ? " e resumida" : ""}. Clique para abrir.`,
      icon: path.join(ASSETS, "icon.png"),
    });
    n.on("click", () => showMain(`/meetings/${msg.id}`));
    n.show();
  }
}

// ---------------- janelas e bandeja ----------------
let mainWin = null;
let recorderWin = null;
let tray = null;
let recording = false;

const uiUrl = (pathname = "/") =>
  `http://127.0.0.1:${serverPort}${pathname}${pathname.includes("?") ? "&" : "?"}t=${encodeURIComponent(settings.localToken)}`;

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "EscutaIA",
    icon: path.join(ASSETS, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "ui-preload.js"), contextIsolation: true, sandbox: true },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL(uiUrl());
  mainWin.once("ready-to-show", () => {
    if (!app.getLoginItemSettings().wasOpenedAsHidden && !selftestOut) mainWin.show();
  });
  // Links externos (ex.: platform.claude.com) abrem no navegador.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

function showMain(pathname) {
  if (!mainWin) createMain();
  if (pathname) mainWin.loadURL(uiUrl(pathname));
  mainWin.show();
  mainWin.focus();
}

function createRecorder(show = true) {
  if (recorderWin) {
    if (show) {
      recorderWin.show();
      recorderWin.focus();
    }
    return recorderWin;
  }
  recorderWin = new BrowserWindow({
    width: 360,
    height: 520,
    resizable: false,
    show: show && !selftestOut,
    title: "EscutaIA — Gravador",
    icon: path.join(ASSETS, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      // Gravando com a janela escondida, o timer e o MediaRecorder não podem dormir.
      backgroundThrottling: false,
    },
  });
  recorderWin.setMenuBarVisibility(false);
  recorderWin.loadFile(path.join(__dirname, "recorder.html"));
  recorderWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      recorderWin.hide();
    }
  });
  return recorderWin;
}

function sendToRecorder(cmd) {
  const w = createRecorder(false);
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", () => w.webContents.send("command", cmd));
  else w.webContents.send("command", cmd);
}

function trayIcon() {
  const name = recording ? "trayRecording" : isMac ? "trayTemplate" : "tray";
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  if (isMac && !recording) img.setTemplateImage(true);
  return img;
}

function updateTray(elapsed) {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(recording ? `EscutaIA — gravando ${elapsed ?? ""}` : "EscutaIA");
  if (isMac) tray.setTitle(recording && elapsed ? ` ${elapsed}` : "");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      recording
        ? { label: "■ Parar e enviar", click: () => sendToRecorder("stop") }
        : { label: "● Gravar reunião do computador", click: () => sendToRecorder("start") },
      { label: "Abrir EscutaIA", click: () => showMain() },
      { label: "Gravador", click: () => createRecorder(true) },
      { type: "separator" },
      { label: "Sair", click: () => quit() },
    ]),
  );
}

function quit() {
  if (recording) {
    // Não perde a gravação: para, envia e só então fecha.
    sendToRecorder("stop-and-quit");
    return;
  }
  quitting = true;
  app.quit();
}

// ---------------- captura do som do sistema (gravador) ----------------
function setupMediaHandlers() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  session.defaultSession.setDisplayMediaRequestHandler(
    async (req, callback) => {
      // A API exige um "vídeo". Usar o quadro da própria janela evita pedir a permissão
      // de Gravação de Tela no macOS; o gravador descarta o vídeo e fica só com o áudio.
      if (req.frame) return callback({ video: req.frame, audio: "loopback" });
      try {
        const [screen] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
        callback(screen ? { video: screen, audio: "loopback" } : null);
      } catch (e) {
        console.error("display media:", e);
        callback(null);
      }
    },
    { useSystemPicker: false },
  );
}

// ---------------- IPC ----------------
const publicSettings = () => ({
  mic: settings.mic,
  silenceMinutes: settings.silenceMinutes,
  openAtLogin: process.platform === "linux" ? null : app.getLoginItemSettings().openAtLogin,
  platform: process.platform,
  version: app.getVersion(),
});

ipcMain.handle("settings:get", () => publicSettings());

ipcMain.handle("settings:set", (_e, patch) => {
  if (typeof patch.mic === "boolean") settings.mic = patch.mic;
  if (typeof patch.silenceMinutes === "number") settings.silenceMinutes = patch.silenceMinutes;
  if (typeof patch.openAtLogin === "boolean" && process.platform !== "linux")
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, openAsHidden: true });
  saveSettings();
  return publicSettings();
});

ipcMain.handle("mic:access", async () => {
  if (!isMac) return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
});

ipcMain.on("recording:state", (_e, state) => {
  recording = !!state.recording;
  updateTray(state.elapsed);
});

// Envio para o servidor local (o token não passa pela página do gravador).
ipcMain.handle("upload", async (_e, { audio, meta }) => {
  const form = new FormData();
  form.append("title", meta.title);
  form.append("platform", "desktop");
  form.append("startedAt", meta.startedAt);
  form.append("file", new Blob([audio], { type: "audio/webm" }), "reuniao.webm");
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.localToken}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `erro ${res.status}`);
  return { id: data.id };
});

ipcMain.handle("open", (_e, pathname) => showMain(pathname));
ipcMain.handle("recorder:open", () => createRecorder(true));
ipcMain.handle("recorder:start", () => sendToRecorder("start"));

ipcMain.on("quit-now", () => {
  quitting = true;
  app.quit();
});

// Diagnóstico: `EscutaIA --selftest=/tmp/out.json` grava 5 s do som do sistema e salva os níveis.
ipcMain.on("selftest:result", (_e, result) => {
  fs.writeFileSync(selftestOut, JSON.stringify({ ...result, server: `http://127.0.0.1:${serverPort}` }, null, 2));
  quitting = true;
  app.quit();
});

// ---------------- link escutaia:// (a extensão usa para abrir o app) ----------------
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("escutaia", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("escutaia");
}
app.on("open-url", (e) => {
  e.preventDefault();
  if (app.isReady() && serverPort) showMain();
});

// ---------------- ciclo de vida ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Segunda abertura (inclusive pelo link escutaia:// no Windows/Linux): mostra a janela.
  app.on("second-instance", () => serverPort && showMain());
  app.whenReady().then(async () => {
    loadSettings();
    setupMediaHandlers();
    try {
      await startServer();
      await waitForServer();
    } catch (e) {
      dialog.showErrorBox("EscutaIA", `Não consegui iniciar o EscutaIA: ${e.message}`);
      quitting = true;
      return app.quit();
    }
    createMain();
    if (selftestOut) {
      sendToRecorder("selftest");
      return;
    }
    tray = new Tray(trayIcon());
    tray.on("click", () => showMain());
    updateTray();
  });
  app.on("activate", () => serverPort && showMain());
  // Cmd+Q, "Encerrar" no Dock ou desligar o computador: fecha de verdade (sem isso, o
  // "close" das janelas só as escondia). Gravando, envia antes.
  app.on("before-quit", (e) => {
    if (recording && !quitting) {
      e.preventDefault();
      quit();
      return;
    }
    quitting = true;
  });
  app.on("will-quit", () => server?.kill());
  app.on("window-all-closed", () => {
    // Continua na bandeja.
  });
  // Logout/desligamento no Linux e `kill`: encerra pelo mesmo caminho do Cmd+Q.
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => quit());
}
