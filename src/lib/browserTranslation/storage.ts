import { defaultConfig, endpointInfo, normalizeConfig, PRESETS, TranslationError, type ProviderId, type TranslationConfig } from "./config";

export const STORAGE_PREFIX = "readtaylor.llm.v1.";
const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
export type ConnectionState = "untested" | "available" | "unavailable";
export interface ConnectionTest { state: Exclude<ConnectionState, "untested">; endpoint: string; model: string; testedAt: number; code?: string }
interface Settings { activeProviderId: ProviderId; profiles: TranslationConfig[]; tests: Partial<Record<ProviderId, ConnectionTest>> }
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Dedicated namespaces only. Never uses book storage, IndexedDB or translated-text caches. */
export class BrowserTranslationStore {
  private revision = 0;
  constructor(private session: StorageLike, private persistent: StorageLike) {}
  private read(storage: StorageLike, key: string) {
    try { return storage.getItem(key); } catch { throw new TranslationError("STORAGE", "浏览器不允许访问翻译配置存储。请检查网站存储权限或隐私模式设置。"); }
  }
  private write(storage: StorageLike, key: string, value: string | null) {
    try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); }
    catch { throw new TranslationError("STORAGE", "翻译配置保存或清除失败。请检查浏览器存储权限和可用空间；不要在失败时关闭页面。"); }
  }
  load(): Settings {
    const defaults: Settings = { activeProviderId: "deepseek", profiles: PRESETS.map((p) => defaultConfig(p.id)), tests: {} };
    const serialized = this.read(this.persistent, SETTINGS_KEY);
    if (!serialized) return defaults;
    try {
      const raw = JSON.parse(serialized);
      for (const item of raw.profiles ?? []) {
        try { const config = normalizeConfig(item); defaults.profiles = defaults.profiles.map((p) => p.providerId === config.providerId ? config : p); } catch { /* Ignore corrupt public configuration, never echo its contents. */ }
      }
      if (PRESETS.some((p) => p.id === raw.activeProviderId)) defaults.activeProviderId = raw.activeProviderId;
      for (const preset of PRESETS) {
        const saved = raw.tests?.[preset.id];
        if (saved && ["available", "unavailable"].includes(saved.state) && typeof saved.endpoint === "string" && typeof saved.model === "string" && Number.isFinite(saved.testedAt)) {
          // Reconstruct public fields; never propagate arbitrary data from storage into UI/errors.
          defaults.tests[preset.id] = { state: saved.state, endpoint: endpointInfo(saved.endpoint).endpoint, model: saved.model, testedAt: saved.testedAt, code: typeof saved.code === "string" && /^[A-Z_]+$/.test(saved.code) ? saved.code : undefined };
        }
      }
    } catch { /* A malformed settings file falls back to defaults. */ }
    return defaults;
  }
  saveConfig(input: TranslationConfig) {
    const config = normalizeConfig(input);
    const settings = this.load();
    settings.activeProviderId = config.providerId;
    settings.profiles = settings.profiles.map((p) => p.providerId === config.providerId ? config : p);
    this.write(this.persistent, SETTINGS_KEY, JSON.stringify(settings));
    this.revision++;
    return config;
  }
  private credentialKey(providerId: ProviderId, endpoint: string) {
    if (!PRESETS.some((p) => p.id === providerId)) throw new TranslationError("CONFIG", "服务商预设无效。");
    return `${STORAGE_PREFIX}credential.${providerId}.${encodeURIComponent(endpointInfo(endpoint).origin)}`;
  }
  getKey(providerId: ProviderId, endpoint: string): { apiKey: string; remember: boolean } {
    const name = this.credentialKey(providerId, endpoint);
    const sessionKey = this.read(this.session, name);
    if (sessionKey !== null) return { apiKey: sessionKey, remember: false };
    const remembered = this.read(this.persistent, name);
    return { apiKey: remembered ?? "", remember: remembered !== null };
  }
  setKey(providerId: ProviderId, endpoint: string, input: string, remember: boolean) {
    const name = this.credentialKey(providerId, endpoint);
    const key = input.trim();
    if (key.length > 4096 || /[\r\n\x00-\x1f]/.test(key)) throw new TranslationError("KEY_INVALID", "Key 格式无效，请去除换行后重新录入。");
    const existing = this.getKey(providerId, endpoint);
    const target = remember ? this.persistent : this.session;
    const other = remember ? this.session : this.persistent;
    if (existing.apiKey === key && (existing.remember === remember || !key) && this.read(other, name) === null) return;
    // Write before removing the old copy, so a quota error never silently loses the Key.
    this.write(target, name, key || null);
    this.write(other, name, null);
    this.revision++;
    this.clearTest(providerId);
    // TODO: optional WebCrypto passphrase-encrypted persistence; never persist the passphrase.
  }
  resolve(providerId: ProviderId) {
    const config = this.load().profiles.find((p) => p.providerId === providerId)!;
    const normalized = normalizeConfig(config);
    const { apiKey } = this.getKey(providerId, normalized.endpoint);
    if (!endpointInfo(normalized.endpoint).local && !apiKey) throw new TranslationError("KEY_REQUIRED", "此远程接口需要 API Key，请先录入并保存。");
    return { ...normalized, apiKey };
  }
  token() { return this.revision; }
  connectionState(config: TranslationConfig): ConnectionState {
    const test = this.load().tests[config.providerId];
    try { return test?.endpoint === endpointInfo(config.endpoint).endpoint && test.model === config.model.trim() ? test.state : "untested"; }
    catch { return "untested"; }
  }
  recordTest(config: TranslationConfig, state: "available" | "unavailable", code?: string) {
    const settings = this.load();
    settings.tests[config.providerId] = { state, endpoint: endpointInfo(config.endpoint).endpoint, model: config.model.trim(), testedAt: Date.now(), ...(code && /^[A-Z_]+$/.test(code) ? { code } : {}) };
    this.write(this.persistent, SETTINGS_KEY, JSON.stringify(settings));
  }
  private clearTest(providerId: ProviderId) {
    const settings = this.load();
    delete settings.tests[providerId];
    this.write(this.persistent, SETTINGS_KEY, JSON.stringify(settings));
  }
  clear() {
    for (const storage of [this.session, this.persistent]) {
      try {
        const owned = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => !!key?.startsWith(STORAGE_PREFIX));
        for (const key of owned) this.write(storage, key, null);
      } catch { throw new TranslationError("STORAGE", "未能完整清除翻译配置。请在浏览器的网站数据设置中清除本站数据，并重新打开页面。"); }
    }
    this.revision++;
  }
}
export function createBrowserTranslationStore() {
  try { return new BrowserTranslationStore(window.sessionStorage, window.localStorage); }
  catch { throw new TranslationError("STORAGE", "浏览器存储不可用，请允许此网站保存本地数据后重试。"); }
}
