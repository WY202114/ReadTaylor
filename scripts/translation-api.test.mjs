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

test("未配置密钥时返回清楚的提示", async () => {
  const previousKey = process.env.AZURE_TRANSLATOR_KEY;
  delete process.env.AZURE_TRANSLATOR_KEY;
  const response = responseRecorder();
  await handler({ method: "POST", headers: {}, socket: {}, body: { text: "hello", targetLanguage: "zh-Hans" } }, response);
  assert.equal(response.statusCode, 503);
  assert.match(response.payload.error, /尚未配置/);
  if (previousKey) process.env.AZURE_TRANSLATOR_KEY = previousKey;
});

test("只把当前页文字发送给 Azure 并返回译文", async () => {
  const previousKey = process.env.AZURE_TRANSLATOR_KEY;
  const previousRegion = process.env.AZURE_TRANSLATOR_REGION;
  const previousFetch = globalThis.fetch;
  process.env.AZURE_TRANSLATOR_KEY = "test-key";
  process.env.AZURE_TRANSLATOR_REGION = "eastasia";
  let sentBody = "";
  globalThis.fetch = async (_url, options) => {
    sentBody = options.body;
    assert.equal(options.headers["Ocp-Apim-Subscription-Key"], "test-key");
    assert.equal(options.headers["Ocp-Apim-Subscription-Region"], "eastasia");
    return new Response(JSON.stringify([{
      detectedLanguage: { language: "en" },
      translations: [{ text: "你好，世界", to: "zh-Hans" }],
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = responseRecorder();
    await handler({ method: "POST", headers: {}, socket: {}, body: { text: "Hello world", targetLanguage: "zh-Hans" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(sentBody), [{ Text: "Hello world" }]);
    assert.deepEqual(response.payload, {
      text: "你好，世界",
      detectedLanguage: "en",
      targetLanguage: "zh-Hans",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.AZURE_TRANSLATOR_KEY = previousKey;
    else delete process.env.AZURE_TRANSLATOR_KEY;
    if (previousRegion) process.env.AZURE_TRANSLATOR_REGION = previousRegion;
    else delete process.env.AZURE_TRANSLATOR_REGION;
  }
});

