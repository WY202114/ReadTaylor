import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const source = `export * from './src/lib/browserTranslation/config';export * from './src/lib/browserTranslation/provider';export * from './src/lib/browserTranslation/storage';export * from './src/lib/browserTranslation/engine';`;
const bundle = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser" });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const { defaultConfig, normalizeConfig, endpointInfo, TranslationError, readableError, BrowserTranslationStore, BrowserTranslationEngine, OpenAICompatibleProvider, splitBatches, validateSegments, parseTranslations, translationCacheKey, TRANSLATION_PROMPT_VERSION, TRANSLATION_ENGINE_VERSION, STORAGE_PREFIX } = api;
const text = [{ id: "p1", text: "Hello 🌍" }, { id: "p2", text: "Good morning" }];
const translated = [{ id: "p1", text: "你好 🌍" }, { id: "p2", text: "早上好" }];
const completion = (rows = translated, finish_reason = "stop") => ({ choices: [{ message: { content: JSON.stringify({ translations: rows }) }, finish_reason }] });
const success = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
function fixture() {
  const session = new MemoryStorage(), persistent = new MemoryStorage();
  const store = new BrowserTranslationStore(session, persistent);
  store.saveConfig(defaultConfig("deepseek"));
  store.setKey("deepseek", defaultConfig("deepseek").endpoint, "fake-key-unit-test-only", false);
  return { session, persistent, store };
}
/** Swappable transport: never contacts a real endpoint. All recorded credentials are fake. */
function mockTransport(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    const step = steps.shift();
    if (!step) throw new Error("Unexpected mock call");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(url, init);
    return new Response(JSON.stringify(step.body ?? completion()), { status: step.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = new OpenAICompatibleProvider({ fetchImpl, wait: async () => {}, offline: () => false, timeoutMs: 50 });
  return { calls, provider, fetchImpl };
}
const requestConfig = () => ({ ...defaultConfig("deepseek"), apiKey: "fake-key-unit-test-only" });

test("browser bundle is independent of Node, Electron, IPC and safeStorage", () => {
  const code = bundle.outputFiles[0].text;
  for (const forbidden of ["require(\"node:", "readTaylorDesktop", "ipcRenderer", "safeStorage", "Buffer.from", "indexedDB"]) assert.ok(!code.includes(forbidden), forbidden);
});
test("sanitized translation errors remain readable across development hot-module replacement", async () => {
  const reloaded = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}#hot-reload`);
  const oldError = new TranslationError("BROWSER_BLOCKED", "疑似跨域，请核对来源设置。");
  assert.equal(reloaded.readableError(oldError), "疑似跨域，请核对来源设置。");
  assert.ok(!reloaded.readableError(Object.assign(new Error("fake-key-secret"), { code: "BROWSER_BLOCKED" })).includes("fake-key-secret"));
});
test("endpoint normalization binds credentials to exact origin, requires HTTPS remotely, rejects secret URL fields", () => {
  assert.equal(endpointInfo("https://api.deepseek.com/").requestURL, "https://api.deepseek.com/chat/completions");
  assert.equal(endpointInfo("https://example.test/v1/chat/completions/").requestURL, "https://example.test/v1/chat/completions");
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1"]) assert.equal(endpointInfo(url).local, true);
  assert.equal(endpointInfo("https://localhost.evil.test/v1").local, false);
  for (const url of ["http://remote.test/v1", "http://127.0.0.2/v1", "http://[::1]:11434/v1", "http://localhost.evil.test/v1", "https://key@host.test/v1", "https://host.test/v1?key=fake", "https://host.test/v1#fake", "file:///fake"]) assert.throws(() => endpointInfo(url));
  assert.throws(() => normalizeConfig({ ...defaultConfig("ollama"), model: "model:cloud" }));
  assert.equal(Object.hasOwn(normalizeConfig(requestConfig()), "apiKey"), false);
});
test("approved CSP permits HTTPS plus exactly localhost/127.0.0.1 HTTP, retaining self-only scripts", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const csp = html.match(/content="(default-src[^"]+)"/)[1];
  const connect = csp.match(/connect-src ([^;]+)/)[1];
  assert.deepEqual(connect.split(" "), ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*", "ws://127.0.0.1:5173"]);
  assert.match(csp, /script-src 'self';/);
});
test("default keys live only in sessionStorage, survive reload, disappear with a new tab session", () => {
  const { session, persistent, store } = fixture();
  assert.equal(new BrowserTranslationStore(session, persistent).resolve("deepseek").apiKey, "fake-key-unit-test-only");
  assert.ok(!JSON.stringify([...persistent.map]).includes("fake-key"));
  assert.ok(!JSON.stringify(store.load()).includes("fake-key"));
  assert.throws(() => new BrowserTranslationStore(new MemoryStorage(), persistent).resolve("deepseek"), (e) => e.code === "KEY_REQUIRED");
});
test("remember mode migrates a key, reopening remembers it; turning off removes persistent copy", () => {
  const { session, persistent, store } = fixture(), config = defaultConfig("deepseek");
  store.setKey("deepseek", config.endpoint, "fake-key-unit-test-only", true);
  assert.equal([...session.map].length, 0);
  assert.equal(new BrowserTranslationStore(new MemoryStorage(), persistent).resolve("deepseek").apiKey, "fake-key-unit-test-only");
  store.setKey("deepseek", config.endpoint, "fake-key-unit-test-only", false);
  assert.ok(!JSON.stringify([...persistent.map]).includes("fake-key"));
  assert.equal(store.getKey("deepseek", config.endpoint).remember, false);
});
test("keys are isolated per provider and endpoint origin, including port; clear only removes translation namespace", () => {
  const { session, persistent, store } = fixture();
  store.saveConfig(defaultConfig("qwen")); store.setKey("qwen", defaultConfig("qwen").endpoint, "fake-qwen-only", true);
  assert.equal(store.resolve("deepseek").apiKey, "fake-key-unit-test-only");
  assert.equal(store.resolve("qwen").apiKey, "fake-qwen-only");
  assert.equal(store.getKey("deepseek", "https://other.test/v1").apiKey, "");
  store.setKey("custom", "http://localhost:1111/v1", "fake-local", false);
  assert.equal(store.getKey("custom", "http://localhost:2222/v1").apiKey, "");
  persistent.setItem("readtaylor.books", "keep"); session.setItem("another-app", "keep");
  store.clear();
  assert.equal(persistent.getItem("readtaylor.books"), "keep"); assert.equal(session.getItem("another-app"), "keep");
  assert.ok(![...persistent.map.keys(), ...session.map.keys()].some((k) => k.startsWith(STORAGE_PREFIX)));
});
test("storage failures have readable sanitized errors and do not silently discard previous key", () => {
  const { session, persistent, store } = fixture();
  persistent.setItem = () => { throw new Error("quota fake-key-secret"); };
  assert.throws(() => store.setKey("deepseek", defaultConfig("deepseek").endpoint, "new-fake", true), (e) => e.code === "STORAGE" && !readableError(e).includes("fake-key-secret"));
  assert.equal(store.getKey("deepseek", defaultConfig("deepseek").endpoint).apiKey, "fake-key-unit-test-only");
  assert.ok(!readableError(new Error("fake-key-secret")).includes("fake-key-secret"));
  assert.equal(session.length, 1);
});
test("local OpenAI compatible models need no key; remote custom interfaces do", async () => {
  const { store } = fixture();
  store.saveConfig(defaultConfig("ollama")); assert.equal(store.resolve("ollama").apiKey, "");
  store.saveConfig({ ...defaultConfig("custom"), endpoint: "http://localhost:11434/v1", model: "local-model" });
  assert.equal(store.resolve("custom").apiKey, "");
  store.saveConfig({ ...defaultConfig("custom"), endpoint: "https://remote.test/v1", model: "remote" });
  assert.throws(() => store.resolve("custom"), (e) => e.code === "KEY_REQUIRED");
  const mock = mockTransport([{ body: success }]);
  await mock.provider.testConnection({ ...defaultConfig("ollama"), apiKey: "" });
  assert.equal(mock.calls[0].headers.Authorization, undefined);
});
test("batch splitting counts Unicode and preserves IDs/order; it does not extract PDFs or split oversized segments", () => {
  assert.equal(validateSegments([{ id: "a", text: "a🌍中" }]).characterCount, 3);
  assert.deepEqual(splitBatches([{ id: "a", text: "a🌍" }, { id: "b", text: "中b" }, { id: "c", text: "c" }], 4).map((b) => b.map((s) => s.id)), [["a", "b"], ["c"]]);
  assert.deepEqual(splitBatches(Array.from({ length: 101 }, (_, i) => ({ id: String(i), text: "a" }))).map((b) => b.length), [100, 1]);
  for (const input of [[], [{ id: "x", text: " " }], [{ id: "x", text: "a" }, { id: "x", text: "b" }]]) assert.throws(() => splitBatches(input));
  assert.throws(() => splitBatches([{ id: "a", text: "a".repeat(12001) }]));
});
test("numbered JSON/JSONL replies are reordered and strictly validated", () => {
  assert.deepEqual(parseTranslations(JSON.stringify({ translations: [...translated].reverse() }), text), translated);
  assert.deepEqual(parseTranslations(translated.map((s) => JSON.stringify(s)).join("\n"), text), translated);
  for (const rows of [[translated[0]], [translated[0], translated[0]], [{ id: "unknown", text: "x" }, translated[1]]]) assert.throws(() => parseTranslations(JSON.stringify(rows), text));
});
test("direct browser requests are non-streaming, omit cookies/referrer, forbid redirects; credentials only in header", async () => {
  const mock = mockTransport([{}]);
  assert.deepEqual((await mock.provider.translateBatch(requestConfig(), text)).translations, translated);
  const call = mock.calls[0];
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.headers.Authorization, "Bearer fake-key-unit-test-only");
  assert.equal(call.credentials, "omit"); assert.equal(call.referrerPolicy, "no-referrer"); assert.equal(call.redirect, "error");
  assert.equal(call.body.stream, false); assert.equal(call.body.temperature, 0.2);
  assert.ok(!JSON.stringify(call.body).includes("fake-key")); assert.ok(!call.url.includes("fake-key"));
});
test("JSON-mode/temperature fallback and format retries preserve validation", async () => {
  const mock = mockTransport([
    { status: 400, body: { error: { message: "response_format json_object unsupported" } } },
    { status: 400, body: { error: { message: "temperature only supports fixed value" } } },
    { body: { choices: [{ message: { content: "bad json" } }] } },
    { body: { choices: [{ message: { content: translated.map((s) => JSON.stringify(s)).join("\n") } }] } },
  ]);
  const result = await mock.provider.translateBatch(requestConfig(), text);
  assert.equal(result.attempts, 4); assert.equal(mock.calls[1].body.response_format, undefined); assert.equal(mock.calls[2].body.temperature, undefined);
  assert.match(mock.calls[3].body.messages[0].content, /JSON Lines/); assert.deepEqual(result.translations, translated);
  const invalid = mockTransport(Array.from({ length: 3 }, () => ({ body: completion([translated[0]]) })));
  await assert.rejects(invalid.provider.translateBatch(requestConfig(), text), (e) => e.code === "FORMAT"); assert.equal(invalid.calls.length, 3);
});
test("fixed-temperature Kimi omits temperature; truncation never retries", async () => {
  const mock = mockTransport([{}]);
  await mock.provider.translateBatch({ ...defaultConfig("kimi"), temperature: 0.2, apiKey: "fake" }, text);
  assert.equal(mock.calls[0].body.temperature, undefined);
  const truncated = mockTransport([{ body: completion(translated, "length") }]);
  await assert.rejects(truncated.provider.translateBatch(requestConfig(), text), (e) => e.code === "TRUNCATED"); assert.equal(truncated.calls.length, 1);
});
test("real connection-test code issues exactly one minimal request and classifies HTTP failures without leaking details", async () => {
  const mock = mockTransport([{ body: success }]); await mock.provider.testConnection(requestConfig());
  assert.equal(mock.calls.length, 1); assert.deepEqual(mock.calls[0].body.messages, [{ role: "user", content: "Reply OK." }]);
  assert.equal(mock.calls[0].body.max_tokens, 32);
  for (const [status, code, expected] of [[401, "invalid_api_key", "KEY_INVALID"], [403, "forbidden", "ACCESS"], [402, "insufficient_balance", "BALANCE"], [404, "model_not_found", "MODEL"], [429, "rate_limit", "RATE_LIMIT"], [500, "internal", "NETWORK"]]) {
    const mock = mockTransport([{ status, body: { error: { code, message: "fake-key-unit-test-only" } } }]);
    await assert.rejects(mock.provider.testConnection(requestConfig()), (e) => e.code === expected && !e.message.includes("fake-key")); assert.equal(mock.calls.length, 1);
  }
  const malformed = mockTransport([{ body: { wrong: true } }]);
  await assert.rejects(malformed.provider.testConnection(requestConfig()), (e) => e.code === "FORMAT");
});
test("browser native fetch receives the global receiver rather than the provider instance", async () => {
  const provider = new OpenAICompatibleProvider({ fetchImpl: function () {
    assert.equal(this, globalThis);
    return Promise.resolve(new Response(JSON.stringify(success), { headers: { "Content-Type": "application/json" } }));
  } });
  await provider.testConnection(requestConfig());
});
test("no-status browser failure explains suspected CORS; offline, timeout and AbortSignal are distinct", async () => {
  const blocked = mockTransport([new TypeError("Failed fetch fake-key-secret")]);
  await assert.rejects(blocked.provider.testConnection(requestConfig()), (e) => e.code === "BROWSER_BLOCKED" && /CORS/.test(e.message) && !e.message.includes("fake-key-secret"));
  const offline = new OpenAICompatibleProvider({ fetchImpl: async () => { throw new TypeError(); }, offline: () => true });
  await assert.rejects(offline.testConnection(requestConfig()), (e) => e.code === "NETWORK" && /离线/.test(e.message));
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted fake-key-secret")), { once: true }); });
  const timeout = new OpenAICompatibleProvider({ fetchImpl: pending, timeoutMs: 5 });
  await assert.rejects(timeout.testConnection(requestConfig()), (e) => e.code === "TIMEOUT");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(blocked.provider.testConnection(requestConfig(), { signal: controller.signal }), (e) => e.code === "CANCELLED");
});
test("connection badges start untested and only explicit user connection tests update them; endpoint/model/key changes invalidate", async () => {
  const { store } = fixture(), config = defaultConfig("deepseek");
  const mock = mockTransport([{}, { body: success }, { status: 401, body: { error: { code: "invalid_api_key" } } }]);
  const engine = new BrowserTranslationEngine(store, mock.provider);
  assert.equal(store.connectionState(config), "untested");
  await engine.send(engine.prepare("deepseek", text).previewId, () => true);
  assert.equal(store.connectionState(config), "untested");
  await engine.testConnection("deepseek", () => true); assert.equal(store.connectionState(config), "available");
  assert.equal(store.connectionState({ ...config, model: "other" }), "untested");
  assert.equal(store.connectionState({ ...config, endpoint: "https://other.test/v1" }), "untested");
  const { session, persistent } = fixture(); persistent.setItem(`${STORAGE_PREFIX}settings`, JSON.stringify(store.load()));
  assert.equal(new BrowserTranslationStore(session, persistent).connectionState(config), "available");
  store.setKey("deepseek", config.endpoint, "new-fake", false); assert.equal(store.connectionState(config), "untested");
  await assert.rejects(engine.testConnection("deepseek", () => true), (e) => e.code === "KEY_INVALID"); assert.equal(store.connectionState(config), "unavailable");
});
test("preflight shows actual destination/count before sending, is single-use, expires and rejects changed configuration", async () => {
  const { store } = fixture(), mock = mockTransport([{}]); let now = 0;
  const engine = new BrowserTranslationEngine(store, mock.provider, () => now);
  const preview = engine.prepare("deepseek", text); assert.equal(mock.calls.length, 0); assert.equal(preview.characterCount, 19);
  assert.ok(!JSON.stringify(preview).includes("fake-key")); assert.match(preview.notice, /浏览器直接发送给 api.deepseek.com/);
  await engine.send(preview.previewId, (p) => { assert.equal(mock.calls.length, 0); assert.equal(p.domain, "api.deepseek.com"); return true; });
  await assert.rejects(engine.send(preview.previewId, () => true), (e) => e.code === "PREVIEW_EXPIRED");
  const expired = engine.prepare("deepseek", text); now = 300001;
  await assert.rejects(engine.send(expired.previewId, () => true), (e) => e.code === "PREVIEW_EXPIRED");
  const changed = engine.prepare("deepseek", text); store.saveConfig({ ...defaultConfig("deepseek"), model: "other" });
  await assert.rejects(engine.send(changed.previewId, () => true), (e) => e.code === "CONFIG_CHANGED");
});
test("cancel before consent sends nothing; clear aborts in-flight test and does not recreate cleared config/status", async () => {
  const { store, session, persistent } = fixture(), mock = mockTransport([]), engine = new BrowserTranslationEngine(store, mock.provider);
  await assert.rejects(engine.send(engine.prepare("deepseek", text).previewId, () => false), (e) => e.code === "CANCELLED"); assert.equal(mock.calls.length, 0);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = new OpenAICompatibleProvider({ fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) });
  const active = new BrowserTranslationEngine(store, pending), task = active.testConnection("deepseek", () => true);
  await ready; active.clearAll();
  await assert.rejects(task, (e) => e.code === "CANCELLED"); assert.equal(session.length, 0); assert.equal(persistent.length, 0);
});
test("cache identity includes prompt/engine/config/text/context but excludes Key and source plaintext", async () => {
  const config = requestConfig(), key = await translationCacheKey(config, text);
  assert.ok(TRANSLATION_PROMPT_VERSION && TRANSLATION_ENGINE_VERSION);
  assert.equal(key, await translationCacheKey({ ...config, apiKey: "different-fake" }, text));
  for (const changed of [{ ...config, model: "other" }, { ...config, targetLanguage: "en" }, { ...config, temperature: 0.1 }, { ...config, endpoint: "https://other.test/v1" }]) assert.notEqual(key, await translationCacheKey(changed, text));
  assert.notEqual(key, await translationCacheKey(config, text, "context")); assert.notEqual(key, await translationCacheKey(config, [{ id: "p1", text: "Changed" }]));
  assert.ok(!key.includes("Hello") && !key.includes("fake-key"));
});
