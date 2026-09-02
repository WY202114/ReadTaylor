import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/translate.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function request(body) {
  return { method: "POST", headers: {}, socket: {}, body };
}

test("未配置百度凭据时返回清楚的提示", async () => {
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  delete process.env.BAIDU_TRANSLATE_APP_ID;
  delete process.env.BAIDU_TRANSLATE_SECRET;
  try {
    const response = responseRecorder();
    await handler(request({ text: "hello", targetLanguage: "zh-Hans" }), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.payload.error, /百度翻译 APP ID 和密钥/);
  } finally {
    if (previousAppId) process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    if (previousSecret) process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
  }
});

test("只把当前页文字签名后发送给百度翻译", async () => {
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.BAIDU_TRANSLATE_APP_ID = "test-app-id";
  process.env.BAIDU_TRANSLATE_SECRET = "test-secret";
  let sentUrl = "";
  let sentBody;
  globalThis.fetch = async (url, options) => {
    sentUrl = String(url);
    sentBody = options.body;
    return new Response(JSON.stringify({
      from: "en",
      to: "zh",
      trans_result: [{ src: "Hello world", dst: "你好，世界" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = responseRecorder();
    await handler(request({ text: "Hello world", targetLanguage: "zh-Hans" }), response);
    const form = new URLSearchParams(sentBody);
    const expectedSign = createHash("md5")
      .update(`test-app-idHello world${form.get("salt")}test-secret`, "utf8")
      .digest("hex");
    assert.equal(sentUrl, "https://fanyi-api.baidu.com/api/trans/vip/translate");
    assert.equal(form.get("q"), "Hello world");
    assert.equal(form.get("from"), "auto");
    assert.equal(form.get("to"), "zh");
    assert.equal(form.get("appid"), "test-app-id");
    assert.equal(form.get("sign"), expectedSign);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, {
      text: "你好，世界",
      detectedLanguage: "en",
      targetLanguage: "zh-Hans",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId) process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    else delete process.env.BAIDU_TRANSLATE_APP_ID;
    if (previousSecret) process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
    else delete process.env.BAIDU_TRANSLATE_SECRET;
  }
});

test("百度错误码会转换成用户能看懂的提示", async () => {
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.BAIDU_TRANSLATE_APP_ID = "test-app-id";
  process.env.BAIDU_TRANSLATE_SECRET = "test-secret";
  globalThis.fetch = async () => new Response(JSON.stringify({
    error_code: "54001",
    error_msg: "Invalid Sign",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const response = responseRecorder();
    await handler(request({ text: "Hello", targetLanguage: "zh-Hans" }), response);
    assert.equal(response.statusCode, 502);
    assert.match(response.payload.error, /密钥校验失败/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId) process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    else delete process.env.BAIDU_TRANSLATE_APP_ID;
    if (previousSecret) process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
    else delete process.env.BAIDU_TRANSLATE_SECRET;
  }
});

test("长页面会按标准版限制自动分段并拼回译文", async () => {
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.BAIDU_TRANSLATE_APP_ID = "test-app-id";
  process.env.BAIDU_TRANSLATE_SECRET = "test-secret";
  const chunkLengths = [];
  globalThis.fetch = async (_url, options) => {
    const form = new URLSearchParams(options.body);
    const chunk = form.get("q") || "";
    chunkLengths.push(Array.from(chunk).length);
    return new Response(JSON.stringify({
      from: "en",
      to: "zh",
      trans_result: [{ src: chunk, dst: `译文${chunkLengths.length}` }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = responseRecorder();
    await handler(request({ text: "a".repeat(1200), targetLanguage: "zh-Hans" }), response);
    assert.deepEqual(chunkLengths, [900, 300]);
    assert.equal(response.payload.text, "译文1\n译文2");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId) process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    else delete process.env.BAIDU_TRANSLATE_APP_ID;
    if (previousSecret) process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
    else delete process.env.BAIDU_TRANSLATE_SECRET;
  }
});
