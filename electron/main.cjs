const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  DIRECT_EXTENSIONS,
  convertToEpub,
  extensionOf,
  findCalibreExecutable,
  inspectCalibre,
  isSupportedInput,
  safeBaseName,
} = require("./converter.cjs");

const DEVELOPMENT_URL = "http://127.0.0.1:5173";
const CALIBRE_HELP_URL = "https://calibre-ebook.com/download_portable";
const RENDERER_CONVERTED_EXTENSIONS = new Set(["pdf", "cbz", "zip"]);
const selectedFiles = new Map();
let mainWindow = null;
let pendingOpenRefs = [];

function isAllowedRendererURL(rawURL) {
  if (!rawURL) return false;
  try {
    const senderURL = new URL(rawURL);
    if (!app.isPackaged) {
      return senderURL.origin === DEVELOPMENT_URL;
    }
    if (senderURL.protocol !== "file:") return false;
    const pagePath = path.resolve(fileURLToPath(senderURL));
    const distRoot = path.resolve(app.getAppPath(), "dist");
    return pagePath === path.join(distRoot, "index.html") || pagePath.startsWith(`${distRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function isTrustedSender(event) {
  return isAllowedRendererURL(event.senderFrame?.url);
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("拒绝了来自非 ReadTaylor 页面的方法调用。");
}

function registerFile(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!isSupportedInput(absolutePath)) return null;
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const token = crypto.randomUUID();
  const sourceKey = crypto
    .createHash("sha256")
    .update(process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath)
    .digest("hex");
  const reference = {
    token,
    sourceKey,
    name: path.basename(absolutePath),
    extension: extensionOf(absolutePath),
    size: stat.size,
  };
  selectedFiles.set(token, absolutePath);
  return reference;
}

function registerFiles(filePaths) {
  return [...new Set(filePaths.map((item) => path.resolve(item)))]
    .map(registerFile)
    .filter(Boolean);
}

function commandLineBookPaths(argv) {
  return argv.filter((arg) => {
    if (!arg || arg.startsWith("--")) return false;
    try {
      return path.isAbsolute(arg) && fs.statSync(arg).isFile() && isSupportedInput(arg);
    } catch {
      return false;
    }
  });
}

function deliverOpenRefs(refs) {
  if (!refs.length) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("readtaylor:open-books", refs);
  } else {
    pendingOpenRefs.push(...refs);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 390,
    minHeight: 640,
    title: "ReadTaylor",
    backgroundColor: "#f5f0e8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererURL(url)) event.preventDefault();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingOpenRefs.length) {
      const refs = pendingOpenRefs;
      pendingOpenRefs = [];
      mainWindow.webContents.send("readtaylor:open-books", refs);
    }
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  } else {
    void mainWindow.loadURL(DEVELOPMENT_URL);
    if (process.env.READTAYLOR_OPEN_DEVTOOLS === "1") mainWindow.webContents.openDevTools();
  }
}

function calibreLocation() {
  return findCalibreExecutable({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

function conversionProgress(jobId, update) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("readtaylor:conversion-progress", {
    jobId,
    percent: update.percent,
    message: update.message,
  });
}

async function prepareSelectedBook(token, jobId) {
  const sourcePath = selectedFiles.get(token);
  if (!sourcePath) {
    return { ok: false, error: "这个文件授权已经失效，请重新选择书籍。" };
  }
  selectedFiles.delete(token);

  const sourceExtension = extensionOf(sourcePath);
  if (DIRECT_EXTENSIONS.has(sourceExtension) || RENDERER_CONVERTED_EXTENSIONS.has(sourceExtension)) {
    const data = await fs.promises.readFile(sourcePath);
    const mimeType = sourceExtension === "epub"
      ? "application/epub+zip"
      : sourceExtension === "pdf"
        ? "application/pdf"
        : sourceExtension === "cbz" || sourceExtension === "zip"
          ? "application/zip"
          : "text/plain";
    return {
      ok: true,
      name: path.basename(sourcePath),
      sourceExtension,
      mimeType,
      bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      converted: false,
    };
  }

  const calibre = calibreLocation();
  if (!calibre) {
    return {
      ok: false,
      code: "CALIBRE_MISSING",
      error: "尚未检测到本地转换引擎。请先把官方 Calibre 便携版加入 ReadTaylor。",
    };
  }

  let temporaryDirectory;
  try {
    temporaryDirectory = await fs.promises.mkdtemp(path.join(app.getPath("temp"), "readtaylor-"));
    const outputName = `${safeBaseName(sourcePath)}.epub`;
    const outputPath = path.join(temporaryDirectory, outputName);
    await convertToEpub({
      inputPath: sourcePath,
      outputPath,
      calibrePath: calibre.executablePath,
      onProgress: (update) => conversionProgress(jobId, update),
    });
    const data = await fs.promises.readFile(outputPath);
    return {
      ok: true,
      name: outputName,
      sourceExtension,
      mimeType: "application/epub+zip",
      bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      converted: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "本地转换失败。",
    };
  } finally {
    if (temporaryDirectory) {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function installIPCHandlers() {
  ipcMain.handle("readtaylor:pick-books", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择要加入 ReadTaylor 的书籍",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "电子书与文档",
          extensions: ["epub", "mobi", "azw", "azw3", "cbz", "cbr", "zip", "pdf", "txt", "md"],
        },
      ],
    });
    return result.canceled ? [] : registerFiles(result.filePaths);
  });

  ipcMain.handle("readtaylor:prepare-book", async (event, token, jobId) => {
    requireTrustedSender(event);
    if (typeof token !== "string" || typeof jobId !== "string") {
      return { ok: false, error: "无效的导入任务。" };
    }
    return prepareSelectedBook(token, jobId);
  });

  ipcMain.handle("readtaylor:get-toolchain", async (event) => {
    requireTrustedSender(event);
    return inspectCalibre(calibreLocation());
  });

  ipcMain.handle("readtaylor:open-calibre-help", async (event) => {
    requireTrustedSender(event);
    await shell.openExternal(CALIBRE_HELP_URL);
    return true;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    deliverOpenRefs(registerFiles(commandLineBookPaths(argv)));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    installIPCHandlers();
    createWindow();
    deliverOpenRefs(registerFiles(commandLineBookPaths(process.argv.slice(1))));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
