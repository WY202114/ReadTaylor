const { contextBridge, ipcRenderer } = require("electron");

const openBookCallbacks = new Set();
const pendingOpenBooks = [];
ipcRenderer.on("readtaylor:open-books", (_event, refs) => {
  if (openBookCallbacks.size === 0) {
    pendingOpenBooks.push(...refs);
    return;
  }
  for (const callback of openBookCallbacks) callback(refs);
});

contextBridge.exposeInMainWorld("readTaylorDesktop", {
  pickBooks: () => ipcRenderer.invoke("readtaylor:pick-books"),
  prepareBook: (token, jobId) =>
    ipcRenderer.invoke("readtaylor:prepare-book", String(token), String(jobId)),
  getToolchain: () => ipcRenderer.invoke("readtaylor:get-toolchain"),
  openCalibreHelp: () => ipcRenderer.invoke("readtaylor:open-calibre-help"),
  getTranslationSettings: () => ipcRenderer.invoke("readtaylor:translation:settings"),
  saveTranslationSettings: (config) => ipcRenderer.invoke("readtaylor:translation:save", config),
  editTranslationKey: (config) => ipcRenderer.invoke("readtaylor:translation:edit-key", config),
  clearTranslationSettings: () => ipcRenderer.invoke("readtaylor:translation:clear"),
  previewTranslationBatch: (batch) => ipcRenderer.invoke("readtaylor:translation:preview", batch),
  sendTranslationBatch: (previewId) => ipcRenderer.invoke("readtaylor:translation:send", previewId),
  onConversionProgress: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on("readtaylor:conversion-progress", handler);
    return () => ipcRenderer.removeListener("readtaylor:conversion-progress", handler);
  },
  onOpenBooks: (callback) => {
    openBookCallbacks.add(callback);
    if (pendingOpenBooks.length) {
      const refs = pendingOpenBooks.splice(0, pendingOpenBooks.length);
      callback(refs);
    }
    return () => openBookCallbacks.delete(callback);
  },
});
