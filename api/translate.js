import { createHash, randomBytes } from "node:crypto";

const targetLanguages = new Map([
  ["zh-Hans", "zh"],
  ["zh-Hant", "cht"],
  ["en", "en"],
  ["ja", "jp"],
  ["ko", "kor"],
  ["fr", "fra"],
  ["de", "de"],
  ["es", "spa"],
]);
const requestWindows = new Map();
const MAX_TEXT_LENGTH = 6000;
const STANDARD_CHUNK_LENGTH = 900;
const MAX_REQUESTS_PER_MINUTE = 30;
const BAIDU_ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";

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

function splitText(text, maxLength = STANDARD_CHUNK_LENGTH) {
  const chunks = [];
  let remaining = Array.from(text);
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength).join("");
    const minimumBreak = Math.floor(maxLength * 0.55);
    const breakAt = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf("！"),
      candidate.lastIndexOf("？"),
      candidate.lastIndexOf(";"),
      candidate.lastIndexOf("；"),
      candidate.lastIndexOf(". "),
    );
    const length = breakAt >= minimumBreak ? breakAt + 1 : maxLength;
    chunks.push(remaining.slice(0, length).join("").trim());
    remaining = remaining.slice(length);
  }
  const finalChunk = remaining.join("").trim();
  if (finalChunk) chunks.push(finalChunk);
  return chunks.filter(Boolean);
}

function baiduError(code) {
  const messages = {
    52001: "百度翻译请求超时，请重试",
    52002: "百度翻译服务暂时异常，请稍后重试",
    52003: "百度翻译服务未开通，或 APP ID 配置错误",
    54000: "百度翻译请求参数不完整",
    54001: "百度翻译密钥校验失败，请检查 Vercel 配置",
    54003: "翻译请求过于频繁，请稍后再试",
    54004: "百度翻译免费额度已用完或账户余额不足",
    54005: "当前页文字较多，请稍后重试",
    58000: "百度翻译限制了服务器地址，请清空控制台中的 IP 限制",
    58001: "百度翻译暂不支持这组语言互译",
    58002: "百度翻译服务当前已关闭",
  };
  return messages[code] || `百度翻译返回错误（${code}）`;
}

function waitForNextRequest() {
  return new Promise((resolve) => setTimeout(resolve, 1050));
}

async function translateChunk(text, targetLanguage, appId, secret) {
  const salt = randomBytes(8).toString("hex");
  const sign = createHash("md5").update(`${appId}${text}${salt}${secret}`, "utf8").digest("hex");
  const body = new URLSearchParams({
    q: text,
    from: "auto",
    to: targetLanguage,
    appid: appId,
    salt,
    sign,
  });
  const response = await fetch(BAIDU_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("暂时无法连接百度翻译，请稍后重试");
  if (payload?.error_code) throw new Error(baiduError(Number(payload.error_code)));
  const translated = Array.isArray(payload?.trans_result)
    ? payload.trans_result.map((item) => item?.dst || "").filter(Boolean).join("\n")
    : "";
  if (!translated) throw new Error("百度翻译没有返回译文");
  return { text: translated, detectedLanguage: payload.from || "" };
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
  if (Array.from(text).length > MAX_TEXT_LENGTH) {
    return sendJson(response, 413, { error: `当前页文字超过 ${MAX_TEXT_LENGTH} 字，请缩小字号后重试` });
  }
  const baiduTarget = targetLanguages.get(targetLanguage);
  if (!baiduTarget) return sendJson(response, 400, { error: "暂不支持这个目标语言" });

  const appId = process.env.BAIDU_TRANSLATE_APP_ID;
  const secret = process.env.BAIDU_TRANSLATE_SECRET;
  if (!appId || !secret) {
    return sendJson(response, 503, { error: "翻译服务尚未配置，请先设置百度翻译 APP ID 和密钥" });
  }

  try {
    const chunks = splitText(text);
    const translatedChunks = [];
    let detectedLanguage = "";
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await waitForNextRequest();
      const result = await translateChunk(chunks[index], baiduTarget, appId, secret);
      translatedChunks.push(result.text);
      if (!detectedLanguage) detectedLanguage = result.detectedLanguage;
    }
    return sendJson(response, 200, {
      text: translatedChunks.join("\n"),
      detectedLanguage,
      targetLanguage,
    });
  } catch (error) {
    return sendJson(response, 502, {
      error: error instanceof Error ? error.message : "翻译失败，请稍后重试",
    });
  }
}
