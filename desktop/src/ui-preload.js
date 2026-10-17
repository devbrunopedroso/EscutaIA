// Ponte para o site do EscutaIA quando ele roda dentro do app: botão "Gravar" e
// abrir o gravador. No navegador comum, window.escutaiaDesktop não existe.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("escutaiaDesktop", {
  platform: process.platform,
  openRecorder: () => ipcRenderer.invoke("recorder:open"),
  startRecording: () => ipcRenderer.invoke("recorder:start"),
  stopRecording: () => ipcRenderer.invoke("recorder:stop"),
  getRecordingState: () => ipcRenderer.invoke("recording:get"),
  onRecordingState: (fn) => {
    const handler = (_e, state) => fn(state);
    ipcRenderer.on("recording-state", handler);
    return () => ipcRenderer.removeListener("recording-state", handler);
  },
});
