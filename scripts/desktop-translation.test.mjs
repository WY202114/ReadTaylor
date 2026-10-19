import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/desktopTranslation.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser" });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

test("web-only callers cannot send a batch or fall back to direct fetch", async () => {
  const previous = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = () => { throw new Error("renderer must not fetch"); };
  try {
    await assert.rejects(api.previewDesktopTranslationBatch({ segments: [{ id: "1", text: "Hello" }] }), /桌面版/);
    await assert.rejects(api.sendDesktopTranslationBatch("preview"), /桌面版/);
  } finally { globalThis.window = previous; globalThis.fetch = previousFetch; }
});

test("renderer only forwards batch data and single-use preview IDs through the named IPC bridge", async () => {
  const previous = globalThis.window;
  const calls = [];
  globalThis.window = { readTaylorDesktop: {
    previewTranslationBatch: async (batch) => { calls.push(batch); return { ok: true, data: { previewId: "mock-preview" } }; },
    sendTranslationBatch: async (id) => { calls.push(id); return { ok: false, code: "KEY_INVALID", error: "API Key 无效，请重新录入。" }; },
  } };
  try {
    const batch = { providerId: "deepseek", segments: [{ id: "1", text: "Hello" }] };
    assert.equal((await api.previewDesktopTranslationBatch(batch)).previewId, "mock-preview");
    await assert.rejects(api.sendDesktopTranslationBatch("mock-preview"), (error) => error.code === "KEY_INVALID");
    assert.deepEqual(calls, [batch, "mock-preview"]);
  } finally { globalThis.window = previous; }
});

test("presets contain only public defaults and local privacy notices use the actual hostname", () => {
  const defaults = api.defaultTranslationSettings();
  assert.equal(defaults.profiles.length, 7);
  assert.ok(defaults.profiles.every((p) => !Object.hasOwn(p, "apiKey") && !p.hasKey));
  assert.equal(defaults.profiles.find((p) => p.providerId === "kimi").temperature, null);
  assert.equal(api.translationDestination("http://localhost:11434/v1").local, true);
  assert.equal(api.translationDestination("https://localhost.attacker.test/v1").local, false);
  assert.equal(api.translationDestination("https://example.test/v1?key=test-only"), null);
});
