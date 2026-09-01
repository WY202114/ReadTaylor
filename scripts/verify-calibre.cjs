const fs = require("node:fs");
const path = require("node:path");

const vendorRoot = path.resolve(__dirname, "..", "vendor", "calibre");

function find(root, name) {
  if (!fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length) {
    const directory = pending.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return fullPath;
      if (entry.isDirectory()) pending.push(fullPath);
    }
  }
  return null;
}

const executable = find(vendorRoot, process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert");
const sourceNotice = find(vendorRoot, "calibre-source.txt");
if (!executable || !sourceNotice) {
  console.error("Calibre has not been prepared. Run `npm run calibre:prepare` before building the installer.");
  process.exit(1);
}
console.log(`Bundled Calibre verified: ${executable}`);
