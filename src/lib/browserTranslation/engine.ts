import { endpointInfo, normalizeConfig, privacyNotice, TranslationError, type ProviderId, type Segment, type TranslationConfig } from "./config";
import { OpenAICompatibleProvider, validateSegments, type TranslationProvider } from "./provider";
import { BrowserTranslationStore } from "./storage";

export interface SendPreview { domain: string; endpoint: string; local: boolean; model: string; characterCount: number; notice: string; purpose: "translation" | "connection-test" }
export type ConfirmSend = (preview: SendPreview) => boolean | Promise<boolean>;
interface Pending { config: TranslationConfig; segments: Segment[]; revision: number; createdAt: number }

/** No reader integration. The caller must present this destination/notice before sending. */
export class BrowserTranslationEngine {
  private pending = new Map<string, Pending>();
  private controllers = new Set<AbortController>();
  constructor(private store: BrowserTranslationStore, private provider: TranslationProvider = new OpenAICompatibleProvider(), private now = Date.now) {}
  private preview(config: TranslationConfig, characterCount: number, purpose: SendPreview["purpose"]): SendPreview {
    const info = endpointInfo(config.endpoint);
    return { domain: info.domain, endpoint: info.endpoint, local: info.local, model: config.model, characterCount, notice: privacyNotice(config.endpoint), purpose };
  }
  prepare(providerId: ProviderId, input: Segment[]) {
    const request = this.store.resolve(providerId), config = normalizeConfig(request);
    request.apiKey = "";
    const { segments, characterCount } = validateSegments(input);
    for (const [id, item] of this.pending) if (this.now() - item.createdAt > 300000) this.pending.delete(id);
    if (this.pending.size >= 20) throw new TranslationError("BATCH", "待确认批次过多，请先发送或取消已有批次。");
    const previewId = crypto.randomUUID();
    this.pending.set(previewId, { config, segments, revision: this.store.token(), createdAt: this.now() });
    return { previewId, ...this.preview(config, characterCount, "translation") };
  }
  private unchanged(config: TranslationConfig, revision: number) {
    const latest = this.store.resolve(config.providerId);
    const same = this.store.token() === revision && JSON.stringify(normalizeConfig(latest)) === JSON.stringify(config);
    latest.apiKey = "";
    if (!same) throw new TranslationError("CONFIG_CHANGED", "配置或 Key 已更改，请重新确认实际接口后发送。");
  }
  private async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.controllers.add(controller);
    try {
      if (controller.signal.aborted) throw new TranslationError("CANCELLED", "本次请求已取消。");
      return await operation(controller.signal);
    } finally { signal?.removeEventListener("abort", abort); this.controllers.delete(controller); }
  }
  async send(previewId: string, confirm: ConfirmSend, { signal }: { signal?: AbortSignal } = {}) {
    const pending = this.pending.get(previewId);
    this.pending.delete(previewId);
    if (!pending || this.now() - pending.createdAt > 300000) throw new TranslationError("PREVIEW_EXPIRED", "待发送批次已过期或已取消，请重新准备。");
    return this.run(async (activeSignal) => {
      this.unchanged(pending.config, pending.revision);
      if (!await confirm(this.preview(pending.config, validateSegments(pending.segments).characterCount, "translation")) || activeSignal.aborted) throw new TranslationError("CANCELLED", "本批翻译已取消。");
      this.unchanged(pending.config, pending.revision);
      const request = this.store.resolve(pending.config.providerId);
      try { return await this.provider.translateBatch(request, pending.segments, { signal: activeSignal }); }
      finally { request.apiKey = ""; }
    }, signal);
  }
  async testConnection(providerId: ProviderId, confirm: ConfirmSend, { signal }: { signal?: AbortSignal } = {}) {
    const resolved = this.store.resolve(providerId), config = normalizeConfig(resolved), revision = this.store.token();
    resolved.apiKey = "";
    return this.run(async (activeSignal) => {
      if (!await confirm(this.preview(config, Array.from("Reply OK.").length, "connection-test")) || activeSignal.aborted) throw new TranslationError("CANCELLED", "连接测试已取消。");
      this.unchanged(config, revision);
      const request = this.store.resolve(providerId);
      try { await this.provider.testConnection(request, { signal: activeSignal }); }
      catch (error) {
        if (error instanceof TranslationError && !["CANCELLED", "STORAGE", "CONFIG", "KEY_REQUIRED"].includes(error.code)) this.store.recordTest(config, "unavailable", error.code);
        throw error;
      } finally { request.apiKey = ""; }
      if (activeSignal.aborted) throw new TranslationError("CANCELLED", "连接测试已取消。");
      this.unchanged(config, revision);
      this.store.recordTest(config, "available");
    }, signal);
  }
  cancelAll() { this.pending.clear(); for (const controller of this.controllers) controller.abort(); }
  clearAll() { this.cancelAll(); this.store.clear(); }
}
