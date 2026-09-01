const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  classifyConversionFailure,
  extensionOf,
  findCalibreExecutable,
  isSupportedInput,
  progressFromOutput,
  safeBaseName,
} = require("./converter.cjs");

test("supported formats match the desktop import promise", () => {
  for (const extension of ["epub", "mobi", "azw", "azw3", "cbz", "cbr", "zip", "pdf", "txt", "md"]) {
    assert.equal(isSupportedInput(`example.${extension}`), true);
  }
  assert.equal(isSupportedInput("example.exe"), false);
  assert.equal(extensionOf("BOOK.AZW3"), "azw3");
});

test("output names cannot contain Windows path characters", () => {
  assert.equal(safeBaseName("C:\\books\\a:b?c*.mobi"), "a-b-c-");
});

test("conversion failures are explained in plain Chinese", () => {
  assert.match(classifyConversionFailure("This book is encrypted with DRM"), /DRM/);
  assert.match(classifyConversionFailure("bad magic: corrupt archive"), /损坏/);
  assert.match(classifyConversionFailure("permission denied"), /权限/);
});

test("conversion progress understands percentages and Calibre phases", () => {
  assert.equal(progressFromOutput("Converting input to HTML"), 28);
  assert.equal(progressFromOutput("step 14%\nstep 65%"), 65);
  assert.equal(progressFromOutput("EPUB output written to disk"), 96);
});

test("bundled Calibre is preferred when its executable exists", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readtaylor-converter-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, "calibre", "Calibre Portable", "Calibre");
  fs.mkdirSync(nested, { recursive: true });
  const executableName = process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert";
  const executable = path.join(nested, executableName);
  fs.writeFileSync(executable, "test");
  const found = findCalibreExecutable({ resourcesPath: root, appPath: root, env: { PATH: "" } });
  assert.equal(found.executablePath, executable);
  assert.equal(found.source, "bundled");
});
