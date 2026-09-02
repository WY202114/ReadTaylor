const allowedTargets = new Set(["zh-Hans", "zh-Hant", "en", "ja", "ko", "fr", "de", "es"]);
const requestWindows = new Map();
const MAX_TEXT_LENGTH = 6000;
const MAX_REQUESTS_PER_MINUTE = 30;

function sendJson(response, status, payload) {
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.json(payload);
}

function requestIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function rateLimited(request) {
  const ip = requestIp(request);
  const now = Date.now();
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_MINUTE;
}

function sameOriginRequest(request) {
  const origin = request.headers.origin;
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "只支持 POST 请求" });
  }
  if (!sameOriginRequest(request)) return sendJson(response, 403, { error: "请求来源不受信任" });
  if (rateLimited(request)) return sendJson(response, 429, { error: "翻译请求过于频繁，请稍后再试" });

  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  const targetLanguage = typeof request.body?.targetLanguage === "string"
    ? request.body.targetLanguage
    : "zh-Hans";
  if (!text) return sendJson(response, 400, { error: "当前页面没有可翻译的文字" });
  if (text.length > MAX_TEXT_LENGTH) {
    return sendJson(response, 413, { error: `当前页文字超过 ${MAX_TEXT_LENGTH} 字，请缩小字号后重试` });
  }
  if (!allowedTargets.has(targetLanguage)) return sendJson(response, 400, { error: "暂不支持这个目标语言" });

  const subscriptionKey = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!subscriptionKey) {
    return sendJson(response, 503, { error: "翻译服务尚未配置，请先设置 Azure Translator 密钥" });
  }

  const endpoint = (process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com")
    .replace(/\/$/, "");
  const url = `${endpoint}/translate?api-version=3.0&to=${encodeURIComponent(targetLanguage)}`;
  const headers = {
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": subscriptionKey,
  };
  if (region) headers["Ocp-Apim-Subscription-Region"] = region;

  try {
    const azureResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify([{ Text: text }]),
    });
    const payload = await azureResponse.json().catch(() => null);
    if (!azureResponse.ok) {
      const message = payload?.error?.message || "Azure Translator 请求失败";
      return sendJson(response, azureResponse.status, { error: message });
    }
    const translation = payload?.[0]?.translations?.[0];
    if (!translation?.text) return sendJson(response, 502, { error: "翻译服务没有返回译文" });
    return sendJson(response, 200, {
      text: translation.text,
      detectedLanguage: payload?.[0]?.detectedLanguage?.language,
      targetLanguage: translation.to || targetLanguage,
    });
  } catch {
    return sendJson(response, 502, { error: "暂时无法连接翻译服务，请稍后重试" });
  }
}
