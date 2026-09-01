const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DIRECT_EXTENSIONS = new Set(["epub", "txt", "md"]);
const CONVERTIBLE_EXTENSIONS = new Set([
  "mobi",
  "azw",
  "azw3",
  "cbz",
  "cbr",
  "zip",
  "pdf",
]);
const SUPPORTED_EXTENSIONS = new Set([
  ...DIRECT_EXTENSIONS,
  ...CONVERTIBLE_EXTENSIONS,
]);
const COMIC_EXTENSIONS = new Set(["cbz", "cbr", "zip"]);

function extensionOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

function isSupportedInput(filePath) {
  return SUPPORTED_EXTENSIONS.has(extensionOf(filePath));
}

function safeBaseName(filePath) {
  const raw = path.basename(filePath, path.extname(filePath)).trim() || "book";
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  return cleaned.slice(0, 120) || "book";
}

function findNamedFile(root, fileName, maxDepth = 4) {
  if (!root || !fs.existsSync(root)) return null;
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const current = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        pending.push({ directory: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function resolveCandidate(candidate, executableName) {
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const direct = path.join(candidate, executableName);
      if (fs.existsSync(direct)) return direct;
      return findNamedFile(candidate, executableName);
    }
  } catch {
    return null;
  }
  return null;
}

function findCalibreExecutable({
  resourcesPath,
  appPath,
  env = process.env,
  platform = process.platform,
} = {}) {
  const executableName = platform === "win32" ? "ebook-convert.exe" : "ebook-convert";
  const candidates = [
    { value: env.READTAYLOR_CALIBRE_PATH, source: "environment" },
    { value: resourcesPath && path.join(resourcesPath, "calibre"), source: "bundled" },
    { value: appPath && path.join(appPath, "vendor", "calibre"), source: "development-bundle" },
  ];

  if (platform === "win32") {
    candidates.push(
      { value: "C:\\Program Files\\Calibre2", source: "system" },
      { value: "C:\\Program Files (x86)\\Calibre2", source: "system" }
    );
  } else if (platform === "darwin") {
    candidates.push({
      value: "/Applications/calibre.app/Contents/MacOS/ebook-convert",
      source: "system",
    });
  }

  for (const candidate of candidates) {
    const executablePath = resolveCandidate(candidate.value, executableName);
    if (executablePath) return { executablePath, source: candidate.source };
  }

  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const executablePath = path.join(directory, executableName);
    if (fs.existsSync(executablePath)) return { executablePath, source: "path" };
  }
  return null;
}

function classifyConversionFailure(log) {
  const text = String(log || "").toLowerCase();
  if (["drm", "encrypted", "this book is locked", "protected by"].some((m) => text.includes(m))) {
    return "这本书可能带有 DRM 或密码保护，ReadTaylor 不会移除保护。";
  }
  if (["not a rar file", "unrar", "bad magic", "corrupt", "truncated", "could not open"].some((m) => text.includes(m))) {
    return "无法读取这个文件，它可能已经损坏，或者压缩格式不受支持。";
  }
  if (["permission denied", "operation not permitted", "read-only file system"].some((m) => text.includes(m))) {
    return "没有权限写入临时 EPUB，请检查系统存储空间和文件权限。";
  }
  return "电子书转换失败，请确认文件未损坏且不带 DRM。";
}

function progressFromOutput(output) {
  const text = String(output || "");
  const percentages = [...text.matchAll(/(?:^|\s)(\d{1,3})(?:\.\d+)?%/gm)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 0 && value <= 100);
  if (percentages.length) return Math.max(...percentages);

  const lower = text.toLowerCase();
  if (lower.includes("inputformatplugin")) return 12;
  if (lower.includes("converting input to html")) return 28;
  if (lower.includes("running transforms")) return 48;
  if (lower.includes("creating epub output")) return 72;
  if (lower.includes("epub output written")) return 96;
  return null;
}

function runProcess(executablePath, args, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      onOutput?.(text, output);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, output }));
  });
}

function conversionArguments(inputPath, outputPath) {
  const extension = extensionOf(inputPath);
  const args = [
    inputPath,
    outputPath,
    "--epub-version=3",
    "--preserve-cover-aspect-ratio",
    "--disable-font-rescaling",
    "--pretty-print",
  ];
  if (COMIC_EXTENSIONS.has(extension)) {
    args.push(
      "--epub-max-image-size=none",
      "--margin-top=0",
      "--margin-right=0",
      "--margin-bottom=0",
      "--margin-left=0"
    );
  }
  return args;
}

function validateEpub(outputPath) {
  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size < 64) throw new Error("转换结果为空。");
  const handle = fs.openSync(outputPath, "r");
  try {
    const header = Buffer.alloc(4);
    fs.readSync(handle, header, 0, header.length, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error("转换结果不是有效的 EPUB 文件。");
    }
  } finally {
    fs.closeSync(handle);
  }
}

async function inspectCalibre(calibre) {
  if (!calibre) {
    return {
      available: false,
      source: null,
      version: null,
      message: "未检测到 Calibre。EPUB、PDF、CBZ、ZIP、TXT、MD 仍可在本机打开。",
    };
  }
  try {
    const result = await runProcess(calibre.executablePath, ["--version"]);
    const version = result.output.trim().split(/\r?\n/)[0] || "Calibre";
    return {
      available: result.exitCode === 0,
      source: calibre.source,
      version,
      message: result.exitCode === 0 ? "本地电子书转换可用" : "转换引擎无法启动",
    };
  } catch {
    return {
      available: false,
      source: calibre.source,
      version: null,
      message: "转换引擎无法启动",
    };
  }
}

async function convertToEpub({ inputPath, outputPath, calibrePath, onProgress }) {
  const extension = extensionOf(inputPath);
  if (!CONVERTIBLE_EXTENSIONS.has(extension)) {
    throw new Error(`.${extension || "unknown"} 不是需要转换的格式。`);
  }
  onProgress?.({ percent: 5, message: "正在准备本地转换…" });
  let latestProgress = 5;
  const result = await runProcess(
    calibrePath,
    conversionArguments(inputPath, outputPath),
    (_chunk, fullOutput) => {
      const parsed = progressFromOutput(fullOutput);
      if (parsed != null && parsed > latestProgress) {
        latestProgress = Math.min(parsed, 96);
        onProgress?.({ percent: latestProgress, message: `正在转换… ${latestProgress}%` });
      }
    }
  );
  if (result.exitCode !== 0) {
    const error = new Error(classifyConversionFailure(result.output));
    error.conversionLog = result.output;
    throw error;
  }
  validateEpub(outputPath);
  onProgress?.({ percent: 100, message: "EPUB 转换完成" });
  return { outputPath, log: result.output };
}

module.exports = {
  CONVERTIBLE_EXTENSIONS,
  DIRECT_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  classifyConversionFailure,
  convertToEpub,
  extensionOf,
  findCalibreExecutable,
  inspectCalibre,
  isSupportedInput,
  progressFromOutput,
  safeBaseName,
};
