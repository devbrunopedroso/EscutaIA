// Ponte para o site do EscutaIA quando ele roda dentro do app: botão "Gravar" e
// abrir o gravador. No navegador comum, window.escutaiaDesktop não existe.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("escutaiaDesktop", {
  openRecorder: () => ipcRenderer.invoke("recorder:open"),
  startRecording: () => ipcRenderer.invoke("recorder:start"),
});
