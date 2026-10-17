import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/pdf/position.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { loadPdfPosition, savePdfPosition, deletePdfPosition } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const store = new Map();
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
const position = { version: 1, sha256: "paper-a", pageNumber: 37, left: 44.5, top: 672.25, zoom: "page-width", rotation: 90, progress: 52, updatedAt: 1 };

test("physical location round-trips and never touches reflow positions", () => {
  store.clear(); store.set("readtaylor.reading-positions.v1", "legacy");
  assert.equal(savePdfPosition("paper", position), true);
  assert.deepEqual(loadPdfPosition("paper", "paper-a"), position);
  assert.equal(store.get("readtaylor.reading-positions.v1"), "legacy");
  assert.equal(loadPdfPosition("paper", "different-file"), undefined);
});
test("corrupt or incompatible locations are ignored", () => {
  for (const patch of [{ pageNumber: 0 }, { left: null }, { rotation: 45 }, { zoom: -1 }, { version: 2 }, { progress: 101 }, { updatedAt: -1 }]) {
    store.set("readtaylor.pdf-positions.v1", JSON.stringify({ paper: { ...position, ...patch } }));
    assert.equal(loadPdfPosition("paper"), undefined);
  }
  store.set("readtaylor.pdf-positions.v1", "corrupt");
  assert.equal(loadPdfPosition("paper"), undefined);
});
test("delete is scoped to one PDF and save failure is observable", () => {
  store.clear(); savePdfPosition("paper", position); savePdfPosition("other", position);
  deletePdfPosition("paper");
  assert.equal(loadPdfPosition("paper"), undefined);
  assert.deepEqual(loadPdfPosition("other"), position);
  const setItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("quota"); };
  assert.equal(savePdfPosition("paper", position), false);
  localStorage.setItem = setItem;
});

test("legacy books retain their reader and native PDF never reads reflow lastPage", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/books.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", external: ["pdfjs-dist", "pdfjs-dist/*", "jszip"] });
  const { loadBooks } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  const chapter = { id: "c1", title: "Legacy", content: "preserved text" };
  const legacy = { id: "old-pdf", fileType: "PDF", chapters: [chapter], lastChapter: 0, lastScroll: .3, progress: 30 };
  const epub = { ...legacy, id: "epub", fileType: "EPUB", mode: "fidelity" };
  const native = { ...legacy, id: "new-pdf", mode: "pdf", pdf: { sha256: "paper-a" } };
  store.clear();
  store.set("readtaylor.books.v1", JSON.stringify([legacy, epub, native]));
  store.set("readtaylor.reading-positions.v1", JSON.stringify({ "new-pdf": { lastChapter: 90, lastScroll: 1, lastPage: { index: 90 }, progress: 99 } }));
  savePdfPosition("new-pdf", position);
  const books = loadBooks();
  assert.deepEqual(books[0], legacy);
  assert.deepEqual(books[1], epub);
  assert.equal(books[2].lastPage, undefined);
  assert.equal(books[2].progress, position.progress);
  assert.equal(books[2].lastChapter, native.lastChapter);
});
