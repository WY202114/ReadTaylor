import providerPresets from "../../electron/translation/presets.json";

export type TranslationProviderId = "deepseek" | "qwen" | "kimi" | "zhipu" | "openrouter" | "ollama" | "custom";
export interface TranslationConfig {
  providerId: TranslationProviderId;
  protocol: "openai-compatible";
  endpoint: string;
  model: string;
  targetLanguage: string;
  temperature: number | null;
}
export interface TranslationProfile extends TranslationConfig { hasKey: boolean; keyOrigins?: string[] }
export interface TranslationPreset { id: TranslationProviderId; label: string; endpoint: string; model: string; docs: string; note: string }
export interface TranslationSettingsSnapshot { activeProviderId: TranslationProviderId; profiles: TranslationProfile[] }
export interface TranslationSettingsData extends TranslationSettingsSnapshot { presets: TranslationPreset[]; languages: Record<string, string> }
export type TranslationIPCResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string };
export interface TranslationSegment { id: string; text: string }
export interface TranslationBatch { providerId?: TranslationProviderId; segments: TranslationSegment[] }
export interface TranslationBatchPreview {
  previewId: string; providerId: TranslationProviderId; domain: string; endpoint: string; local: boolean;
  model: string; targetLanguage: string; characterCount: number; notice: string; temperatureNotice: string;
}
export interface TranslationBatchResult {
  translations: TranslationSegment[]; targetLanguage: string; characterCount: number; attempts: number; warnings: string[];
}

export const TRANSLATION_PRESETS = providerPresets as TranslationPreset[];
export function defaultTranslationSettings(): TranslationSettingsData {
  return {
    activeProviderId: "deepseek", presets: TRANSLATION_PRESETS,
    languages: { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语" },
    profiles: TRANSLATION_PRESETS.map((preset) => ({ providerId: preset.id, protocol: "openai-compatible", endpoint: preset.endpoint, model: preset.model, targetLanguage: "zh-Hans", temperature: preset.id === "kimi" ? null : 0.2, hasKey: false })),
  };
}
export async function unwrapTranslationIPC<T>(request: Promise<TranslationIPCResult<T>> | undefined): Promise<T> {
  if (!request) throw new Error("此功能需要 ReadTaylor 桌面版；网页不会保存 Key 或直接发送大模型请求。");
  const result = await request;
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result.data;
}
/** Preparation never sends text over the network. send opens a native confirmation in Electron. */
export function previewDesktopTranslationBatch(batch: TranslationBatch): Promise<TranslationBatchPreview> {
  return unwrapTranslationIPC(window.readTaylorDesktop?.previewTranslationBatch(batch));
}
export function sendDesktopTranslationBatch(previewId: string): Promise<TranslationBatchResult> {
  return unwrapTranslationIPC(window.readTaylorDesktop?.sendTranslationBatch(previewId));
}
export function translationDestination(endpoint: string): { domain: string; local: boolean } | null {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { domain: url.host, local: host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host) };
  } catch { return null; }
}
