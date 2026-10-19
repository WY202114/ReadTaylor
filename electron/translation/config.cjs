const presets = require("./presets.json");
const LANGUAGES = Object.freeze({ "zh-Hans": "简体中文", "zh-Hant": "繁体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" });

class TranslationError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

function presetFor(id) {
  const preset = presets.find((item) => item.id === id);
  if (!preset) throw new TranslationError("CONFIG", "服务商预设无效，请重新选择。");
  return preset;
}

function endpointInfo(value) {
  let url;
  try { url = new URL(value); } catch { throw new TranslationError("CONFIG", "接口地址无效，请填写完整的 http:// 或 https:// 地址。"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = hostname === "localhost" || hostname === "::1" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) {
    throw new TranslationError("CONFIG", "接口地址只能包含协议、域名和路径，请勿在地址中填写 Key、账号或查询参数。");
  }
  if (url.protocol !== "https:" && !local) throw new TranslationError("CONFIG", "远程接口请使用 HTTPS，避免以明文传送 Key 和翻译内容。");
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath;
  const endpoint = url.href.replace(/\/$/, "");
  if (!basePath.endsWith("/chat/completions")) url.pathname = `${basePath}/chat/completions`;
  return { endpoint, requestURL: url.href, origin: url.origin, domain: url.host, local };
}

function defaultConfig(id) {
  const preset = presetFor(id);
  return { providerId: id, protocol: "openai-compatible", endpoint: preset.endpoint, model: preset.model, targetLanguage: "zh-Hans", temperature: id === "kimi" ? null : 0.2 };
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || input.protocol && input.protocol !== "openai-compatible") throw new TranslationError("CONFIG", "目前仅支持 OpenAI 兼容协议。");
  const preset = presetFor(input.providerId);
  if (typeof input.endpoint !== "string" || typeof input.model !== "string") throw new TranslationError("CONFIG", "请填写接口地址和模型名称。");
  const info = endpointInfo(input.endpoint.trim());
  const model = input.model.trim();
  if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new TranslationError("CONFIG", "请填写有效的模型名称，并与服务商官方文档核对。");
  if (!Object.hasOwn(LANGUAGES, input.targetLanguage)) throw new TranslationError("CONFIG", "请选择支持的目标语言。");
  const temperature = input.temperature == null || input.temperature === "" ? null : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new TranslationError("CONFIG", "温度请填写 0–2 之间的数字，翻译建议使用 0–0.3，也可以留空。");
  if (preset.id === "ollama" && /(?::cloud|-cloud)(?:$|\b)/i.test(model)) throw new TranslationError("CONFIG", "本地 Ollama 预设请使用已下载的本地模型，不能使用云模型标签。");
  return { providerId: preset.id, protocol: "openai-compatible", endpoint: info.endpoint, model, targetLanguage: input.targetLanguage, temperature };
}

function requiresKey(config) { return !(config.providerId === "ollama" && endpointInfo(config.endpoint).local); }
function fixedTemperature(config) {
  return /^api\.moonshot\.(cn|ai)$/.test(new URL(config.endpoint).hostname) && /^kimi-(k3(?:$|-)|k2\.(?:6|7)(?:$|-))/i.test(config.model);
}
function destinationNotice(info) {
  return info.local
    ? `实际接口：${info.domain}。使用本地模型时，内容不会离开本机；若本地服务另行转发云端，以该服务设置为准。`
    : `实际接口：${info.domain}。本批文本将发送到该接口，调用将按所选服务商计费。`;
}
function publicError(error) {
  if (error instanceof TranslationError) return { ok: false, code: error.code, error: error.message };
  return { ok: false, code: "INTERNAL", error: "翻译操作未完成，请重试；若仍失败，请检查本机配置和网络。" };
}
module.exports = { presets, LANGUAGES, TranslationError, presetFor, endpointInfo, defaultConfig, normalizeConfig, requiresKey, fixedTemperature, destinationNotice, publicError };
