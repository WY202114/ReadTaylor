const { randomUUID } = require("node:crypto");
const { endpointInfo, destinationNotice, fixedTemperature, TranslationError, LANGUAGES } = require("./config.cjs");
const { OpenAICompatibleProvider, validateSegments } = require("./provider.cjs");

function createTranslationService({ store, confirmSend, providerFactory = () => new OpenAICompatibleProvider(), now = Date.now }) {
  const previews = new Map();
  const active = new Set();
  function preview({ providerId, segments } = {}) {
    const batch = validateSegments(segments);
    const config = store.inspect(providerId);
    const info = endpointInfo(config.endpoint);
    for (const [id, item] of previews) if (now() - item.createdAt > 5 * 60_000) previews.delete(id);
    if (previews.size >= 20) throw new TranslationError("BUSY", "待确认的翻译批次过多，请完成或取消后重试。");
    const previewId = randomUUID();
    previews.set(previewId, { providerId: config.providerId, fingerprint: store.fingerprint(config.providerId), segments: batch.segments, createdAt: now() });
    // Never return API Key, encrypted data, or the original text through metadata responses.
    return { previewId, providerId: config.providerId, domain: info.domain, endpoint: info.requestURL, local: info.local, model: config.model, targetLanguage: config.targetLanguage, characterCount: batch.characterCount, notice: destinationNotice(info), temperatureNotice: fixedTemperature(config) ? "当前 Kimi 模型使用固定温度，请求不会发送温度参数。" : "" };
  }
  async function send(previewId) {
    const prepared = previews.get(previewId);
    previews.delete(previewId);
    if (!prepared || now() - prepared.createdAt > 5 * 60_000) throw new TranslationError("PREVIEW_EXPIRED", "发送预览已过期或已使用，请重新预览本批内容。");
    if (store.fingerprint(prepared.providerId) !== prepared.fingerprint) throw new TranslationError("CONFIG_CHANGED", "翻译设置已更改，请重新预览并确认实际接口后再发送。");
    const config = store.inspect(prepared.providerId);
    const info = endpointInfo(config.endpoint);
    const { characterCount } = validateSegments(prepared.segments);
    const controller = new AbortController();
    let requestConfig;
    active.add(controller);
    try {
      const approved = await confirmSend({ domain: info.domain, endpoint: info.requestURL, local: info.local, model: config.model, targetLanguage: LANGUAGES[config.targetLanguage], characterCount, notice: destinationNotice(info) });
      if (!approved || controller.signal.aborted) throw new TranslationError("CANCELLED", "本批翻译已取消，未发送新的请求。");
      if (store.fingerprint(prepared.providerId) !== prepared.fingerprint) throw new TranslationError("CONFIG_CHANGED", "确认期间翻译设置已更改，请重新预览后发送。");
      requestConfig = store.resolve(prepared.providerId);
      return await providerFactory(config.protocol).translateBatch(requestConfig, prepared.segments, { signal: controller.signal });
    } finally { if (requestConfig) requestConfig.apiKey = ""; active.delete(controller); }
  }
  function invalidate() { previews.clear(); }
  function cancelAll() { invalidate(); for (const controller of active) controller.abort(); }
  return { preview, send, invalidate, cancelAll };
}
module.exports = { createTranslationService };
