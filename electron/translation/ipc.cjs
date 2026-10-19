const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { presets, LANGUAGES, endpointInfo, publicError, presetFor, TranslationError } = require("./config.cjs");
const { createTranslationService } = require("./service.cjs");

function installTranslationIPC({ ipcMain, BrowserWindow, dialog, store, getMainWindow, requireTrustedSender, serviceOptions = {} }) {
  let keyPrompt;
  const confirmSend = async (preview) => {
    const result = await dialog.showMessageBox(getMainWindow(), {
      type: "question", title: "确认发送翻译批次", message: `本批约 ${preview.characterCount} 字符 · 发送至 ${preview.domain}`,
      detail: `${preview.notice}\n接口：${preview.endpoint}\n模型：${preview.model}\n目标语言：${preview.targetLanguage}\n必要时会兼容性重发，失败最多自动重试 2 次，可能产生额外调用。`,
      buttons: ["取消", "发送本批"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  };
  const service = createTranslationService({ store, confirmSend, ...serviceOptions });
  function trustedMain(event) {
    requireTrustedSender(event);
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new TranslationError("SENDER", "仅允许 ReadTaylor 主页面调用翻译设置与批次接口。");
  }
  function register(channel, operation, guard = trustedMain) {
    ipcMain.handle(channel, async (event, ...args) => {
      try { guard(event); return { ok: true, data: await operation(...args) }; }
      catch (error) { return publicError(error); }
    });
  }
  function trustedKeyWindow(event) {
    if (!keyPrompt || event.sender !== keyPrompt.window.webContents || event.senderFrame !== event.sender.mainFrame) throw new TranslationError("SENDER", "只允许独立 Key 录入窗口提交密钥。");
  }
  register("readtaylor:translation:settings", () => ({ ...store.snapshot(), presets, languages: LANGUAGES }));
  register("readtaylor:translation:save", (config) => { const result = store.save(config); service.invalidate(); return result; });
  register("readtaylor:translation:clear", () => {
    service.cancelAll();
    keyPrompt?.window.close();
    return store.clear();
  });
  register("readtaylor:translation:preview", (batch) => service.preview(batch));
  register("readtaylor:translation:send", (previewId) => {
    if (typeof previewId !== "string") throw new TranslationError("BATCH", "请先获取有效的发送预览。");
    return service.send(previewId);
  });
  register("readtaylor:translation:edit-key", async (config) => {
    if (keyPrompt) { keyPrompt.window.focus(); throw new TranslationError("BUSY", "请先完成或关闭当前 Key 录入窗口。"); }
    store.save(config, { requireKey: false });
    service.invalidate();
    const info = endpointInfo(config.endpoint);
    const keyFile = path.join(__dirname, "key-entry.html");
    const window = new BrowserWindow({
      parent: getMainWindow(), modal: true, width: 460, height: 420, resizable: false, autoHideMenuBar: true,
      title: "安全录入 API Key", show: false, backgroundColor: "#f7f6f2",
      webPreferences: { preload: path.join(__dirname, "key-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, partition: "readtaylor-key-entry" },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== pathToFileURL(keyFile).href) event.preventDefault(); });
    const completion = new Promise((resolve) => {
      keyPrompt = { window, providerId: config.providerId, origin: info.origin, domain: info.domain, label: presetFor(config.providerId).label, saved: false };
      const prompt = keyPrompt;
      window.on("closed", () => { if (keyPrompt === prompt) keyPrompt = undefined; resolve({ ...store.snapshot(), keySaved: prompt.saved }); });
    });
    window.once("ready-to-show", () => window.show());
    try { await window.loadFile(keyFile); } catch { window.close(); throw new TranslationError("KEY_WINDOW", "Key 录入窗口无法打开，请重新启动桌面版后重试。"); }
    return completion;
  });
  register("readtaylor:translation:key-context", () => ({ domain: keyPrompt.domain, label: keyPrompt.label }), trustedKeyWindow);
  register("readtaylor:translation:key-submit", (key) => {
    store.setKey(keyPrompt.providerId, keyPrompt.origin, key);
    service.invalidate();
    keyPrompt.saved = true;
    const window = keyPrompt.window;
    setImmediate(() => { if (!window.isDestroyed()) window.close(); });
    return true;
  }, trustedKeyWindow);
  register("readtaylor:translation:key-cancel", () => { keyPrompt.window.close(); return true; }, trustedKeyWindow);
  return { service };
}
module.exports = { installTranslationIPC };
