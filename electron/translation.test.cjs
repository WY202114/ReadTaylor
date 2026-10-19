const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { defaultConfig, normalizeConfig, endpointInfo, fixedTemperature, publicError } = require("./translation/config.cjs");
const { createTranslationStore } = require("./translation/store.cjs");
const { OpenAICompatibleProvider, parseTranslations, validateSegments } = require("./translation/provider.cjs");
const { createTranslationService } = require("./translation/service.cjs");
const { installTranslationIPC } = require("./translation/ipc.cjs");
const { createMockTranslationFetch, mockCompletion } = require("./translation/mock.cjs");

const segments = [{ id: "p1-1", text: "Hello 🌍" }, { id: "p1-2", text: "Good morning" }];
const translations = [{ id: "p1-1", text: "你好 🌍" }, { id: "p1-2", text: "早上好" }];
const noWait = async () => {};
function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "readtaylor-translation-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (value) => {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const filePath = path.join(directory, "settings.json");
  const store = createTranslationStore({ filePath, safeStorage });
  const config = defaultConfig("deepseek");
  store.save(config, { requireKey: false });
  store.setKey("deepseek", endpointInfo(config.endpoint).origin, "unit-test-key-never-real");
  return { directory, filePath, store, safeStorage };
}
function providerFixture(steps, config = defaultConfig("deepseek")) {
  const mock = createMockTranslationFetch(steps);
  const provider = new OpenAICompatibleProvider({ fetchImpl: mock.fetchImpl, wait: noWait });
  return { ...mock, provider, config: { ...config, apiKey: "unit-test-key-never-real" } };
}

test("endpoint normalization classifies local hosts exactly and prevents credentials, remote HTTP and query keys", () => {
  assert.equal(endpointInfo("https://api.deepseek.com/").requestURL, "https://api.deepseek.com/chat/completions");
  assert.equal(endpointInfo("https://example.test/v1/chat/completions/").requestURL, "https://example.test/v1/chat/completions");
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8888/v1", "http://[::1]:11434/v1"]) assert.equal(endpointInfo(url).local, true);
  assert.equal(endpointInfo("https://localhost.attacker.test/v1").local, false);
  for (const url of ["http://remote.test/v1", "https://key@host.test/v1", "https://host.test/v1?api_key=secret", "file:///tmp/key"]) assert.throws(() => endpointInfo(url));
  for (const model of ["gpt-oss:20b-cloud", "model:cloud"]) assert.throws(() => normalizeConfig({ ...defaultConfig("ollama"), model }), /本地模型/);
});

test("profiles encrypt keys, never return ciphertext or plaintext, and preserve keys per provider and origin across reload", (t) => {
  const { store, safeStorage, filePath } = storeFixture(t);
  const qwen = defaultConfig("qwen");
  store.save(qwen, { requireKey: false });
  store.setKey("qwen", endpointInfo(qwen.endpoint).origin, "second-unit-test-key");
  const reloaded = createTranslationStore({ filePath, safeStorage });
  assert.equal(reloaded.resolve("deepseek").apiKey, "unit-test-key-never-real");
  assert.equal(reloaded.resolve("qwen").apiKey, "second-unit-test-key");
  const disk = fs.readFileSync(filePath, "utf8");
  assert.ok(!disk.includes("unit-test-key"));
  assert.ok(!JSON.stringify(reloaded.snapshot()).includes("unit-test-key"));
  assert.ok(!JSON.stringify(reloaded.snapshot()).includes(JSON.parse(disk).profiles.deepseek.keys["https://api.deepseek.com"]));
  reloaded.save({ ...defaultConfig("deepseek"), endpoint: "https://other.test/v1" }, { requireKey: false });
  assert.throws(() => reloaded.resolve("deepseek"), /尚未配置/);
  reloaded.save(defaultConfig("deepseek"));
  assert.equal(reloaded.resolve("deepseek").apiKey, "unit-test-key-never-real");
});

test("unavailable secure storage never writes a plaintext key; local Ollama accepts no key, remote Ollama does not", (t) => {
  const { filePath, store, safeStorage } = storeFixture(t);
  const locked = createTranslationStore({ filePath, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
  assert.throws(() => locked.setKey("deepseek", "https://api.deepseek.com", "fake"), /安全存储/);
  const basic = createTranslationStore({ filePath, platform: "linux", safeStorage: { ...safeStorage, getSelectedStorageBackend: () => "basic_text" } });
  assert.throws(() => basic.resolve("deepseek"), /安全存储/);
  store.save(defaultConfig("ollama"));
  assert.equal(store.resolve("ollama").apiKey, "");
  assert.throws(() => store.save({ ...defaultConfig("ollama"), endpoint: "https://remote.test/v1" }), /API Key/);
  store.clear();
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(store.snapshot().profiles.some((p) => p.hasKey), false);
});

test("batch validation counts Unicode characters and rejects empty, duplicate or oversized batches", () => {
  assert.equal(validateSegments([{ id: "x", text: "a🌍中" }]).characterCount, 3);
  for (const invalid of [[], [{ id: "x", text: " " }], [{ id: "x", text: "a" }, { id: "x", text: "b" }], [{ id: "x", text: "a".repeat(12001) }]]) assert.throws(() => validateSegments(invalid));
});

test("OpenAI compatible transport is non-streaming, authenticates only in main, and restores source ordering by ID", async () => {
  const { provider, config, calls } = providerFixture([{ body: mockCompletion([...translations].reverse()) }]);
  const result = await provider.translateBatch(config, segments);
  assert.deepEqual(result.translations, translations);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer unit-test-key-never-real");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.temperature, 0.2);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].redirect, "error");
  assert.ok(!JSON.stringify(result).includes("unit-test-key"));
});

test("unsupported JSON mode falls back to JSON Lines without dropping numbering checks", async () => {
  const { provider, config, calls } = providerFixture([
    { status: 400, body: { error: { message: "response_format json_object is not supported" } } },
    { body: { choices: [{ message: { content: translations.map((row) => JSON.stringify(row)).join("\n") } }] } },
  ]);
  assert.deepEqual((await provider.translateBatch(config, segments)).translations, translations);
  assert.equal(calls[1].body.response_format, undefined);
  assert.match(calls[1].body.messages[0].content, /JSON Lines/);
});

test("missing, duplicate and unknown result IDs are rejected; malformed results retry only twice", async () => {
  for (const rows of [[translations[0]], [translations[0], translations[0]], [{ id: "unknown", text: "x" }, translations[1]]]) assert.throws(() => parseTranslations(JSON.stringify({ translations: rows }), segments));
  const fixture = providerFixture(Array.from({ length: 3 }, () => ({ body: mockCompletion([translations[0]]) })));
  await assert.rejects(fixture.provider.translateBatch(fixture.config, segments), (error) => error.code === "FORMAT");
  assert.equal(fixture.calls.length, 3);
});

test("format retry can recover; unsupported temperature is omitted and Kimi fixed temperatures are not sent", async () => {
  const fixture = providerFixture([{ body: { choices: [{ message: { content: "not json" } }] } }, { body: mockCompletion(translations) }]);
  assert.equal((await fixture.provider.translateBatch(fixture.config, segments)).attempts, 2);
  const temperature = providerFixture([{ status: 400, body: { error: { message: "temperature only supports a fixed value" } } }, { body: mockCompletion(translations) }]);
  await temperature.provider.translateBatch(temperature.config, segments);
  assert.equal(temperature.calls[1].body.temperature, undefined);
  const kimi = providerFixture([{ body: mockCompletion(translations) }], { ...defaultConfig("kimi"), temperature: 0.2 });
  assert.equal(fixedTemperature(kimi.config), true);
  await kimi.provider.translateBatch(kimi.config, segments);
  assert.equal(kimi.calls[0].body.temperature, undefined);
});

test("auth, balance, model, rate-limit, network and formatting failures have readable errors without leaking upstream text", async () => {
  for (const [status, code, expected] of [[401, "invalid_api_key", "KEY_INVALID"], [402, "insufficient_balance", "BALANCE"], [404, "model_not_found", "MODEL"], [429, "rate_limit", "RATE_LIMIT"]]) {
    const fixture = providerFixture(Array.from({ length: 3 }, () => ({ status, body: { error: { code, message: "unit-test-key-never-real" } } })));
    await assert.rejects(fixture.provider.translateBatch(fixture.config, segments), (error) => error.code === expected && !error.message.includes("unit-test-key"));
    assert.equal(fixture.calls.length, status === 429 ? 3 : 1);
  }
  const network = providerFixture(Array.from({ length: 3 }, () => new Error("secret in network exception")));
  await assert.rejects(network.provider.translateBatch(network.config, segments), (error) => error.code === "NETWORK" && !error.message.includes("secret"));
  assert.ok(!JSON.stringify(publicError(new Error("unit-test-key"))).includes("unit-test-key"));
});

test("timeout/cancellation abort the transport; truncated outputs do not trigger more paid retries", async () => {
  const fixture = providerFixture([{ body: mockCompletion(translations, "length") }]);
  await assert.rejects(fixture.provider.translateBatch(fixture.config, segments), (error) => error.code === "TRUNCATED");
  assert.equal(fixture.calls.length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.provider.translateBatch(fixture.config, segments, { signal: controller.signal }), (error) => error.code === "CANCELLED");
  const timeout = new OpenAICompatibleProvider({ timeoutMs: 5, wait: noWait, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) });
  await assert.rejects(timeout.translateBatch(fixture.config, segments), (error) => error.code === "NETWORK");
});

test("preflight uses actual destination and count, confirms before any network call and cannot replay or bypass settings changes", async (t) => {
  const { store } = storeFixture(t);
  const mock = createMockTranslationFetch([{ body: mockCompletion(translations) }]);
  let confirmation;
  const service = createTranslationService({ store, confirmSend: async (preview) => { assert.equal(mock.calls.length, 0); confirmation = preview; return true; }, providerFactory: () => new OpenAICompatibleProvider({ fetchImpl: mock.fetchImpl }) });
  const preview = service.preview({ segments });
  assert.equal(mock.calls.length, 0);
  assert.equal(preview.domain, "api.deepseek.com");
  assert.ok(!JSON.stringify(preview).includes("unit-test-key"));
  const result = await service.send(preview.previewId);
  assert.deepEqual(result.translations, translations);
  assert.equal(confirmation.characterCount, 19);
  await assert.rejects(service.send(preview.previewId), (error) => error.code === "PREVIEW_EXPIRED");
  const stale = service.preview({ segments });
  store.save({ ...defaultConfig("deepseek"), model: "another-model" });
  await assert.rejects(service.send(stale.previewId), (error) => error.code === "CONFIG_CHANGED");
});

test("cancelled or cleared preflights never send text; preflights expire", async (t) => {
  const { store } = storeFixture(t);
  let clock = 0;
  const service = createTranslationService({ store, now: () => clock, confirmSend: async () => false, providerFactory: () => { throw new Error("must not send"); } });
  await assert.rejects(service.send(service.preview({ segments }).previewId), (error) => error.code === "CANCELLED");
  const expiring = service.preview({ segments }); clock = 300001;
  await assert.rejects(service.send(expiring.previewId), (error) => error.code === "PREVIEW_EXPIRED");
  const cleared = service.preview({ segments }); service.cancelAll(); store.clear();
  await assert.rejects(service.send(cleared.previewId), (error) => error.code === "PREVIEW_EXPIRED");
});

test("IPC rejects untrusted windows and subframes; main page cannot submit a Key or retrieve saved secrets", async (t) => {
  const { store } = storeFixture(t);
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame };
  installTranslationIPC({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, store, getMainWindow: () => ({ webContents }), requireTrustedSender: () => {} });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const result = await handlers.get("readtaylor:translation:settings")(trusted);
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes("unit-test-key"));
  assert.equal((await handlers.get("readtaylor:translation:key-submit")(trusted, "fake")).ok, false);
  assert.equal((await handlers.get("readtaylor:translation:settings")({ sender: webContents, senderFrame: {} })).ok, false);
  assert.equal((await handlers.get("readtaylor:translation:settings")({ sender: { mainFrame }, senderFrame: mainFrame })).ok, false);
});

test("local transport omits Authorization when no key is configured", async () => {
  const fixture = providerFixture([{ body: mockCompletion(translations) }], defaultConfig("ollama"));
  fixture.config.apiKey = "";
  await fixture.provider.translateBatch(fixture.config, segments);
  assert.equal(fixture.calls[0].headers.Authorization, undefined);
  assert.equal(fixture.calls[0].url, "http://localhost:11434/v1/chat/completions");
});

test("clearing configuration aborts an active batch instead of starting retry requests", async (t) => {
  const { store } = storeFixture(t);
  let transportStarted;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const provider = new OpenAICompatibleProvider({ fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    transportStarted();
    signal.addEventListener("abort", () => reject(new Error("mock abort")), { once: true });
  }) });
  const service = createTranslationService({ store, confirmSend: async () => true, providerFactory: () => provider });
  const pending = service.send(service.preview({ segments }).previewId);
  await started;
  service.cancelAll(); store.clear();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
});

test("native confirmation names the exact interface and Unicode character count, and cancel sends nothing", async (t) => {
  const { store } = storeFixture(t);
  const handlers = new Map();
  const mainFrame = {}, webContents = { mainFrame };
  let prompt;
  let networkCalls = 0;
  installTranslationIPC({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, store, getMainWindow: () => ({ webContents }), requireTrustedSender: () => {}, dialog: { showMessageBox: async (_window, details) => { prompt = details; return { response: 0 }; } }, serviceOptions: { providerFactory: () => { networkCalls++; throw new Error("should not send"); } } });
  const event = { sender: webContents, senderFrame: mainFrame };
  const preview = await handlers.get("readtaylor:translation:preview")(event, { segments });
  const result = await handlers.get("readtaylor:translation:send")(event, preview.data.previewId);
  assert.equal(result.code, "CANCELLED");
  assert.match(prompt.message, /本批约 19 字符.*api\.deepseek\.com/);
  assert.match(prompt.detail, /https:\/\/api\.deepseek\.com\/chat\/completions/);
  assert.equal(networkCalls, 0);
});

test("isolated Key window lifecycle saves the Key only from its own top frame and returns metadata only", async (t) => {
  const { store } = storeFixture(t);
  const { EventEmitter } = require("node:events");
  let popup;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; popup = this;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
    }
    async loadFile(file) { this.file = file; this.emit("ready-to-show"); }
    show() { this.shown = true; }
    close() { this.destroyed = true; this.emit("closed"); }
    isDestroyed() { return Boolean(this.destroyed); }
  }
  const handlers = new Map(), mainFrame = {}, webContents = { mainFrame };
  installTranslationIPC({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, BrowserWindow: FakeWindow, store, getMainWindow: () => ({ webContents }), requireTrustedSender: () => {} });
  const mainEvent = { sender: webContents, senderFrame: mainFrame };
  const pending = handlers.get("readtaylor:translation:edit-key")(mainEvent, defaultConfig("qwen"));
  await Promise.resolve();
  assert.equal(popup.options.webPreferences.sandbox, true);
  assert.equal(popup.options.webPreferences.contextIsolation, true);
  assert.equal(popup.options.webPreferences.nodeIntegration, false);
  assert.equal(popup.options.webPreferences.devTools, false);
  assert.equal(popup.openHandler({ url: "https://other.test" }).action, "deny");
  const keyEvent = { sender: popup.webContents, senderFrame: popup.webContents.mainFrame };
  const context = await handlers.get("readtaylor:translation:key-context")(keyEvent);
  assert.equal(context.data.domain, "dashscope.aliyuncs.com");
  assert.equal((await handlers.get("readtaylor:translation:key-submit")({ ...keyEvent, senderFrame: {} }, "fake")).ok, false);
  assert.equal((await handlers.get("readtaylor:translation:key-submit")(keyEvent, "isolated-window-unit-test-key")).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await pending;
  assert.equal(completed.data.keySaved, true);
  assert.ok(!JSON.stringify(completed).includes("unit-test-key"));
  assert.equal(store.resolve("qwen").apiKey, "isolated-window-unit-test-key");
  assert.match(fs.readFileSync(popup.file, "utf8"), /connect-src 'none'/);
  assert.match(fs.readFileSync(popup.file, "utf8"), /script-src 'none'/);
});
