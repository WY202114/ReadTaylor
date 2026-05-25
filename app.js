const STORAGE_KEY = "readTaylorState";
const EPUB_JS_URL = "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js";
// EPUB 本质是 zip 包，epub.js 解析时依赖 JSZip，必须先加载
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const PDF_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const GOOGLE_TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const TRANSLATION_DB_NAME = "readTaylorTranslations";
const TRANSLATION_DB_VERSION = 1;
const TRANSLATION_STORE = "sentenceTranslations";

const dom = {
  shell: document.querySelector(".app-shell"),
  fileInput: document.querySelector("#book-file"),
  bookFormat: document.querySelector("#book-format"),
  importStatus: document.querySelector("#import-status"),
  clearBook: document.querySelector("#clear-book"),
  bookTitle: document.querySelector("#book-title"),
  bookMeta: document.querySelector("#book-meta"),
  bookCard: document.querySelector("#book-card"),
  reader: document.querySelector("#reader"),
  readingPercent: document.querySelector("#reading-percent"),
  immersiveToggle: document.querySelector("#immersive-toggle"),
  translateToggle: document.querySelector("#translate-toggle"),
  translatorPanel: document.querySelector("#translator-panel"),
  translatorClose: document.querySelector("#translator-close"),
  translatorCurrent: document.querySelector("#translator-current"),
  translatorStatus: document.querySelector("#translator-status"),
  translateChapter: document.querySelector("#translate-chapter"),
  clearTranslation: document.querySelector("#clear-translation"),
  swapTranslationColumns: document.querySelector("#swap-translation-columns"),
  translateApiKeyRow: document.querySelector("#translate-api-key-row"),
  translateApiKey: document.querySelector("#translate-api-key"),
  translateEndpoint: document.querySelector("#translate-endpoint"),
  translateEndpointRow: document.querySelector("#translate-endpoint-row"),
  translateModel: document.querySelector("#translate-model"),
  translateModelRow: document.querySelector("#translate-model-row"),
  translateSource: document.querySelector("#translate-source"),
  translateTarget: document.querySelector("#translate-target"),
  translateView: document.querySelector("#translate-view"),
  translateChunkSize: document.querySelector("#translate-chunk-size"),
  modelPresets: document.querySelector("#model-presets"),
  providerButtons: {
    free: document.querySelector("#provider-free"),
    google: document.querySelector("#provider-google"),
    model: document.querySelector("#provider-model"),
  },
  bookmarkButton: document.querySelector("#bookmark-button"),
  restoreBookmark: document.querySelector("#restore-bookmark"),
  settingsToggle: document.querySelector("#settings-toggle"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  fontSize: document.querySelector("#font-size"),
  lineHeight: document.querySelector("#line-height"),
  themeButtons: {
    paper: document.querySelector("#theme-paper"),
    night: document.querySelector("#theme-night"),
    mist: document.querySelector("#theme-mist"),
  },
};

const defaultState = {
  book: null,
  chapters: [],
  currentChapterIndex: 0,
  scrollTop: 0,
  scrollByChapter: {},
  bookmark: null,
  immersive: false,
  translations: {},
  importFormat: "auto",
  translator: {
    panelOpen: false,
    provider: "free",
    apiKey: "",
    endpoint: "https://api.catcode.top",
    model: "",
    source: "auto",
    target: "zh-CN",
    view: "original",
    parallelMode: false,
    swapColumns: false,
    chunkSize: 3000,
  },
  settings: {
    theme: "paper",
    fontSize: 20,
    lineHeight: 1.8,
    // 底部设置栏是否展开（默认收起，腾出阅读空间）
    controlsOpen: false,
    // 双栏翻译模式左栏宽度占比（0.2 ~ 0.8）
    parallelRatio: 0.5,
    // 左侧书库栏是否展开：无书时强制展开；有书时默认收起，给正文让位
    sidebarOpen: true,
  },
};

let state = loadState();
let saveTimer = 0;
let scrollRestoreTimer = 0;
let virtualBook = createEmptyVirtualBook();
let virtualRenderFrame = 0;
let translationDbPromise = null;
const sentenceTranslationMemory = new Map();
const queuedSentenceTranslations = new Map();
const sentenceTranslationQueue = [];
let isSentenceTranslationQueueRunning = false;
const TRANSLATION_REQUEST_DELAY_MIN = 1000;
const TRANSLATION_REQUEST_DELAY_MAX = 2000;
const RATE_LIMIT_RETRY_LIMIT = 3;

// 当前在双栏翻译模式下被选中高亮的句对 cacheKey；null 表示无高亮
let focusedSentenceKey = null;
// 需要高亮的"对侧"栏：
//   "original"   —— 用户的点击/选中发生在译文栏，要高亮的是原文栏；
//   "translated" —— 反过来
let focusedSentenceSide = null;

init();

function init() {
  applySettings();
  renderAll();
  bindEvents();
}

function bindEvents() {
  dom.fileInput.addEventListener("change", handleFileImport);
  dom.bookFormat.addEventListener("change", (event) => {
    state.importFormat = event.target.value;
    saveState();
  });
  dom.clearBook.addEventListener("click", clearBook);
  dom.immersiveToggle.addEventListener("click", toggleImmersiveMode);
  dom.bookmarkButton.addEventListener("click", saveBookmark);
  dom.restoreBookmark.addEventListener("click", restoreBookmark);
  dom.settingsToggle.addEventListener("click", toggleReadingControls);
  if (dom.sidebarToggle) dom.sidebarToggle.addEventListener("click", toggleSidebar);
  // "翻译" 按钮：左键 = 一键开关；右键 / 长按 = 打开翻译设置面板
  dom.translateToggle.addEventListener("click", handleTranslateToggleClick);
  dom.translateToggle.addEventListener("contextmenu", handleTranslateToggleContextMenu);
  dom.translateToggle.addEventListener("pointerdown", handleTranslateTogglePointerDown);
  dom.translateToggle.addEventListener("pointerup", cancelTranslateToggleLongPress);
  dom.translateToggle.addEventListener("pointercancel", cancelTranslateToggleLongPress);
  dom.translateToggle.addEventListener("pointerleave", cancelTranslateToggleLongPress);
  dom.translatorClose.addEventListener("click", closeTranslatorPanel);
  dom.translateChapter.addEventListener("click", translateCurrentChapter);
  dom.clearTranslation.addEventListener("click", clearCurrentTranslation);
  dom.swapTranslationColumns.addEventListener("click", swapTranslationColumns);
  dom.reader.addEventListener("scroll", handleReaderScroll, { passive: true });
  // 双栏翻译模式下：点击任一侧 → 高亮对侧；拖选文本 → 同样高亮对侧
  dom.reader.addEventListener("click", handleSentencePairFocus);
  dom.reader.addEventListener("mouseup", handleSelectionFocus);
  // 选中正文中的纯英文 → 在选区附近弹出查词弹窗
  dom.reader.addEventListener("mouseup", handleLookupSelection);
  dom.fontSize.addEventListener("input", (event) => updateSetting("fontSize", Number(event.target.value)));
  dom.lineHeight.addEventListener("input", (event) => updateSetting("lineHeight", Number(event.target.value)));
  dom.translateApiKey.addEventListener("input", (event) => updateTranslator("apiKey", event.target.value.trim()));
  dom.translateEndpoint.addEventListener("input", (event) => updateTranslator("endpoint", event.target.value.trim()));
  dom.translateModel.addEventListener("input", (event) => updateTranslator("model", event.target.value.trim()));
  dom.translateSource.addEventListener("change", (event) => updateTranslator("source", event.target.value));
  dom.translateTarget.addEventListener("change", (event) => updateTranslator("target", event.target.value));
  dom.translateView.addEventListener("change", (event) => updateTranslator("view", event.target.value, true));
  dom.translateChunkSize.addEventListener("change", (event) => updateTranslator("chunkSize", Number(event.target.value)));
  dom.modelPresets.addEventListener("click", applyModelPreset);
  window.addEventListener("mousemove", handleImmersivePointer);

  Object.entries(dom.themeButtons).forEach(([theme, button]) => {
    button.addEventListener("click", () => updateSetting("theme", theme));
  });

  Object.entries(dom.providerButtons).forEach(([provider, button]) => {
    button.addEventListener("click", () => updateTranslator("provider", provider, true));
  });

  window.addEventListener("keydown", handleShortcuts);
  window.addEventListener("resize", rebuildVirtualLayout);
  window.addEventListener("beforeunload", persistCurrentScroll);
}

async function handleFileImport(event) {
  const [file] = event.target.files;
  if (!file) return;

  const format = resolveBookFormat(file);
  setImportStatus(`正在导入 ${format.toUpperCase()}...`, "loading");

  try {
    const parsed = await parseBookFile(file, format);
    state = {
      ...state,
      book: {
        title: parsed.title || file.name.replace(/\.[^.]+$/, "") || "未命名书籍",
        fileName: file.name,
        format,
        size: file.size,
        importedAt: Date.now(),
      },
      chapters: parsed.chapters,
      currentChapterIndex: 0,
      scrollTop: 0,
      scrollByChapter: {},
      bookmark: null,
      translations: {},
      // 导入成功后自动收起书库栏，把空间让给正文
      settings: { ...state.settings, sidebarOpen: false },
    };
    saveState();
    renderAll();
    restoreScroll(0);
    dom.reader.focus();
    setImportStatus(`导入完成：${parsed.chapters.length} 章`, "success");
  } catch (error) {
    setImportStatus(getImportErrorMessage(error), "error");
  }

  event.target.value = "";
}

function resolveBookFormat(file) {
  if (state.importFormat && state.importFormat !== "auto") {
    return state.importFormat;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  const knownFormats = ["txt", "epub", "mobi", "azw3", "pdf"];
  return knownFormats.includes(extension) ? extension : "txt";
}

async function parseBookFile(file, format) {
  if (format === "txt") {
    const text = normalizeText(decodeBookText(await file.arrayBuffer()));
    return {
      title: file.name.replace(/\.[^.]+$/, ""),
      chapters: splitIntoChapters(text),
    };
  }

  if (format === "epub") {
    return parseEpubFile(file);
  }

  if (format === "pdf") {
    return parsePdfFile(file);
  }

  if (format === "mobi" || format === "azw3") {
    throw new Error("MOBI/AZW3 是 Kindle 专用格式，浏览器端暂不直接解析。建议先用 Calibre 转成 EPUB 或 TXT 后再导入。");
  }

  throw new Error("暂不支持这个导入格式。");
}

async function parseEpubFile(file) {
  // 必须先加载 JSZip，否则 epub.js 会抛 "JSZip lib not loaded"
  await loadScript(JSZIP_URL, "JSZip");
  await loadScript(EPUB_JS_URL, "ePub");

  const book = window.ePub(await file.arrayBuffer());
  const metadata = await book.loaded.metadata.catch(() => ({}));
  await book.ready;

  // 尝试用 NCX/Nav 拿到友好的章节标题（按 href 映射）
  const navTitleByHref = await loadEpubNavTitles(book);

  const spineItems = book.spine?.spineItems || [];
  const chapters = [];
  const errors = [];

  for (let i = 0; i < spineItems.length; i += 1) {
    const item = spineItems[i];
    const href = item.href || item.url || "";
    try {
      // 用 book.load(href) 拿 Document，比 section.load(...) 兼容性更好
      const doc = await book.load(href);
      if (!doc || typeof doc.querySelector !== "function") {
        continue;
      }
      const text = normalizeText(getDocumentText(doc));
      if (!text) continue;

      const title =
        navTitleByHref.get(stripHash(href)) ||
        getEpubSectionTitle(doc) ||
        item.label ||
        href ||
        `第 ${chapters.length + 1} 节`;

      chapters.push({
        title: String(title).trim(),
        text,
        wordCount: countReadableChars(text),
      });
    } catch (error) {
      errors.push({ href, error });
    }
  }

  book.destroy?.();

  if (!chapters.length) {
    // 把每个失败的具体错误打到控制台，方便排查（比如 DRM、加密、路径解析）
    if (errors.length) {
      console.warn("EPUB 解析失败的小节：", errors);
    }
    throw new Error("没有从 EPUB 中读取到正文内容。");
  }

  return {
    title: metadata?.title || file.name.replace(/\.[^.]+$/, ""),
    chapters,
  };
}

// 从 EPUB 的目录（nav 或 ncx）中收集 href → 标题 的映射
async function loadEpubNavTitles(book) {
  const map = new Map();
  try {
    const nav = await book.loaded.navigation;
    const toc = nav?.toc || [];
    const walk = (items) => {
      items.forEach((entry) => {
        if (entry?.href) map.set(stripHash(entry.href), entry.label || "");
        if (Array.isArray(entry?.subitems) && entry.subitems.length) walk(entry.subitems);
      });
    };
    walk(toc);
  } catch {
    // 目录读取失败不影响正文，忽略
  }
  return map;
}

// EPUB href 经常带 #fragment，做章节标题映射时要去掉
function stripHash(href) {
  return String(href || "").split("#")[0];
}

async function parsePdfFile(file) {
  await loadScript(PDF_JS_URL, "pdfjsLib");
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalizeText(joinPdfTextItems(content.items || []));
    pageTexts.push(text);
  }

  const fullText = normalizeText(pageTexts.filter(Boolean).join("\n\n"));

  if (!fullText) {
    throw new Error("这个 PDF 没有可提取的文本层，可能是扫描版图片 PDF。");
  }

  const detectedChapters = splitIntoChapters(fullText);
  const chapters =
    detectedChapters.length > 1
      ? detectedChapters
      : createPdfPageChapters(pageTexts, 8);

  return {
    title: file.name.replace(/\.[^.]+$/, ""),
    chapters,
  };
}

function getEpubSectionTitle(doc) {
  return (
    doc.querySelector("h1, h2, h3, title")?.textContent ||
    doc.querySelector("[epub\\:type='title']")?.textContent ||
    ""
  );
}

function getDocumentText(doc) {
  const body = doc.body || doc.documentElement;
  if (!body) return "";

  // 去掉无关元素后取文本：textContent 优先（未挂载到 DOM 的 Document 上 innerText 多半为空）
  body.querySelectorAll("script, style, nav, svg, header, footer").forEach((node) => node.remove());

  // 按块级元素插入换行，避免段落被拼成一行
  const blockSelectors = "p, div, br, h1, h2, h3, h4, h5, h6, li, blockquote, section, article";
  const parts = [];
  body.querySelectorAll(blockSelectors).forEach((el) => {
    if (el.tagName === "BR") {
      parts.push("\n");
    } else {
      const piece = (el.textContent || "").trim();
      if (piece) parts.push(piece + "\n");
    }
  });

  // 如果按块级元素没拿到内容（结构很扁），回退到整段 textContent
  const composed = parts.join("").trim();
  if (composed) return composed;
  return (body.textContent || "").trim();
}

function joinPdfTextItems(items) {
  let lastY = null;
  let text = "";

  items.forEach((item) => {
    const y = Math.round(item.transform?.[5] || 0);
    const value = item.str || "";

    if (!value.trim()) return;

    if (lastY !== null && Math.abs(y - lastY) > 5) {
      text += "\n";
    } else if (text && !text.endsWith("\n")) {
      text += " ";
    }

    text += value;
    lastY = y;
  });

  return text;
}

function createPdfPageChapters(pageTexts, groupSize) {
  const chapters = [];

  for (let index = 0; index < pageTexts.length; index += groupSize) {
    const group = pageTexts.slice(index, index + groupSize).filter(Boolean);
    if (!group.length) continue;

    const startPage = index + 1;
    const endPage = Math.min(index + groupSize, pageTexts.length);
    const text = normalizeText(group.join("\n\n"));

    chapters.push({
      title: startPage === endPage ? `第 ${startPage} 页` : `第 ${startPage}-${endPage} 页`,
      text,
      wordCount: countReadableChars(text),
    });
  }

  return chapters;
}

function loadScript(src, globalName) {
  if (window[globalName]) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`无法加载 ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.append(script);
  });
}

function decodeBookText(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : new ArrayBuffer(0);
  const encodings = ["utf-8", "gb18030", "gbk"];

  for (const encoding of encodings) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes);
      if (decoded.trim()) return decoded;
    } catch {
      // Try the next common Chinese TXT encoding.
    }
  }

  return new TextDecoder().decode(bytes);
}

function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u3000/g, "　")
    .trim();
}

function splitIntoChapters(text) {
  if (!text) {
    return [];
  }

  const chapterPattern =
    /(?:^|\n)\s*((?:第[零〇一二三四五六七八九十百千万\d]+[章节卷回部集篇]|Chapter\s+\d+|CHAPTER\s+\d+|番外|楔子|序章|终章|后记|尾声)[^\n]{0,48})\s*(?=\n)/g;
  const matches = [...text.matchAll(chapterPattern)];

  if (!matches.length) {
    return [
      {
        title: "正文",
        text,
        wordCount: countReadableChars(text),
      },
    ];
  }

  const chapters = [];
  const firstIndex = matches[0].index || 0;
  const preface = text.slice(0, firstIndex).trim();

  if (preface) {
    chapters.push({
      title: "开篇",
      text: preface,
      wordCount: countReadableChars(preface),
    });
  }

  matches.forEach((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    const chapterText = text.slice(start, end).trim();
    const title = match[1].trim();
    chapters.push({
      title,
      text: chapterText.replace(title, "").trim() || chapterText,
      wordCount: countReadableChars(chapterText),
    });
  });

  return chapters;
}

function countReadableChars(text) {
  return text.replace(/\s/g, "").length;
}

function renderAll() {
  // 先刷新 shell 上的主题/书库/沉浸等类，再渲染内容，避免状态错位
  applySettings();
  renderBook();
  renderReader();
  applyTranslatorSettings();
  updateButtons();
  updateProgress();
}

function renderBook() {
  const hasBook = Boolean(state.book);
  dom.bookCard.classList.toggle("empty", !hasBook);
  dom.bookTitle.textContent = hasBook ? state.book.title : "还没有导入书";
  dom.bookMeta.textContent = hasBook
    ? `${(state.book.format || "txt").toUpperCase()} · ${state.chapters.length} 章 · ${formatSize(state.book.size)}`
    : "选择书籍格式并导入文件";
  dom.clearBook.disabled = !hasBook;
}

function renderReader() {
  if (!state.chapters.length) {
    virtualBook = createEmptyVirtualBook();
    dom.reader.innerHTML = `
      <section class="empty-state">
        <div class="empty-art" aria-hidden="true"><div></div><span></span></div>
        <h2>导入一本电子书</h2>
        <p>支持 TXT、EPUB 和 PDF 阅读；导入前可以手动选择格式，也可以让网站按文件后缀自动识别。</p>
        <label class="inline-import" for="book-file">选择文件</label>
      </section>
    `;
    return;
  }

  virtualBook = buildVirtualBook();
  dom.reader.replaceChildren(createVirtualReaderShell());
  restoreScroll(state.scrollTop || state.scrollByChapter[state.currentChapterIndex] || 0);
  renderVirtualWindow();
  updateCurrentChapterFromScroll();
}

function createParagraph(text, kind) {
  const p = document.createElement("p");
  p.className = kind === "translated" ? "translated-paragraph" : "original-paragraph";
  p.textContent = text;
  return p;
}

function splitParagraphs(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .flatMap(splitLongParagraph)
    .filter(Boolean);
}

function splitLongParagraph(line) {
  const maxLength = 700;
  if (line.length <= maxLength) {
    return [line];
  }

  const parts = [];
  let remaining = line;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakPoint = Math.max(
      slice.lastIndexOf("。"),
      slice.lastIndexOf("！"),
      slice.lastIndexOf("？"),
      slice.lastIndexOf("."),
      slice.lastIndexOf("!"),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("；"),
      slice.lastIndexOf(";")
    );
    const end = breakPoint > 160 ? breakPoint + 1 : maxLength;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function createEmptyVirtualBook() {
  return {
    blocks: [],
    offsets: [],
    chapterOffsets: [],
    totalHeight: 0,
    averageParagraphHeight: 44,
    renderedRange: [-1, -1],
  };
}

function openTranslationDb() {
  if (translationDbPromise) return translationDbPromise;

  translationDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TRANSLATION_DB_NAME, TRANSLATION_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRANSLATION_STORE)) {
        db.createObjectStore(TRANSLATION_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return translationDbPromise;
}

async function getCachedSentenceTranslation(key) {
  if (sentenceTranslationMemory.has(key)) {
    return sentenceTranslationMemory.get(key);
  }

  let db;
  try {
    db = await openTranslationDb();
  } catch {
    return "";
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSLATION_STORE, "readonly");
    const store = transaction.objectStore(TRANSLATION_STORE);
    const request = store.get(key);

    request.onsuccess = () => {
      const value = request.result?.translation || "";
      if (value) {
        sentenceTranslationMemory.set(key, value);
      }
      resolve(value);
    };
    request.onerror = () => reject(request.error);
  });
}

async function setCachedSentenceTranslation(key, translation, meta) {
  sentenceTranslationMemory.set(key, translation);
  let db;
  try {
    db = await openTranslationDb();
  } catch {
    return;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSLATION_STORE, "readwrite");
    const store = transaction.objectStore(TRANSLATION_STORE);
    const request = store.put({
      key,
      translation,
      ...meta,
      updatedAt: Date.now(),
    });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function buildVirtualBook() {
  const blocks = [];
  const chapterOffsets = [];
  let totalHeight = 0;
  const metrics = getReaderMetrics();

  state.chapters.forEach((chapter, chapterIndex) => {
    chapterOffsets[chapterIndex] = totalHeight;

    getChapterDisplayParagraphs(chapter, chapterIndex).forEach((paragraph) => {
      const block = {
        ...paragraph,
        chapterIndex,
        height: estimateBlockHeight(paragraph, metrics),
      };
      blocks.push(block);
      totalHeight += block.height;
    });
  });

  const offsets = [];
  let offset = 0;
  blocks.forEach((block) => {
    offsets.push(offset);
    offset += block.height;
  });

  return {
    blocks,
    offsets,
    chapterOffsets,
    totalHeight,
    averageParagraphHeight: metrics.fontSize * metrics.lineHeight + metrics.fontSize,
    renderedRange: [-1, -1],
  };
}

function getChapterDisplayParagraphs(chapter, chapterIndex) {
  if (isParallelTranslationEnabled()) {
    return getChapterSentencePairs(chapter, chapterIndex);
  }

  const originalParagraphs = splitParagraphs(chapter.text);
  const translatedParagraphs = getTranslationForChapter(chapterIndex)?.paragraphs || [];
  const view = state.translator.view;

  if (view === "translated" && translatedParagraphs.length) {
    return translatedParagraphs.map((text, paragraphIndex) => ({
      type: "paragraph",
      kind: "translated",
      paragraphIndex,
      text,
    }));
  }

  if (view === "bilingual" && translatedParagraphs.length) {
    const paragraphs = [];
    const total = Math.max(originalParagraphs.length, translatedParagraphs.length);

    for (let index = 0; index < total; index += 1) {
      if (originalParagraphs[index]) {
        paragraphs.push({
          type: "paragraph",
          kind: "original",
          paragraphIndex: index,
          text: originalParagraphs[index],
        });
      }

      if (translatedParagraphs[index]) {
        paragraphs.push({
          type: "paragraph",
          kind: "translated",
          paragraphIndex: index,
          text: translatedParagraphs[index],
        });
      }
    }

    return paragraphs;
  }

  return originalParagraphs.map((text, paragraphIndex) => ({
    type: "paragraph",
    kind: "original",
    paragraphIndex,
    text,
  }));
}

function isParallelTranslationEnabled() {
  return state.translator.parallelMode || state.translator.view === "parallel";
}

function getChapterSentencePairs(chapter, chapterIndex) {
  const sentences = splitSentences(chapter.text);

  return sentences.map((text, sentenceIndex) => ({
    type: "sentence-pair",
    kind: "parallel",
    chapterIndex,
    sentenceIndex,
    paragraphIndex: sentenceIndex,
    text,
    cacheKey: createSentenceCacheKey(text),
  }));
}

// 将一段文本切成"一句一行"。
// 设计要点：
//   - 中日韩句末标点（。！？；…）一律直接断句；
//   - 英文 . ! ? 需要避开 acm.org、Vol. 54、S. Khan、et al.、U.S.A. 等缩写/初始字母/网址；
//   - 不在词内部断句（"acm.org" 这种 . 后面紧跟非空字符时跳过）。
function splitSentences(text) {
  const normalized = normalizeText(text).replace(/\n+/g, " ").replace(/[ \t]+/g, " ");
  if (!normalized) return [];

  const sentences = [];
  let buffer = "";
  const len = normalized.length;

  for (let i = 0; i < len; i += 1) {
    const char = normalized[i];
    buffer += char;

    // CJK 句末标点：直接断句
    if (/[。！？；…]/.test(char)) {
      pushSentence(sentences, buffer);
      buffer = "";
      continue;
    }

    // 英文 . ! ?：需要严格判断，避免缩写/网址/小数点等场景的误断
    if (/[.!?]/.test(char)) {
      const next = normalized[i + 1];
      // 后面紧跟非空字符（如 acm.org、3.14）说明是词内 . 不是句末
      if (next && !/\s/.test(next)) continue;

      // 找下一个非空字符，判断是不是像新句开头
      let nextNonSpace = "";
      for (let j = i + 1; j < len; j += 1) {
        if (!/\s/.test(normalized[j])) {
          nextNonSpace = normalized[j];
          break;
        }
      }
      // 下一个实体是小写字母或数字（"Vol. 54"、"No. 10s"），多半不是真正句末
      if (nextNonSpace && /[a-z0-9]/.test(nextNonSpace)) continue;

      // 看本段末尾的最后一个词，判断是否是缩写
      const beforeDot = buffer.slice(0, -1);
      const lastWord = (beforeDot.match(/(\S+)$/) || ["", ""])[1];
      if (isLikelyAbbreviation(lastWord)) continue;

      pushSentence(sentences, buffer);
      buffer = "";
    }
  }

  pushSentence(sentences, buffer);
  return sentences.flatMap((sentence) => splitLongSentence(sentence, 420));
}

// 判断一个词是不是常见缩写或人名初始字母，用来避免误断
function isLikelyAbbreviation(word) {
  if (!word) return false;
  // 单个 ASCII 字母（"S"、"K"）：当成人名首字母
  if (word.length === 1 && /[A-Za-z]/.test(word)) return true;
  // 字母+点反复组合的缩写（"U.S"、"U.S.A"、"e.g"、"i.e"）
  if (/^([A-Za-z]\.)+[A-Za-z]?$/.test(word)) return true;
  // 常见学术/称谓缩写词典
  const known = new Set([
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs",
    "etc", "eg", "ie", "al", "ed", "eds",
    "vol", "no", "nos", "fig", "figs", "eq", "eqs", "ref", "refs", "pp",
    "inc", "ltd", "co", "corp",
    "am", "pm",
    "comput", "surv", "trans", "sci", "tech", "syst", "proc", "rev", "j",
  ]);
  return known.has(word.toLowerCase());
}

function pushSentence(sentences, value) {
  const sentence = value.trim();
  if (sentence) {
    sentences.push(sentence);
  }
}

function splitLongSentence(sentence, maxLength) {
  if (sentence.length <= maxLength) {
    return [sentence];
  }

  const parts = [];
  let remaining = sentence;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakPoint = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf(","), slice.lastIndexOf("、"), slice.lastIndexOf(" "));
    const end = breakPoint > 120 ? breakPoint + 1 : maxLength;
    parts.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function getReaderMetrics() {
  const styles = getComputedStyle(dom.reader);
  const contentWidth = dom.reader.querySelector(".reader-content")?.clientWidth || dom.reader.clientWidth || 760;
  const fontSize = Number.parseFloat(styles.getPropertyValue("--read-font-size")) || state.settings.fontSize || 20;
  const lineHeight = Number.parseFloat(styles.getPropertyValue("--read-line-height")) || state.settings.lineHeight || 1.8;

  return {
    width: Math.max(320, contentWidth),
    fontSize,
    lineHeight,
  };
}

function estimateParagraphHeight(text, metrics, kind) {
  const readableWidth = metrics.width;
  const charsPerLine = Math.max(12, Math.floor(readableWidth / (metrics.fontSize * 0.95)));
  const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
  const lineHeightPx = metrics.fontSize * metrics.lineHeight;
  const margin = kind === "translated" ? metrics.fontSize * 0.8 : metrics.fontSize;
  return Math.ceil(lines * lineHeightPx + margin);
}

function estimateBlockHeight(block, metrics) {
  if (block.type === "sentence-pair") {
    const columnWidth = Math.max(220, (metrics.width - 28) / 2);
    const charsPerLine = Math.max(10, Math.floor(columnWidth / (metrics.fontSize * 0.95)));
    const lines = Math.max(1, Math.ceil(block.text.length / charsPerLine));
    return Math.ceil(lines * metrics.fontSize * metrics.lineHeight + metrics.fontSize * 1.4);
  }

  return estimateParagraphHeight(block.text, metrics, block.kind);
}

function createVirtualReaderShell() {
  const content = document.createElement("div");
  content.className = "reader-content virtual-reader";
  content.style.height = `${Math.max(virtualBook.totalHeight, dom.reader.clientHeight)}px`;

  const topSpacer = document.createElement("div");
  topSpacer.className = "virtual-spacer virtual-spacer-top";

  const windowNode = document.createElement("div");
  windowNode.className = "virtual-window";

  content.append(topSpacer, windowNode);

  // 双栏翻译模式下追加一条可拖动的分界线（独立浮层，不影响虚拟列表渲染）
  if (isParallelTranslationEnabled()) {
    content.append(createParallelDivider());
  }

  return content;
}

// 创建双栏翻译模式下的可拖动分界线
function createParallelDivider() {
  const divider = document.createElement("div");
  divider.className = "parallel-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "拖动调整左右两栏宽度");
  divider.title = "拖动以调整左右栏宽度";
  bindParallelDividerDrag(divider);
  return divider;
}

// 绑定分界线的拖动交互：实时更新 --parallel-ratio，释放时持久化并重排虚拟布局
function bindParallelDividerDrag(divider) {
  function handleMove(event) {
    const host = divider.parentElement;
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    // 与 CSS 中 left = ratio*(W-24)+12 一致：反解 ratio = (x-12)/(W-24)
    const usable = bounds.width - 24;
    if (usable <= 0) return;
    const ratio = clamp((event.clientX - bounds.left - 12) / usable, 0.2, 0.8);
    state.settings.parallelRatio = ratio;
    dom.shell.style.setProperty("--parallel-ratio", ratio.toFixed(3));
  }

  function handleUp(event) {
    divider.classList.remove("dragging");
    try {
      divider.releasePointerCapture(event.pointerId);
    } catch {
      // 浏览器可能未支持指针捕获，忽略即可
    }
    document.removeEventListener("pointermove", handleMove);
    document.removeEventListener("pointerup", handleUp);
    document.removeEventListener("pointercancel", handleUp);
    saveState();
    // 比例变化后段落自动换行结果会变，重算虚拟高度以保持滚动稳定
    rebuildVirtualLayout();
  }

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    divider.classList.add("dragging");
    try {
      divider.setPointerCapture(event.pointerId);
    } catch {
      // 同上：捕获失败不影响后续 move/up 监听
    }
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
  });
}

function scheduleVirtualRender() {
  if (virtualRenderFrame) return;
  virtualRenderFrame = window.requestAnimationFrame(() => {
    virtualRenderFrame = 0;
    renderVirtualWindow();
  });
}

function renderVirtualWindow() {
  if (!virtualBook.blocks.length) return;

  const content = dom.reader.querySelector(".virtual-reader");
  const topSpacer = dom.reader.querySelector(".virtual-spacer-top");
  const windowNode = dom.reader.querySelector(".virtual-window");
  if (!content || !topSpacer || !windowNode) return;

  const buffer = Math.max(900, dom.reader.clientHeight * 1.3);
  const startY = Math.max(0, dom.reader.scrollTop - buffer);
  const endY = dom.reader.scrollTop + dom.reader.clientHeight + buffer;
  const startIndex = findBlockIndexAt(startY);
  const endIndex = Math.min(virtualBook.blocks.length - 1, findBlockIndexAt(endY) + 1);

  if (virtualBook.renderedRange[0] === startIndex && virtualBook.renderedRange[1] === endIndex) {
    return;
  }

  virtualBook.renderedRange = [startIndex, endIndex];
  const top = virtualBook.offsets[startIndex] || 0;
  topSpacer.style.height = `${top}px`;
  windowNode.style.transform = `translateY(${top}px)`;
  windowNode.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (let index = startIndex; index <= endIndex; index += 1) {
    fragment.append(createVirtualBlock(virtualBook.blocks[index], index));
  }

  windowNode.append(fragment);
  measureRenderedBlocks(startIndex, windowNode);
  hydrateVisibleSentenceTranslations(windowNode);
  content.style.height = `${Math.max(virtualBook.totalHeight, dom.reader.clientHeight)}px`;
}

function createVirtualBlock(block, index) {
  if (block.type === "sentence-pair") {
    return createSentencePairBlock(block, index);
  }

  const paragraph = createParagraph(block.text, block.kind);
  paragraph.dataset.virtualIndex = String(index);
  return paragraph;
}

function createSentencePairBlock(block, index) {
  const row = document.createElement("div");
  row.className = "sentence-pair";
  row.dataset.virtualIndex = String(index);
  row.dataset.cacheKey = block.cacheKey;
  // 虚拟列表滚动后重新创建的句对，若就是当前焦点行，应恢复行级与对侧栏的高亮
  const isFocusedRow = Boolean(block.cacheKey) && block.cacheKey === focusedSentenceKey;
  if (isFocusedRow) {
    row.classList.add("is-focused");
  }

  const original = document.createElement("p");
  original.className = "sentence-cell original-cell";
  original.textContent = block.text;
  if (isFocusedRow && focusedSentenceSide === "original") {
    original.classList.add("is-cell-focused");
  }

  const translated = document.createElement("p");
  translated.className = "sentence-cell translated-cell";
  translated.textContent = getSentenceMemoryValue(block.cacheKey) || "翻译中...";
  if (isFocusedRow && focusedSentenceSide === "translated") {
    translated.classList.add("is-cell-focused");
  }

  if (state.translator.swapColumns) {
    row.append(translated, original);
  } else {
    row.append(original, translated);
  }

  return row;
}

function getSentenceMemoryValue(key) {
  return sentenceTranslationMemory.get(key) || "";
}

function measureRenderedBlocks(startIndex, windowNode) {
  let changed = false;
  const children = [...windowNode.children];

  children.forEach((node, childIndex) => {
    const blockIndex = startIndex + childIndex;
    const block = virtualBook.blocks[blockIndex];
    if (!block) return;

    const styles = getComputedStyle(node);
    const measured =
      node.getBoundingClientRect().height +
      Number.parseFloat(styles.marginTop || "0") +
      Number.parseFloat(styles.marginBottom || "0");
    const height = Math.max(24, Math.ceil(measured));

    if (Math.abs(height - block.height) > 2) {
      block.height = height;
      changed = true;
    }
  });

  if (changed) {
    recomputeVirtualOffsets();
    const content = dom.reader.querySelector(".virtual-reader");
    if (content) {
      content.style.height = `${Math.max(virtualBook.totalHeight, dom.reader.clientHeight)}px`;
    }
  }
}

function recomputeVirtualOffsets() {
  let offset = 0;
  let activeChapter = -1;

  virtualBook.blocks.forEach((block, index) => {
    virtualBook.offsets[index] = offset;

    if (block.chapterIndex !== activeChapter) {
      virtualBook.chapterOffsets[block.chapterIndex] = offset;
      activeChapter = block.chapterIndex;
    }

    offset += block.height;
  });

  virtualBook.totalHeight = offset;
}

function hydrateVisibleSentenceTranslations(windowNode) {
  if (!isParallelTranslationEnabled()) return;

  const rows = [...windowNode.querySelectorAll(".sentence-pair")];
  rows.forEach((row) => {
    const index = Number(row.dataset.virtualIndex);
    const block = virtualBook.blocks[index];
    if (!block || !block.cacheKey) return;
    hydrateSentenceRow(row, block);
  });
}

async function hydrateSentenceRow(row, block) {
  const cached = sentenceTranslationMemory.get(block.cacheKey) || (await getCachedSentenceTranslation(block.cacheKey));

  if (cached) {
    updateSentenceRow(row, cached, "ready");
    return;
  }

  if (!canUseParallelTranslator()) {
    updateSentenceRow(row, "请在翻译设置中填写 API Key 和模型名。", "missing");
    return;
  }

  queueSentenceTranslation(block);
}

function updateSentenceRow(row, text, status) {
  const cell = row.querySelector(".translated-cell");
  if (!cell) return;
  cell.textContent = text;
  row.dataset.status = status;
}

function canUseParallelTranslator() {
  return Boolean(state.translator.apiKey && state.translator.endpoint && state.translator.model);
}

function queueSentenceTranslation(block) {
  if (queuedSentenceTranslations.has(block.cacheKey)) return;

  updateRenderedSentence(block.cacheKey, "翻译排队中", "loading");
  const item = {
    cacheKey: block.cacheKey,
    text: block.text,
  };
  queuedSentenceTranslations.set(block.cacheKey, item);
  sentenceTranslationQueue.push(item);
  setTranslatorStatus(`翻译排队中：还有 ${sentenceTranslationQueue.length} 条等待处理。`, "loading");
  runSentenceTranslationQueue();
}

async function runSentenceTranslationQueue() {
  if (isSentenceTranslationQueueRunning) return;
  isSentenceTranslationQueueRunning = true;

  while (sentenceTranslationQueue.length) {
    const item = sentenceTranslationQueue.shift();
    if (!item || queuedSentenceTranslations.get(item.cacheKey) !== item) continue;

    updateRenderedSentence(item.cacheKey, "翻译中...", "loading");
    setTranslatorStatus(`翻译排队中：正在处理 1 条，剩余 ${sentenceTranslationQueue.length} 条。`, "loading");

    try {
      const translation = await translateSentenceWithModel(item.text);
      await setCachedSentenceTranslation(item.cacheKey, translation, {
        source: detectLanguage(item.text),
        target: state.translator.target,
        model: state.translator.model,
        endpoint: normalizeBaseUrl(state.translator.endpoint),
        textHash: hashText(item.text),
      });
      updateRenderedSentence(item.cacheKey, translation);
    } catch (error) {
      updateRenderedSentence(item.cacheKey, getTranslateErrorMessage(error), "error");
      setTranslatorStatus(getTranslateErrorMessage(error), "error");
    } finally {
      queuedSentenceTranslations.delete(item.cacheKey);
    }

    if (sentenceTranslationQueue.length) {
      await waitForNextTranslationRequest();
    }
  }

  isSentenceTranslationQueueRunning = false;
  if (queuedSentenceTranslations.size === 0) {
    setTranslatorStatus("可见内容已按队列翻译并缓存。", "success");
  }
}

function legacyQueueSentenceTranslation(block) {
  if (pendingSentenceTranslations.has(block.cacheKey)) return;

  updateRenderedSentence(block.cacheKey, "翻译中...", "loading");
  const promise = translateSentenceWithModel(block.text)
    .then(async (translation) => {
      await setCachedSentenceTranslation(block.cacheKey, translation, {
        source: detectLanguage(block.text),
        target: state.translator.target,
        model: state.translator.model,
        endpoint: normalizeBaseUrl(state.translator.endpoint),
        textHash: hashText(block.text),
      });
      updateRenderedSentence(block.cacheKey, translation);
      setTranslatorStatus("可见内容已按句翻译并缓存。", "success");
    })
    .catch((error) => {
      updateRenderedSentence(block.cacheKey, getTranslateErrorMessage(error), "error");
      setTranslatorStatus(getTranslateErrorMessage(error), "error");
    })
    .finally(() => {
      pendingSentenceTranslations.delete(block.cacheKey);
    });

  pendingSentenceTranslations.set(block.cacheKey, promise);
}

function updateRenderedSentence(cacheKey, translation, status = "ready") {
  dom.reader.querySelectorAll(`.sentence-pair[data-cache-key="${cssEscape(cacheKey)}"]`).forEach((row) => {
    updateSentenceRow(row, translation, status);
  });
}

function findBlockIndexAt(scrollTop) {
  let low = 0;
  let high = virtualBook.offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const blockTop = virtualBook.offsets[mid];
    const blockBottom = blockTop + virtualBook.blocks[mid].height;

    if (scrollTop < blockTop) {
      high = mid - 1;
    } else if (scrollTop >= blockBottom) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return clamp(low, 0, Math.max(0, virtualBook.blocks.length - 1));
}

function scrollToChapter(index) {
  if (!state.chapters.length) return;
  const target = clamp(index, 0, state.chapters.length - 1);
  const offset = virtualBook.chapterOffsets[target] || 0;
  state.currentChapterIndex = target;
  dom.reader.scrollTo({
    top: offset,
    behavior: "smooth",
  });
  updateButtons();
}

function updateCurrentChapterFromScroll() {
  if (!state.chapters.length || !virtualBook.chapterOffsets.length) return;

  const scrollTop = dom.reader.scrollTop + 24;
  let current = 0;

  for (let index = 0; index < virtualBook.chapterOffsets.length; index += 1) {
    if (virtualBook.chapterOffsets[index] <= scrollTop) {
      current = index;
    } else {
      break;
    }
  }

  if (current !== state.currentChapterIndex) {
    state.currentChapterIndex = current;
    updateButtons();
  }
}

function rebuildVirtualLayout() {
  if (!state.chapters.length) return;
  const progress = getScrollProgress();
  virtualBook = buildVirtualBook();
  virtualBook.renderedRange = [-1, -1];
  const content = dom.reader.querySelector(".virtual-reader");

  if (content) {
    content.style.height = `${Math.max(virtualBook.totalHeight, dom.reader.clientHeight)}px`;
  }

  restoreScroll(progress * Math.max(1, virtualBook.totalHeight - dom.reader.clientHeight));
}

function moveChapter(direction) {
  scrollToChapter(state.currentChapterIndex + direction);
}

function handleReaderScroll() {
  closeLookupPopup();
  window.clearTimeout(saveTimer);
  scheduleVirtualRender();
  updateCurrentChapterFromScroll();
  updateProgress();
  saveTimer = window.setTimeout(() => {
    persistCurrentScroll();
    saveState();
  }, 180);
}

function persistCurrentScroll() {
  if (!state.chapters.length) return;
  state.scrollTop = dom.reader.scrollTop;
  state.scrollByChapter[state.currentChapterIndex] = dom.reader.scrollTop;
}

function restoreScroll(scrollTop) {
  window.clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = window.setTimeout(() => {
    dom.reader.scrollTop = scrollTop;
    renderVirtualWindow();
    updateCurrentChapterFromScroll();
    updateProgress();
  }, 0);
}

function updateProgress() {
  const totalProgress = state.chapters.length ? (getScrollProgress() * 100).toFixed(1) : "0";
  dom.readingPercent.textContent = `${totalProgress}%`;
}

function getScrollProgress() {
  const total = Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight);
  return clamp(dom.reader.scrollTop / total, 0, 1);
}

function saveBookmark() {
  if (!state.chapters.length) return;
  state.bookmark = {
    chapterIndex: state.currentChapterIndex,
    scrollTop: dom.reader.scrollTop,
    createdAt: Date.now(),
  };
  saveState();
  dom.bookmarkButton.textContent = "已标记";
  window.setTimeout(() => {
    dom.bookmarkButton.textContent = "书签";
  }, 1100);
  updateButtons();
}

function restoreBookmark() {
  if (!state.bookmark) return;
  const target = clamp(state.bookmark.chapterIndex, 0, state.chapters.length - 1);
  state.currentChapterIndex = target;
  restoreScroll(state.bookmark.scrollTop || 0);
  updateButtons();
}

function updateButtons() {
  const hasBook = state.chapters.length > 0;
  dom.immersiveToggle.classList.toggle("active", state.immersive);
  dom.bookmarkButton.disabled = !hasBook;
  dom.restoreBookmark.disabled = !hasBook || !state.bookmark;
  dom.translateChapter.disabled = !hasBook;
  dom.clearTranslation.disabled = !hasBook || !getCurrentTranslation();
}

function toggleImmersiveMode() {
  setImmersiveMode(!state.immersive);
}

async function setImmersiveMode(enabled) {
  const progress = getScrollProgress();
  state.immersive = enabled;
  if (enabled) {
    state.translator.panelOpen = false;
    applyTranslatorSettings();
    await enterBrowserFullscreen();
  } else {
    await exitBrowserFullscreen();
  }
  applySettings();
  rebuildVirtualLayout();
  restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
  saveState();
}

async function enterBrowserFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;

  try {
    await document.documentElement.requestFullscreen();
  } catch {
    // Browser fullscreen can be blocked; the app still enters immersive layout.
  }
}

async function exitBrowserFullscreen() {
  if (!document.fullscreenElement || !document.exitFullscreen) return;

  try {
    await document.exitFullscreen();
  } catch {
    // Keep the app state usable even if the browser denies the fullscreen exit call.
  }
}

function toggleTranslatorPanel() {
  state.translator.panelOpen = !state.translator.panelOpen;
  applyTranslatorSettings();
  saveState();
}

function closeTranslatorPanel() {
  state.translator.panelOpen = false;
  applyTranslatorSettings();
  saveState();
}

// "翻译" 按钮的左键 / 右键 / 长按：左键开关，右键和长按都打开设置面板。
// 长按通过 pointerdown 起一个定时器，到时间没抬起就算长按；长按触发后要把紧跟的
// click 吞掉，避免"打开面板"的同时又触发"开关翻译"。
const TRANSLATE_TOGGLE_LONG_PRESS_MS = 500;
let translateToggleLongPressTimer = 0;
let translateToggleLongPressTriggered = false;

function handleTranslateToggleClick() {
  if (translateToggleLongPressTriggered) {
    translateToggleLongPressTriggered = false;
    return;
  }
  toggleParallelTranslation();
}

function handleTranslateToggleContextMenu(event) {
  event.preventDefault();
  toggleTranslatorPanel();
}

function handleTranslateTogglePointerDown() {
  translateToggleLongPressTriggered = false;
  window.clearTimeout(translateToggleLongPressTimer);
  translateToggleLongPressTimer = window.setTimeout(() => {
    translateToggleLongPressTriggered = true;
    toggleTranslatorPanel();
  }, TRANSLATE_TOGGLE_LONG_PRESS_MS);
}

function cancelTranslateToggleLongPress() {
  window.clearTimeout(translateToggleLongPressTimer);
}

// 顶部 "翻译" 按钮的一键开关：
//   关 → 开：切到双栏模式，hydrate 时会自动把可见句对加入翻译队列；
//   开 → 关：恢复原文视图、清空待翻译队列、释放高亮状态。
// 未填好 Base URL / API Key / 模型 时不允许开启，自动弹出设置面板提示。
function toggleParallelTranslation() {
  if (isParallelTranslationEnabled()) {
    const progress = getScrollProgress();
    state.translator.parallelMode = false;
    if (state.translator.view === "parallel") {
      state.translator.view = "original";
    }
    // 关掉翻译时把待处理队列清掉，避免后台继续消耗 API 配额
    queuedSentenceTranslations.clear();
    sentenceTranslationQueue.length = 0;
    focusedSentenceKey = null;
    focusedSentenceSide = null;
    persistCurrentScroll();
    saveState();
    applyTranslatorSettings();
    renderReader();
    restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
    updateButtons();
    setTranslatorStatus("已关闭翻译，正文已恢复原文。", "success");
    return;
  }

  if (!canUseParallelTranslator()) {
    state.translator.panelOpen = true;
    applyTranslatorSettings();
    saveState();
    setTranslatorStatus("请先填写 Base URL、API Key 和模型名后再开启翻译。", "error");
    return;
  }

  const progress = getScrollProgress();
  state.translator.parallelMode = true;
  state.translator.view = "parallel";
  state.translator.provider = "model";
  persistCurrentScroll();
  saveState();
  applyTranslatorSettings();
  renderReader();
  restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
  updateButtons();
  // 切换到双栏模式后 renderVirtualWindow → hydrateVisibleSentenceTranslations
  // 会自动把可见句对入队，无需再手动触发
  setTranslatorStatus("已开启翻译，可见内容将按队列自动翻译。", "loading");
}

function updateTranslator(key, value, shouldRender = false) {
  state.translator[key] = value;

  if (key === "provider") {
    if (value === "free") {
      state.translator.model = "";
    } else if (value === "google") {
      state.translator.endpoint = GOOGLE_TRANSLATE_ENDPOINT;
      state.translator.model = "";
    } else if (state.translator.endpoint === GOOGLE_TRANSLATE_ENDPOINT || !state.translator.endpoint) {
      state.translator.endpoint = "https://api.catcode.top";
    }
  }

  if (key === "parallelMode") {
    state.translator.view = value ? "parallel" : "original";
    state.translator.provider = "model";
    state.translator.endpoint = state.translator.endpoint || "https://api.catcode.top";
  }

  if (key === "view") {
    state.translator.parallelMode = value === "parallel";
    if (value === "parallel") {
      state.translator.provider = "model";
      state.translator.endpoint = state.translator.endpoint || "https://api.catcode.top";
    }
  }

  applyTranslatorSettings();
  persistCurrentScroll();
  saveState();

  if (shouldRender) {
    const progress = getScrollProgress();
    renderReader();
    restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
    updateButtons();
  }
}

function applyTranslatorSettings() {
  const translator = state.translator;
  const providerLabel = getTranslatorProviderLabel();
  dom.translatorPanel.hidden = !translator.panelOpen;
  // "翻译" 按钮高亮 = 翻译已开启（设置面板的打开状态不再单独反映在工具栏上）
  dom.translateToggle.classList.toggle("active", isParallelTranslationEnabled());
  dom.translatorCurrent.textContent = providerLabel;
  dom.translateApiKey.value = translator.apiKey || "";
  dom.translateEndpoint.value = translator.endpoint || "";
  dom.translateModel.value = translator.model || "";
  dom.translateSource.value = translator.source;
  dom.translateTarget.value = translator.target;
  dom.translateView.value = translator.view;
  dom.translateChunkSize.value = String(translator.chunkSize);
  dom.translateApiKeyRow.hidden = translator.provider === "free" && !isParallelTranslationEnabled();
  dom.translateEndpointRow.hidden = translator.provider !== "model" && !isParallelTranslationEnabled();
  dom.translateModelRow.hidden = translator.provider !== "model" && !isParallelTranslationEnabled();
  dom.modelPresets.hidden = translator.provider !== "model" && !isParallelTranslationEnabled();
  dom.swapTranslationColumns.disabled = !isParallelTranslationEnabled();
  dom.translateChapter.textContent = isParallelTranslationEnabled() ? "翻译可见内容" : "翻译当前章";

  Object.entries(dom.providerButtons).forEach(([provider, button]) => {
    button.classList.toggle("active", provider === translator.provider);
  });
}

function getTranslatorProviderLabel() {
  if (state.translator.provider === "free") return "免费翻译";
  if (state.translator.provider === "google") return "谷歌 API";
  return state.translator.model || "自定义模型";
}

function applyModelPreset(event) {
  const button = event.target.closest("button[data-endpoint]");
  if (!button) return;

  state.translator.provider = "model";
  state.translator.endpoint = button.dataset.endpoint || "";
  state.translator.model = button.dataset.model || "";
  applyTranslatorSettings();
  saveState();
}

function swapTranslationColumns() {
  const progress = getScrollProgress();
  state.translator.swapColumns = !state.translator.swapColumns;
  saveState();
  renderReader();
  restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
}

async function translateCurrentChapter() {
  if (isParallelTranslationEnabled()) {
    translateVisibleSentences();
    return;
  }

  const chapter = state.chapters[state.currentChapterIndex];
  if (!chapter) return;

  if (state.translator.provider !== "free" && !state.translator.apiKey) {
    setTranslatorStatus("请先填写 API Key。", "error");
    openTranslatorPanel();
    return;
  }

  if (state.translator.provider === "model" && (!state.translator.endpoint || !state.translator.model)) {
    setTranslatorStatus("请填写模型接口地址和模型名称。", "error");
    openTranslatorPanel();
    return;
  }

  const cached = getCurrentTranslation();
  if (cached) {
    const progress = getScrollProgress();
    state.translator.view = state.translator.view === "original" ? "bilingual" : state.translator.view;
    applyTranslatorSettings();
    renderReader();
    restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
    setTranslatorStatus("已使用缓存译文。", "success");
    return;
  }

  const paragraphs = splitParagraphs(chapter.text);
  if (!paragraphs.length) return;

  setTranslatorBusy(true);
  setTranslatorStatus("正在翻译当前章节...", "loading");

  try {
    const translatedParagraphs = await translateParagraphs(paragraphs, chapter.title);

    const key = getTranslationKey();
    state.translations[key] = {
      paragraphs: normalizeTranslatedParagraphs(translatedParagraphs, paragraphs),
      provider: state.translator.provider,
      endpoint: state.translator.provider === "model" ? state.translator.endpoint : "",
      model: state.translator.model,
      source: state.translator.source,
      target: state.translator.target,
      createdAt: Date.now(),
    };
    const progress = getScrollProgress();
    state.translator.view = "bilingual";
    saveState();
    applyTranslatorSettings();
    renderReader();
    restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
    updateButtons();
    setTranslatorStatus("翻译完成，已缓存当前章节。", "success");
  } catch (error) {
    setTranslatorStatus(getTranslateErrorMessage(error), "error");
  } finally {
    setTranslatorBusy(false);
  }
}

function translateVisibleSentences() {
  if (!state.chapters.length) return;

  if (!canUseParallelTranslator()) {
    setTranslatorStatus("请填写 Base URL、API Key 和模型名后再开启双栏翻译。", "error");
    openTranslatorPanel();
    return;
  }

  const rows = [...dom.reader.querySelectorAll(".sentence-pair")];
  rows.forEach((row) => {
    const index = Number(row.dataset.virtualIndex);
    const block = virtualBook.blocks[index];
    if (block) queueSentenceTranslation(block);
  });
  setTranslatorStatus(`已提交 ${rows.length} 个可见句子进行翻译。`, "loading");
}

function translateParagraphs(paragraphs, title) {
  if (state.translator.provider === "free") {
    return translateWithFreeGoogle(paragraphs);
  }

  if (state.translator.provider === "google") {
    return translateWithGoogle(paragraphs);
  }

  return translateWithModel(paragraphs, title);
}

async function translateWithFreeGoogle(paragraphs) {
  const translated = [];
  let requestCount = 0;

  for (const paragraph of paragraphs) {
    const pieces = splitTextForFreeApi(paragraph, 480);
    const translatedPieces = [];

    for (const piece of pieces) {
      if (requestCount > 0) {
        await waitForNextTranslationRequest();
      }
      translatedPieces.push(await translateFreePiece(piece, paragraphs.join("\n")));
      requestCount += 1;
    }

    translated.push(translatedPieces.join(""));
  }

  return translated;
}

async function translateFreePiece(text, sampleText) {
  try {
    return await translateWithMyMemory(text, sampleText);
  } catch (primaryError) {
    try {
      return await translateWithPublicGoogle(text, sampleText);
    } catch {
      throw primaryError;
    }
  }
}

async function translateWithMyMemory(text, sampleText) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${inferFreeSourceLanguage(sampleText)}|${normalizeMyMemoryLanguage(state.translator.target)}`);

    const response = await fetchWithRateLimitRetry(() => fetch(url.toString()));
  const data = await parseJsonResponse(response);
  const translatedText = data?.responseData?.translatedText;

  if (!translatedText || isMyMemoryLimitMessage(translatedText)) {
    throw new Error(data?.responseDetails || "免费翻译暂时没有返回译文。");
  }

  return decodeHtmlEntities(translatedText);
}

function isMyMemoryLimitMessage(text) {
  return /limit|quota|too many|invalid/i.test(text);
}

async function translateWithPublicGoogle(text, sampleText) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", inferFreeSourceLanguage(sampleText));
  url.searchParams.set("tl", normalizeFreeTranslateLanguage(state.translator.target));
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetchWithRateLimitRetry(() => fetch(url.toString()));
  const data = await parseJsonResponse(response);
  return parseFreeGoogleResponse(data);
}

async function translateWithGoogle(paragraphs) {
  const batches = splitIntoBatches(paragraphs, state.translator.chunkSize);
  const translated = [];

  for (const [index, batch] of batches.entries()) {
    if (index > 0) {
      await waitForNextTranslationRequest();
    }

    const url = new URL(state.translator.endpoint || GOOGLE_TRANSLATE_ENDPOINT);
    url.searchParams.set("key", state.translator.apiKey);

    const body = {
      q: batch,
      target: normalizeGoogleLanguage(state.translator.target),
      format: "text",
    };

    if (state.translator.source !== "auto") {
      body.source = normalizeGoogleLanguage(state.translator.source);
    }

    const response = await fetchWithRateLimitRetry(() => fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }));

    const data = await parseJsonResponse(response);
    const items = data?.data?.translations;

    if (!Array.isArray(items)) {
      throw new Error("谷歌翻译返回格式不正确。");
    }

    translated.push(...items.map((item) => decodeHtmlEntities(item.translatedText || "")));
  }

  return translated;
}

async function translateWithModel(paragraphs, title) {
  const batches = splitIntoBatches(paragraphs, state.translator.chunkSize);
  const translated = [];

  for (const [index, batch] of batches.entries()) {
    if (index > 0) {
      await waitForNextTranslationRequest();
    }

    const response = await fetchWithRateLimitRetry(() => fetch(getChatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.translator.apiKey}`,
      },
      body: JSON.stringify({
        model: state.translator.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a careful literary translator. Preserve meaning, names, tone, and paragraph count. Return only a valid JSON array of translated strings.",
          },
          {
            role: "user",
            content: JSON.stringify({
              instruction: "Translate each item in paragraphs. Return an array with exactly the same length and order.",
              sourceLanguage: state.translator.source,
              targetLanguage: state.translator.target,
              chapterTitle: title,
              paragraphs: batch,
            }),
          },
        ],
      }),
    }));

    const data = await parseJsonResponse(response);
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    translated.push(...parseModelTranslation(content, batch));
  }

  return translated;
}

async function translateSentenceWithModel(sentence) {
  const response = await fetchWithRateLimitRetry(() => fetch(getChatCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.translator.apiKey}`,
    },
    body: JSON.stringify({
      model: state.translator.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "You translate exactly one sentence. Preserve names, tone, punctuation meaning, and do not add explanations. Return only the translated sentence.",
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage: detectLanguage(sentence),
            targetLanguage: state.translator.target,
            sentence,
          }),
        },
      ],
    }),
  }));

  const data = await parseJsonResponse(response);
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  return cleanModelText(content) || sentence;
}

function getChatCompletionsUrl() {
  const base = normalizeBaseUrl(state.translator.endpoint || defaultState.translator.endpoint);
  return base.endsWith("/chat/completions") ? base : `${base.replace(/\/v1$/, "")}/v1/chat/completions`;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cleanModelText(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json|text)?/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/^["“”]|["“”]$/g, "");
}

function splitIntoBatches(paragraphs, maxChars) {
  const batches = [];
  let current = [];
  let length = 0;
  const limit = Number(maxChars) || defaultState.translator.chunkSize;

  paragraphs.forEach((paragraph) => {
    const nextLength = length + paragraph.length;
    if (current.length && nextLength > limit) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length += paragraph.length;
  });

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || "接口返回了非 JSON 内容。");
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `${response.status} ${response.statusText}`;
    throw new Error(String(message));
  }

  return data;
}

async function fetchWithRateLimitRetry(requestFactory, retryCount = RATE_LIMIT_RETRY_LIMIT) {
  let lastResponse = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const response = await requestFactory();
    if (response.status !== 429) {
      return response;
    }

    lastResponse = response;
    if (attempt >= retryCount) {
      return response;
    }

    const delay = getRateLimitRetryDelay(response, attempt);
    setTranslatorStatus(`翻译排队中：触发限流，${Math.ceil(delay / 1000)} 秒后重试。`, "loading");
    await sleep(delay);
  }

  return lastResponse;
}

function getRateLimitRetryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  return 3000 + attempt * 2000;
}

function waitForNextTranslationRequest() {
  return sleep(randomBetween(TRANSLATION_REQUEST_DELAY_MIN, TRANSLATION_REQUEST_DELAY_MAX));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseModelTranslation(content, originalBatch) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item ?? ""));
    }
  } catch {
    // Fall back to line-based output for less obedient providers.
  }

  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*\d.、)]+\s*/, "").trim())
    .filter(Boolean);

  if (lines.length === originalBatch.length) {
    return lines;
  }

  return [cleaned || originalBatch.join("\n")];
}

function normalizeTranslatedParagraphs(translated, original) {
  if (translated.length === original.length) {
    return translated;
  }

  if (translated.length > original.length) {
    return translated.slice(0, original.length);
  }

  return [...translated, ...Array.from({ length: original.length - translated.length }, () => "")];
}

function parseFreeGoogleResponse(data) {
  if (!Array.isArray(data?.[0])) {
    throw new Error("免费翻译返回格式不正确。");
  }

  return data[0].map((item) => item?.[0] || "").join("");
}

function splitTextForFreeApi(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }

  const pieces = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakPoint = Math.max(
      slice.lastIndexOf("。"),
      slice.lastIndexOf("！"),
      slice.lastIndexOf("？"),
      slice.lastIndexOf("."),
      slice.lastIndexOf("!"),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("；"),
      slice.lastIndexOf(";"),
      slice.lastIndexOf("，"),
      slice.lastIndexOf(","),
      slice.lastIndexOf(" ")
    );
    const end = breakPoint > 80 ? breakPoint + 1 : maxLength;
    pieces.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }

  if (remaining) {
    pieces.push(remaining);
  }

  return pieces;
}

function getCurrentTranslation() {
  return state.translations[getTranslationKey()];
}

function getTranslationForChapter(chapterIndex) {
  return state.translations[getTranslationKey(chapterIndex)];
}

function getTranslationKey(chapterIndex = state.currentChapterIndex) {
  const translator = state.translator;
  return [
    chapterIndex,
    translator.provider,
    translator.source,
    translator.target,
    translator.provider === "model" ? translator.endpoint : translator.provider,
    translator.provider === "model" ? translator.model : "",
  ].join("::");
}

function clearCurrentTranslation() {
  if (isParallelTranslationEnabled()) {
    clearVisibleSentenceTranslations();
    return;
  }

  const progress = getScrollProgress();
  delete state.translations[getTranslationKey()];
  if (state.translator.view !== "original") {
    state.translator.view = "original";
  }
  saveState();
  applyTranslatorSettings();
  renderReader();
  restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
  updateButtons();
  setTranslatorStatus("当前配置下的译文已清除。", "success");
}

function clearVisibleSentenceTranslations() {
  dom.reader.querySelectorAll(".sentence-pair").forEach((row) => {
    const key = row.dataset.cacheKey;
    if (key) {
      sentenceTranslationMemory.delete(key);
    }
    updateSentenceRow(row, "翻译中...", "loading");
  });
  setTranslatorStatus("已清除当前可见句子的内存译文；IndexedDB 缓存会继续避免重复消耗。", "success");
}

function openTranslatorPanel() {
  state.translator.panelOpen = true;
  applyTranslatorSettings();
  saveState();
}

function setTranslatorBusy(isBusy) {
  dom.translateChapter.disabled = isBusy || !state.chapters.length;
  dom.translateChapter.textContent = isBusy ? "翻译中..." : "翻译当前章";
}

function setTranslatorStatus(message, type = "") {
  dom.translatorStatus.textContent = message;
  dom.translatorStatus.dataset.type = type;
}

function setImportStatus(message, type = "") {
  dom.importStatus.textContent = message;
  dom.importStatus.dataset.type = type;
}

function getImportErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("无法加载")) {
    return "解析器加载失败。EPUB/PDF 需要联网加载前端解析库，或后续改成本地内置库。";
  }

  return `导入失败：${message}`;
}

function getTranslateErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.toLowerCase().includes("failed to fetch")) {
    if (state.translator.provider === "free") {
      return "免费翻译请求失败。已尝试免费公共接口，可能是网络不可用或接口临时受限，可以稍后重试，或切换到谷歌 API / 模型翻译。";
    }

    return "请求失败。可能是接口地址不正确、网络不可用，或该服务不允许浏览器直接跨域调用。";
  }

  return `翻译失败：${message}`;
}

function normalizeGoogleLanguage(language) {
  if (language === "zh-CN") return "zh-CN";
  return language;
}

function normalizeMyMemoryLanguage(language) {
  if (language === "zh-CN") return "zh-CN";
  return language;
}

function normalizeFreeTranslateLanguage(language) {
  if (language === "auto") return "auto";
  if (language === "zh-CN") return "zh-CN";
  return language;
}

function inferFreeSourceLanguage(text) {
  if (state.translator.source !== "auto") {
    return normalizeMyMemoryLanguage(state.translator.source);
  }

  const sample = text.slice(0, 1200);

  if (/[\u3040-\u30ff]/.test(sample)) return "ja";
  if (/[\uac00-\ud7af]/.test(sample)) return "ko";
  if (/[\u4e00-\u9fff]/.test(sample)) return "zh-CN";
  return "en";
}

function detectLanguage(text) {
  const sample = text.slice(0, 1200);
  if (/[\u3040-\u30ff]/.test(sample)) return "ja";
  if (/[\uac00-\ud7af]/.test(sample)) return "ko";
  if (/[\u4e00-\u9fff]/.test(sample)) return "zh-CN";
  if (/[а-яё]/i.test(sample)) return "ru";
  return "auto";
}

function createSentenceCacheKey(text) {
  return [
    "sentence",
    normalizeBaseUrl(state.translator.endpoint || defaultState.translator.endpoint),
    state.translator.model || "",
    state.translator.target,
    hashText(normalizeSentenceForCache(text)),
  ].join("::");
}

function normalizeSentenceForCache(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function hashText(text) {
  let hash = 2166136261;
  const normalized = normalizeSentenceForCache(text);

  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function decodeHtmlEntities(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function updateSetting(key, value) {
  const progress = getScrollProgress();
  state.settings[key] = value;
  applySettings();
  rebuildVirtualLayout();
  restoreScroll(progress * Math.max(1, dom.reader.scrollHeight - dom.reader.clientHeight));
  saveState();
}

function applySettings() {
  const { theme, fontSize, lineHeight, controlsOpen, parallelRatio, sidebarOpen } = state.settings;
  // 是否已有书：用于决定书库默认是展开还是允许收起
  const hasBook = state.chapters.length > 0;

  dom.shell.dataset.theme = theme;
  dom.shell.classList.toggle("has-book", hasBook);
  dom.shell.classList.toggle("immersive-mode", state.immersive);
  dom.shell.classList.toggle("immersive-peek", false);
  // 控制底部设置栏的折叠/展开
  dom.shell.classList.toggle("controls-open", Boolean(controlsOpen));

  // 侧边书库：无书时强制展开；有书时遵循 sidebarOpen
  const sidebarVisible = !hasBook || Boolean(sidebarOpen);
  dom.shell.classList.toggle("sidebar-collapsed", hasBook && !sidebarOpen);
  dom.shell.classList.toggle("sidebar-open", sidebarVisible);

  // 把双栏比例写到 shell 上，让所有 sentence-pair 和分界线共享同一个值
  const safeRatio = clamp(Number(parallelRatio) || 0.5, 0.2, 0.8);
  dom.shell.style.setProperty("--parallel-ratio", safeRatio.toFixed(3));
  dom.reader.style.setProperty("--read-font-size", `${fontSize}px`);
  dom.reader.style.setProperty("--read-line-height", lineHeight);
  dom.bookFormat.value = state.importFormat || "auto";
  dom.fontSize.value = String(fontSize);
  dom.lineHeight.value = String(lineHeight);
  dom.settingsToggle.classList.toggle("active", Boolean(controlsOpen));
  dom.settingsToggle.setAttribute("aria-expanded", controlsOpen ? "true" : "false");
  dom.settingsToggle.textContent = controlsOpen ? "收起" : "设置";

  // 同步侧边栏按钮的 active / aria-expanded（按钮在无书时被 CSS 隐藏）
  if (dom.sidebarToggle) {
    dom.sidebarToggle.classList.toggle("active", sidebarVisible);
    dom.sidebarToggle.setAttribute("aria-expanded", sidebarVisible ? "true" : "false");
    dom.sidebarToggle.setAttribute("aria-label", sidebarVisible ? "收起书库" : "展开书库");
  }

  Object.entries(dom.themeButtons).forEach(([buttonTheme, button]) => {
    button.classList.toggle("active", buttonTheme === theme);
  });

  updateButtons();
}

// 切换底部设置栏展开/收起
function toggleReadingControls() {
  state.settings.controlsOpen = !state.settings.controlsOpen;
  applySettings();
  saveState();
}

// 切换左侧书库栏的展开/收起；无书时按钮被 CSS 隐藏，此时点击无效
function toggleSidebar() {
  if (!state.chapters.length) return;
  state.settings.sidebarOpen = !state.settings.sidebarOpen;
  applySettings();
  saveState();
}

// ============ 双栏翻译模式：点击/选中 → 高亮对侧句子 ============

// 点击任一句对：在哪一侧点，就把对侧那一栏高亮；同一侧再点取消；点不同行/侧切换
function handleSentencePairFocus(event) {
  if (!isParallelTranslationEnabled()) return;
  // 用户正在拖选文本时交给 mouseup 处理，这里跳过
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed && String(selection).length > 0) {
    return;
  }
  if (event.target.closest(".parallel-divider")) return;

  const cell = event.target.closest(".sentence-cell");
  const row = event.target.closest(".sentence-pair");
  if (!row || !dom.reader.contains(row)) return;

  const key = row.dataset.cacheKey || "";
  const targetSide = getOppositeSideOfCell(cell);
  if (!targetSide) return; // 点在了中缝/空白，没有明确的"对侧"

  if (focusedSentenceKey === key && focusedSentenceSide === targetSide) {
    focusedSentenceKey = null;
    focusedSentenceSide = null;
  } else {
    focusedSentenceKey = key;
    focusedSentenceSide = targetSide;
  }
  applySentenceFocus();
}

// 鼠标拖选文本结束：在哪一侧选，就高亮对侧那一栏
function handleSelectionFocus() {
  if (!isParallelTranslationEnabled()) return;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return;
  if (!String(selection).trim()) return;

  const anchorCell = findSentenceCellFromNode(selection.anchorNode);
  const focusCell = findSentenceCellFromNode(selection.focusNode);
  // 选区跨多个单元格时不切换焦点，避免误判
  if (!anchorCell || anchorCell !== focusCell) return;

  const row = anchorCell.closest(".sentence-pair");
  if (!row) return;

  const key = row.dataset.cacheKey || "";
  const targetSide = getOppositeSideOfCell(anchorCell);
  if (!key || !targetSide) return;

  if (focusedSentenceKey !== key || focusedSentenceSide !== targetSide) {
    focusedSentenceKey = key;
    focusedSentenceSide = targetSide;
    applySentenceFocus();
  }
}

// 同步行级 .is-focused 与目标侧单元格的 .is-cell-focused
function applySentenceFocus() {
  dom.reader.querySelectorAll(".sentence-pair").forEach((row) => {
    const isRow = Boolean(focusedSentenceKey) && row.dataset.cacheKey === focusedSentenceKey;
    row.classList.toggle("is-focused", isRow);
    row.querySelectorAll(".sentence-cell").forEach((cell) => {
      const isTarget = isRow && focusedSentenceSide && cell.classList.contains(`${focusedSentenceSide}-cell`);
      cell.classList.toggle("is-cell-focused", Boolean(isTarget));
    });
  });
}

// 根据点击/选中所在的单元格，返回需要高亮的"对侧" side 名
function getOppositeSideOfCell(cell) {
  if (!cell) return null;
  if (cell.classList.contains("original-cell")) return "translated";
  if (cell.classList.contains("translated-cell")) return "original";
  return null;
}

// 从 Selection 端点节点向上找到所在的 .sentence-cell
function findSentenceCellFromNode(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el?.closest?.(".sentence-cell") || null;
}

// ============ 选中正文中的英文 → 弹出查词弹窗 ============

// 仅允许纯英文短语：必须以字母开头，允许字母 / 空格 / 连字符 / 撇号
const LOOKUP_WORD_REGEX = /^[a-zA-Z][a-zA-Z\s\-']*$/;
let currentLookupPopup = null;
let lookupOutsideClickHandler = null;

function handleLookupSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) {
    closeLookupPopup();
    return;
  }

  const word = String(selection).trim();
  if (!word || !LOOKUP_WORD_REGEX.test(word)) {
    closeLookupPopup();
    return;
  }

  let rect = null;
  try {
    rect = selection.getRangeAt(0).getBoundingClientRect();
  } catch {
    closeLookupPopup();
    return;
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    closeLookupPopup();
    return;
  }

  openLookupPopup(word, rect);
}

function openLookupPopup(word, anchorRect) {
  closeLookupPopup();

  const popup = document.createElement("div");
  popup.className = "lookup-popup";

  const title = document.createElement("div");
  title.className = "lookup-word";
  title.textContent = word;

  const body = document.createElement("div");
  body.className = "lookup-body";
  body.textContent = "查询中...";

  popup.append(title, body);
  // 挂到 .app-shell 内部以继承当前主题变量（夜间/清爽等）
  dom.shell.append(popup);
  positionLookupPopup(popup, anchorRect);

  currentLookupPopup = popup;
  lookupOutsideClickHandler = (event) => {
    if (popup.contains(event.target)) return;
    closeLookupPopup();
  };
  document.addEventListener("mousedown", lookupOutsideClickHandler);
}

function closeLookupPopup() {
  if (currentLookupPopup) {
    currentLookupPopup.remove();
    currentLookupPopup = null;
  }
  if (lookupOutsideClickHandler) {
    document.removeEventListener("mousedown", lookupOutsideClickHandler);
    lookupOutsideClickHandler = null;
  }
}

function positionLookupPopup(popup, anchorRect) {
  const margin = 8;
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  let top = anchorRect.bottom + margin;

  if (left < margin) left = margin;
  if (left + width > viewportWidth - margin) left = viewportWidth - width - margin;
  if (top + height > viewportHeight - margin) {
    top = Math.max(margin, anchorRect.top - height - margin);
  }

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function handleShortcuts(event) {
  if (event.target && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;

  if (event.key === "Escape" && state.immersive) {
    setImmersiveMode(false);
    return;
  }

  if (event.key === "ArrowLeft") {
    moveChapter(-1);
  }

  if (event.key === "ArrowRight") {
    moveChapter(1);
  }

  if (event.key === "b" || event.key === "B") {
    saveBookmark();
  }
}

function handleImmersivePointer(event) {
  if (!state.immersive) return;
  dom.shell.classList.toggle("immersive-peek", event.clientY < 72);
}

function clearBook() {
  state = {
    ...defaultState,
    // 清空时把书库重新展开，方便用户立即导入下一本
    settings: { ...state.settings, sidebarOpen: true },
    translator: state.translator,
    immersive: false,
  };
  saveState();
  renderAll();
}

function formatSize(size) {
  if (!Number.isFinite(size)) return "未知大小";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const translator = {
      ...defaultState.translator,
      ...(saved?.translator || {}),
    };

    if (!saved?.translator?.provider || (translator.provider === "google" && !translator.apiKey)) {
      translator.provider = "free";
      translator.endpoint = translator.endpoint || defaultState.translator.endpoint;
      translator.model = "";
    }

    translator.endpoint = translator.endpoint || defaultState.translator.endpoint;
    translator.parallelMode = Boolean(translator.parallelMode || translator.view === "parallel");

    return {
      ...structuredClone(defaultState),
      ...(saved || {}),
      settings: {
        ...defaultState.settings,
        ...(saved?.settings || {}),
      },
      translator,
      scrollTop: Number(saved?.scrollTop) || 0,
      immersive: Boolean(saved?.immersive),
      scrollByChapter: saved?.scrollByChapter || {},
      chapters: Array.isArray(saved?.chapters) ? saved.chapters : [],
      translations: saved?.translations && typeof saved.translations === "object" ? saved.translations : {},
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("ReadTaylor 保存失败：", error);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
