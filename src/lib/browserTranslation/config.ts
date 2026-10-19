import presets from "./presets.json";

export type ProviderId = "deepseek" | "qwen" | "kimi" | "zhipu" | "openrouter" | "ollama" | "custom";
export interface TranslationConfig {
  providerId: ProviderId;
  protocol: "openai-compatible";
  endpoint: string;
  model: string;
  targetLanguage: string;
  temperature: number | null;
}
export interface Segment { id: string; text: string }
export interface TranslationResult { translations: Segment[]; targetLanguage: string; characterCount: number; attempts: number; warnings: string[] }
export interface Preset { id: ProviderId; label: string; endpoint: string; model: string; docs: string; note: string }
export const PRESETS = presets as Preset[];
export const LANGUAGES: Record<string, string> = { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" };
const translationErrorBrand = Symbol.for("readtaylor.browser-translation.error.v1");
export class TranslationError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message); this.name = "TranslationError";
    Object.defineProperty(this, translationErrorBrand, { value: true });
  }
  // Vite hot reload can retain a provider/store instance while replacing this class module.
  // A stable private brand keeps our sanitized errors recognizable across that boundary.
  static [Symbol.hasInstance](value: unknown) {
    return typeof value === "object" && value !== null && Object.getOwnPropertyDescriptor(value, translationErrorBrand)?.value === true;
  }
}
export function readableError(error: unknown): string {
  // Never expose arbitrary fetch exceptions or provider payloads: either can contain credentials.
  return error instanceof TranslationError ? error.message : "操作失败，请检查浏览器存储权限和接口设置后重试。";
}
export function defaultConfig(providerId: ProviderId): TranslationConfig {
  const preset = PRESETS.find((p) => p.id === providerId);
  if (!preset) throw new TranslationError("CONFIG", "请选择有效的服务商预设。");
  return { providerId, protocol: "openai-compatible", endpoint: preset.endpoint, model: preset.model, targetLanguage: "zh-Hans", temperature: providerId === "kimi" ? null : 0.2 };
}
export function endpointInfo(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new TranslationError("CONFIG", "接口地址无效，请填写完整的 http:// 或 https:// 地址。"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new TranslationError("CONFIG", "接口地址只能包含协议、域名和路径，请勿在地址中填写 Key、账号或查询参数。");
  if (url.protocol !== "https:" && !local) throw new TranslationError("CONFIG", "接口必须使用 HTTPS；仅 localhost 和 127.0.0.1 允许 HTTP 本机连接。");
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath;
  const endpoint = url.href.replace(/\/$/, "");
  if (!basePath.endsWith("/chat/completions")) url.pathname = `${basePath}/chat/completions`;
  return { endpoint, requestURL: url.href, origin: url.origin, domain: url.host, local };
}
export function normalizeConfig(input: TranslationConfig): TranslationConfig {
  if (!input || input.protocol !== "openai-compatible" || !PRESETS.some((p) => p.id === input.providerId)) throw new TranslationError("CONFIG", "目前仅支持 OpenAI 兼容协议，请重新选择服务商。");
  const info = endpointInfo(input.endpoint.trim());
  const model = input.model.trim();
  if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new TranslationError("CONFIG", "请填写有效的模型名称，并与服务商官方文档核对。");
  if (!Object.prototype.hasOwnProperty.call(LANGUAGES, input.targetLanguage)) throw new TranslationError("CONFIG", "请选择支持的目标语言。");
  const temperature = input.temperature == null ? null : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new TranslationError("CONFIG", "温度请填写 0–2 之间的数字，翻译建议 0–0.3，也可以留空。");
  if (input.providerId === "ollama" && /(?::cloud|-cloud)(?:$|\b)/i.test(model)) throw new TranslationError("CONFIG", "本地 Ollama 预设请使用已下载的本地模型，不能使用云模型标签。");
  // Allowlist fields so a Key accidentally supplied by a caller never enters metadata/cache keys.
  return { providerId: input.providerId, protocol: "openai-compatible", endpoint: info.endpoint, model, targetLanguage: input.targetLanguage, temperature };
}
export function fixedTemperature(config: TranslationConfig) {
  return /^api\.moonshot\.(cn|ai)$/.test(new URL(config.endpoint).hostname) && /^kimi-(k3(?:$|-)|k2\.(?:6|7)(?:$|-))/i.test(config.model);
}
export function privacyNotice(endpoint: string) {
  const info = endpointInfo(endpoint);
  return `所选正文及必要上下文将由你的浏览器直接发送给 ${info.domain}，按该服务商计费。默认不发送图片、表格内部、公式和参考文献。`;
}
