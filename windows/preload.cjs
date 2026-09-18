const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cma", {
  call(command, args = [], input = null) {
    return ipcRenderer.invoke("cma:call", { command, args, input });
  },
  openDataDir() {
    return ipcRenderer.invoke("cma:open-data-dir");
  },
  platform() {
    return ipcRenderer.invoke("cma:platform");
  }
});
