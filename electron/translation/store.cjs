const fs = require("node:fs");
const { presets, TranslationError, defaultConfig, normalizeConfig, endpointInfo, requiresKey } = require("./config.cjs");

function createTranslationStore({ filePath, safeStorage, platform = process.platform }) {
  let state;
  function load() {
    if (state) return state;
    const initial = { version: 1, activeProviderId: "deepseek", profiles: {} };
    if (!fs.existsSync(filePath)) return state = initial;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") throw new Error();
      initial.activeProviderId = presets.some((p) => p.id === parsed.activeProviderId) ? parsed.activeProviderId : "deepseek";
      for (const preset of presets) {
        const entry = parsed.profiles[preset.id];
        if (!entry) continue;
        const config = normalizeConfig({ ...entry.config, providerId: preset.id });
        const keys = {};
        for (const [origin, encrypted] of Object.entries(entry.keys || {})) {
          if (endpointInfo(origin).origin === origin && typeof encrypted === "string" && /^[A-Za-z0-9+/]+=*$/.test(encrypted) && encrypted.length < 20000) keys[origin] = encrypted;
        }
        initial.profiles[preset.id] = { config, keys };
      }
      return state = initial;
    } catch { throw new TranslationError("STORAGE", "翻译配置文件无法读取。请先备份配置文件，再使用“清除全部翻译配置”重新设置。"); }
  }
  function commit(next) {
    const temporary = `${filePath}.tmp`;
    try {
      fs.mkdirSync(require("node:path").dirname(filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, filePath);
      state = next;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* No temporary file. */ }
      throw new TranslationError("STORAGE", "无法保存翻译配置，请检查本机存储空间和文件权限。");
    }
  }
  function entryFor(id) { defaultConfig(id); return load().profiles[id] || { config: defaultConfig(id), keys: {} }; }
  function hasKey(entry) { try { return Boolean(entry.keys[endpointInfo(entry.config.endpoint).origin]); } catch { return false; } }
  function snapshot() {
    return { activeProviderId: load().activeProviderId, profiles: presets.map((p) => { const entry = entryFor(p.id); return { ...entry.config, hasKey: hasKey(entry), keyOrigins: Object.keys(entry.keys) }; }) };
  }
  function save(input, { requireKey = true } = {}) {
    const config = normalizeConfig(input);
    const previous = entryFor(config.providerId);
    if (requireKey && requiresKey(config) && !previous.keys[endpointInfo(config.endpoint).origin]) throw new TranslationError("KEY_REQUIRED", "这个接口需要 API Key，请先点击“录入 API Key”。");
    const current = load();
    commit({ ...current, activeProviderId: config.providerId, profiles: { ...current.profiles, [config.providerId]: { config, keys: { ...previous.keys } } } });
    return snapshot();
  }
  function assertEncryption() {
    if (!safeStorage.isEncryptionAvailable() || platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new TranslationError("ENCRYPTION", "系统安全存储不可用，未保存 Key。请启用系统钥匙串或凭据服务后重试。");
    }
  }
  function setKey(id, origin, key) {
    assertEncryption();
    if (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\r\n\x00]/.test(key)) throw new TranslationError("KEY_REQUIRED", "请粘贴完整的 API Key，避免包含换行。");
    const entry = entryFor(id);
    if (endpointInfo(entry.config.endpoint).origin !== origin) throw new TranslationError("CONFIG_CHANGED", "接口已更改，请关闭录入窗口后重新录入 Key。");
    let encrypted;
    try { encrypted = safeStorage.encryptString(key.trim()).toString("base64"); } catch { throw new TranslationError("ENCRYPTION", "系统无法加密 Key，未保存。请检查系统凭据服务后重试。"); }
    const current = load();
    commit({ ...current, profiles: { ...current.profiles, [id]: { config: entry.config, keys: { ...entry.keys, [origin]: encrypted } } } });
    return snapshot();
  }
  function resolve(id = load().activeProviderId) {
    const entry = entryFor(id);
    const config = normalizeConfig(entry.config);
    const encrypted = entry.keys[endpointInfo(config.endpoint).origin];
    if (!encrypted && requiresKey(config)) throw new TranslationError("KEY_REQUIRED", "尚未配置 API Key，请到翻译设置中录入后再发送。");
    let apiKey = "";
    if (encrypted) {
      assertEncryption();
      try { apiKey = safeStorage.decryptString(Buffer.from(encrypted, "base64")); } catch { throw new TranslationError("ENCRYPTION", "无法解密已保存的 Key，请重新录入 API Key。"); }
    }
    return { ...config, apiKey };
  }
  function fingerprint(id) { return require("node:crypto").createHash("sha256").update(JSON.stringify(entryFor(id))).digest("hex"); }
  function clear() {
    try { fs.rmSync(filePath, { force: true }); fs.rmSync(`${filePath}.tmp`, { force: true }); }
    catch { throw new TranslationError("STORAGE", "无法清除翻译配置，请检查文件权限后重试。"); }
    state = undefined;
    return snapshot();
  }
  return { snapshot, save, setKey, resolve, fingerprint, clear };
}
module.exports = { createTranslationStore };
