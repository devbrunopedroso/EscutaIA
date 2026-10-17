const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("escutaia", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  micAccess: () => ipcRenderer.invoke("mic:access"),
  upload: (audio, meta) => ipcRenderer.invoke("upload", { audio, meta }),
  open: (pathname) => ipcRenderer.invoke("open", pathname),
  recordingState: (state) => ipcRenderer.send("recording:state", state),
  quitNow: () => ipcRenderer.send("quit-now"),
  selftestResult: (result) => ipcRenderer.send("selftest:result", result),
  onCommand: (fn) => ipcRenderer.on("command", (_e, cmd) => fn(cmd)),
});
