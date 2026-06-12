const STORAGE_KEY = "readTaylorState";
// 按 bookId 分离的持久化键：进度和标记（书签/笔记）独立于主 state，
// 让"清空当前书 → 再导入同一本书"也能找回历史阅读位置和标记。
const PROGRESS_KEY_PREFIX = "rt_progress_";
const NOTES_KEY_PREFIX = "rt_notes_";
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
  restoreBookmark: document.querySelector("#restore-bookmark"),
  marksButton: document.querySelector("#marks-button"),
  marksPanel: document.querySelector("#marks-panel"),
  marksClose: document.querySelector("#marks-close"),
  marksList: document.querySelector("#marks-list"),
  marksFilter: document.querySelector("#marks-filter"),
  tocButton: document.querySelector("#toc-button"),
  tocPanel: document.querySelector("#toc-panel"),
  tocClose: document.querySelector("#toc-close"),
  tocList: document.querySelector("#toc-list"),
  searchButton: document.querySelector("#search-button"),
  searchPanel: document.querySelector("#search-panel"),
  searchClose: document.querySelector("#search-close"),
  searchInput: document.querySelector("#search-input"),
  searchSummary: document.querySelector("#search-summary"),
  searchResults: document.querySelector("#search-results"),
  ttsButton: document.querySelector("#tts-button"),
  ttsBar: document.querySelector("#tts-bar"),
  ttsPrev: document.querySelector("#tts-prev"),
  ttsPlay: document.querySelector("#tts-play"),
  ttsNext: document.querySelector("#tts-next"),
  ttsStop: document.querySelector("#tts-stop"),
  ttsRate: document.querySelector("#tts-rate"),
  ttsRateValue: document.querySelector("#tts-rate-value"),
  ttsVoice: document.querySelector("#tts-voice"),
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
    endpoint: "https://open.bigmodel.cn/api/paas/v4/",
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
    // TTS：语速 + 上次选的 voiceURI（持久化，下次打开仍是这个嗓音）
    ttsRate: 1.0,
    ttsVoiceURI: "",
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
// 翻译队列并发 worker 计数：3 个 worker 共享同一队列，
// 6 个短段同时跑约等于 1 段的时间，避免短段被前面长段卡住
const TRANSLATION_CONCURRENCY = 3;
let activeTranslationWorkers = 0;
const TRANSLATION_REQUEST_DELAY_MIN = 1000;
const TRANSLATION_REQUEST_DELAY_MAX = 2000;
const RATE_LIMIT_RETRY_LIMIT = 3;

// 当前在双栏翻译模式下被选中高亮的句对 cacheKey；null 表示无高亮
let focusedSentenceKey = null;
// 需要高亮的"对侧"栏：
//   "original"   —— 用户的点击/选中发生在译文栏，要高亮的是原文栏；
//   "translated" —— 反过来
let focusedSentenceSide = null;

// init() 的调用挪到文件最底部，让所有模块级 let/const 都先完成初始化。
// 之前放在这里时，init() 内的 showToast 会访问下面才声明的 let toastHideTimer，
// 触发 TDZ ReferenceError，连带让整个模块加载中断、后续按钮全废。

function init() {
  applySettings();
  renderAll();
  bindEvents();
  // TTS：把语速滑块还原到上次的值；voice 列表晚一点会通过 voiceschanged 自动填
  if (ttsSupported()) {
    applyTtsRateUI();
    ensureTtsVoicesLoaded();
  } else if (dom.ttsButton) {
    dom.ttsButton.disabled = true;
    dom.ttsButton.title = "浏览器不支持朗读";
  }
  // 重开 tab 时按 bookId 恢复进度（优先 blockIndex，scrollTop 兜底）。
  // 主 state 里也保留了 scrollTop，但 rt_progress 是跨"清空主 state / 再导入"的稳定源。
  if (state.book?.id && state.chapters.length) {
    const savedProgress = readProgress(state.book.id);
    if (savedProgress) {
      restoreFromProgress(savedProgress);
      showToast("已恢复阅读位置");
    }
  }
}

function bindEvents() {
  dom.fileInput.addEventListener("change", handleFileImport);
  dom.bookFormat.addEventListener("change", (event) => {
    state.importFormat = event.target.value;
    saveState();
  });
  dom.clearBook.addEventListener("click", clearBook);
  dom.immersiveToggle.addEventListener("click", toggleImmersiveMode);
  dom.marksButton.addEventListener("click", toggleMarksPanel);
  dom.marksClose.addEventListener("click", closeMarksPanel);
  dom.marksFilter.addEventListener("click", handleMarksFilterClick);
  dom.marksList.addEventListener("click", handleMarksListClick);
  dom.tocButton.addEventListener("click", toggleTocPanel);
  dom.tocClose.addEventListener("click", closeTocPanel);
  dom.tocList.addEventListener("click", handleTocListClick);
  dom.searchButton.addEventListener("click", toggleSearchPanel);
  dom.searchClose.addEventListener("click", closeSearchPanel);
  dom.searchInput.addEventListener("input", handleSearchInput);
  dom.searchResults.addEventListener("click", handleSearchResultClick);
  dom.ttsButton.addEventListener("click", toggleTts);
  dom.ttsPlay.addEventListener("click", togglePauseTts);
  dom.ttsStop.addEventListener("click", stopTts);
  dom.ttsPrev.addEventListener("click", () => jumpTtsBlock(-1));
  dom.ttsNext.addEventListener("click", () => jumpTtsBlock(1));
  dom.ttsRate.addEventListener("input", handleTtsRateChange);
  dom.ttsVoice.addEventListener("change", handleTtsVoiceChange);
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.addEventListener("voiceschanged", refreshTtsVoiceList);
  }
  // 正文里右键 → 弹出加标记菜单（书签 / 生词 / 好句 / 难句 / 语法）
  dom.reader.addEventListener("contextmenu", handleReaderContextMenu);
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
  // 关页面前必须 cancel，否则有些浏览器朗读会在后台继续
  window.addEventListener("beforeunload", () => {
    if (ttsSupported()) {
      try { speechSynthesis.cancel(); } catch {}
    }
  });
}

async function handleFileImport(event) {
  const [file] = event.target.files;
  if (!file) return;

  const format = resolveBookFormat(file);
  // SHA-256 大文件可能要几十毫秒到几百毫秒，先 loading 提示避免用户以为卡死
  setImportStatus("正在计算文件指纹...", "loading");

  try {
    const bookId = await computeFileBookId(file);
    setImportStatus(`正在导入 ${format.toUpperCase()}...`, "loading");
    const parsed = await parseBookFile(file, format);
    state = {
      ...state,
      book: {
        id: bookId,
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
    // 同一本书曾经读到的位置（按 bookId 持久化）优先于 scrollTop = 0
    const savedProgress = readProgress(bookId);
    if (savedProgress) {
      restoreFromProgress(savedProgress);
      showToast("已恢复阅读位置");
    } else {
      restoreScroll(0);
    }
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

  const bookTitle = metadata?.title || file.name.replace(/\.[^.]+$/, "");

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
        lookupNavTitle(navTitleByHref, href) ||
        getEpubSectionTitle(doc, bookTitle) ||
        (item.label && item.label.trim()) ||
        "";

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

  // 兜底：标题为空或多章重复时，改用 "第 N 章 · 正文预览"
  dedupeChapterTitles(chapters);

  return {
    title: bookTitle,
    chapters,
  };
}

// 从 EPUB 的目录（nav 或 ncx）中收集 href → 标题 的映射；
// 同时索引完整路径和文件名两个 key，容忍 nav/spine 路径前缀差异
// （nav 里可能是 OEBPS/text/chap1.xhtml，spine 里只是 chap1.xhtml）
async function loadEpubNavTitles(book) {
  const map = new Map();
  const addEntry = (href, label) => {
    const text = (label || "").trim();
    if (!text) return;
    const key = stripHash(href);
    if (!key) return;
    if (!map.has(key)) map.set(key, text);
    const base = key.split("/").pop();
    if (base && !map.has(base)) map.set(base, text);
  };
  try {
    const nav = await book.loaded.navigation;
    const toc = nav?.toc || [];
    const walk = (items) => {
      items.forEach((entry) => {
        if (entry?.href) addEntry(entry.href, entry.label);
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

// 用完整 href 和 basename 两种 key 查 nav 映射，匹配率更高
function lookupNavTitle(map, href) {
  if (!map || !href) return "";
  const key = stripHash(href);
  if (map.has(key)) return map.get(key);
  const base = key.split("/").pop();
  if (base && map.has(base)) return map.get(base);
  return "";
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

function getEpubSectionTitle(doc, bookTitle = "") {
  // 只从 body 里找标题元素：head 里的 <title> 几乎都是整本书名，
  // 用它会让所有章节同名（"Rich Dad Poor Dad" 那种）。
  // 再跳过和书名相同的 heading：很多 EPUB 每章 body 开头都重复书名，
  // 真正的章节标题往往在第二个 h2/h3。
  const root = doc.body || doc.documentElement || doc;
  const normalizedBook = bookTitle.trim().toLowerCase();
  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6, [epub\\:type='title']");
  for (const heading of headings) {
    const text = (heading.textContent || "").trim();
    if (!text) continue;
    if (normalizedBook && text.toLowerCase() === normalizedBook) continue;
    return text;
  }
  return "";
}

// 多个章节标题相同时，给重复项追加 "第 N 章 · 开头预览"，
// 避免目录里整列都是同一行字（比如盗版 EPUB 每章重复书名）
function dedupeChapterTitles(chapters) {
  const counts = new Map();
  chapters.forEach((c) => {
    const key = (c.title || "").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  chapters.forEach((c, i) => {
    const key = (c.title || "").trim();
    if (!key || counts.get(key) > 1) {
      const preview = (c.text || "").trim().slice(0, 24).replace(/\s+/g, " ");
      c.title = preview ? `第 ${i + 1} 章 · ${preview}` : `第 ${i + 1} 章`;
    }
  });
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
  // 目录面板开着时换书要立即刷新章节列表，否则会停留在上一本书的目录
  if (tocPanelOpen) renderTocList();
  // 搜索面板开着时换书，旧的搜索结果属于上一本书，重新跑一次（输入框内容保留）
  if (searchPanelOpen) renderSearchResults(dom.searchInput.value || "");
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
        <span class="empty-eyebrow">ReadTaylor</span>
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

// 双栏对照：每段一个 block，整段做一次翻译请求。
// 翻译粒度从"句"提到"段"：模型上下文更连贯、请求数也降一个量级。
// 段 piece 数 = 1：cacheKey 用段原文 hash，渲染/排队/缓存逻辑天然按段对齐。
function getChapterSentencePairs(chapter, chapterIndex) {
  const paragraphs = splitParagraphs(chapter.text);

  return paragraphs
    .map((paragraphText, paragraphIndex) => {
      const text = normalizeText(paragraphText).replace(/\s+/g, " ").trim();
      if (!text) return null;
      return {
        type: "paragraph-pair",
        kind: "parallel",
        chapterIndex,
        paragraphIndex,
        sentences: [
          {
            text,
            sentenceIndex: paragraphIndex,
            cacheKey: createSentenceCacheKey(text),
          },
        ],
        text,
      };
    })
    .filter(Boolean);
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
      let nextIdx = i + 1;
      let next = normalized[nextIdx];

      // 如果紧跟引号，我们把引号也吞进当前句的 buffer 里，并移动循环索引以跳过它
      if (next && /["'”’]/.test(next)) {
        buffer += next;
        i += 1;
        nextIdx += 1;
        next = normalized[nextIdx];
      }

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
  if (block.type === "paragraph-pair") {
    const columnWidth = Math.max(220, (metrics.width - 28) / 2);
    const charsPerLine = Math.max(10, Math.floor(columnWidth / (metrics.fontSize * 0.95)));
    // 段落总长：两栏理论上等长，取原文长度做估算即可
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
  restoreTtsStateIfVisible();
}

function restoreTtsStateIfVisible() {
  if (!ttsState.active || ttsState.blockIndex < 0) return;
  const [startIndex, endIndex] = virtualBook.renderedRange;
  if (ttsState.blockIndex >= startIndex && ttsState.blockIndex <= endIndex) {
    const block = virtualBook.blocks[ttsState.blockIndex];
    if (block) {
      highlightTtsBlock(ttsState.blockIndex);
      prepareTtsSentenceOverlay(ttsState.blockIndex, block);
      // 重建 overlay 后立即恢复当前句的 .is-active / .is-spoken，
      // 否则用户滚动时高亮会消失直到下一句开始才回来
      if (ttsState.sentenceIndex >= 0) {
        applyTtsHighlight(ttsState.sentenceIndex);
      }
    }
  }
}

function createVirtualBlock(block, index) {
  if (block.type === "paragraph-pair") {
    return createParagraphPairBlock(block, index);
  }

  const paragraph = createParagraph(block.text, block.kind);
  paragraph.dataset.virtualIndex = String(index);
  return paragraph;
}

// 段落对：一行 = 一段，段内由多个 .sentence-piece 流式排版，
// 这样视觉上保留原书段落形态，同时每个句子仍可独立点击/高亮
function createParagraphPairBlock(block, index) {
  const row = document.createElement("div");
  row.className = "sentence-pair";
  row.dataset.virtualIndex = String(index);

  const original = createParagraphCell(block, "original");
  const translated = createParagraphCell(block, "translated");

  if (state.translator.swapColumns) {
    row.append(translated, original);
  } else {
    row.append(original, translated);
  }

  return row;
}

function createParagraphCell(block, side) {
  const cell = document.createElement("p");
  cell.className = `sentence-cell ${side}-cell`;
  block.sentences.forEach((sentence, pieceIndex) => {
    // 英文/混排相邻句子之间需要空格；CJK 句末标点（。！？；…）紧贴下一句更自然
    if (pieceIndex > 0) {
      const prevEnd = (block.sentences[pieceIndex - 1].text || "").slice(-1);
      if (prevEnd && !/[。！？；…]/.test(prevEnd)) cell.append(" ");
    }
    const piece = document.createElement("span");
    piece.className = "sentence-piece";
    piece.dataset.cacheKey = sentence.cacheKey;
    piece.dataset.side = side;
    if (side === "translated") {
      const cached = getSentenceMemoryValue(sentence.cacheKey);
      piece.textContent = cached || "翻译中...";
      piece.dataset.status = cached ? "ready" : "loading";
    } else {
      piece.textContent = sentence.text;
      piece.dataset.status = "ready";
    }
    // 虚拟滚动重建时恢复焦点高亮
    if (
      focusedSentenceKey &&
      sentence.cacheKey === focusedSentenceKey &&
      focusedSentenceSide === side
    ) {
      piece.classList.add("is-piece-focused");
    }
    cell.append(piece);
  });
  return cell;
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
    if (!block || block.type !== "paragraph-pair") return;
    block.sentences.forEach((piece) => hydrateSentencePiece(piece));
  });
}

async function hydrateSentencePiece(piece) {
  const cached = sentenceTranslationMemory.get(piece.cacheKey) || (await getCachedSentenceTranslation(piece.cacheKey));

  if (cached) {
    updateRenderedSentence(piece.cacheKey, cached, "ready");
    return;
  }

  // 不需要翻译的"段"（纯数字编号、ISBN、URL、纯标点符号）：直接显示原文，
  // 省一次 API 调用；这种段塞进队列只会拖慢真正需要翻译的文本
  if (isUntranslatable(piece.text)) {
    sentenceTranslationMemory.set(piece.cacheKey, piece.text);
    updateRenderedSentence(piece.cacheKey, piece.text, "ready");
    return;
  }

  if (!canUseParallelTranslator()) {
    updateRenderedSentence(piece.cacheKey, "请在翻译设置中填写 API Key 和模型名。", "missing");
    return;
  }

  queueSentenceTranslation(piece);
}

// 判断这段文本是不是"不值得翻译"——译出来还是原文样
function isUntranslatable(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return true;
  // 纯数字 + 常见分隔符（年份 032014、电话号、版本号）
  if (/^[\d\s\-:.,/()]+$/.test(trimmed)) return true;
  // ISBN: 978-1-61268-018-7 形态
  if (/^ISBN[:：\s]/i.test(trimmed)) return true;
  // 单独一个 URL 或裸域名
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
  if (/^[\w-]+\.(?:com|org|net|io|cn|co|app|dev|gov|edu)(?:\/\S*)?$/i.test(trimmed)) return true;
  // 完全没有字母也没有 CJK，纯符号/数字
  if (!/[a-zA-Z一-鿿]/.test(trimmed)) return true;
  return false;
}

// 译文按 piece 替换：在已渲染 DOM 里找 cacheKey 对应的"译文侧"span，
// 替换其文本和状态。原文侧的 piece 不动。
function updateSentencePiece(piece, text, status) {
  piece.textContent = text;
  piece.dataset.status = status;
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

function runSentenceTranslationQueue() {
  // 启动到上限的 worker；已经在跑的不重复启动
  while (activeTranslationWorkers < TRANSLATION_CONCURRENCY && sentenceTranslationQueue.length) {
    spawnSentenceTranslationWorker();
  }
}

async function spawnSentenceTranslationWorker() {
  activeTranslationWorkers += 1;
  try {
    while (sentenceTranslationQueue.length) {
      const item = sentenceTranslationQueue.shift();
      if (!item || queuedSentenceTranslations.get(item.cacheKey) !== item) continue;

      updateRenderedSentence(item.cacheKey, "翻译中...", "loading");
      setTranslatorStatus(
        `翻译进行中：${activeTranslationWorkers} 个并发，队列剩余 ${sentenceTranslationQueue.length} 条。`,
        "loading"
      );

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
      // worker 之间不互相 sleep；如果命中 429，fetchWithRateLimitRetry 会自动退避重试
    }
  } finally {
    activeTranslationWorkers -= 1;
    if (activeTranslationWorkers === 0 && queuedSentenceTranslations.size === 0) {
      setTranslatorStatus("可见内容已按队列翻译并缓存。", "success");
    }
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
      setTranslatorStatus("可见内容已按段翻译并缓存。", "success");
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
  const selector = `.sentence-piece[data-side="translated"][data-cache-key="${cssEscape(cacheKey)}"]`;
  dom.reader.querySelectorAll(selector).forEach((piece) => {
    updateSentencePiece(piece, translation, status);
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
  
  // 手动切换章节时，清除上次的朗读续读缓存
  ttsState.lastBlockIndex = -1;
  
  dom.reader.scrollTo({
    top: offset,
    behavior: "smooth",
  });
  updateButtons();
  highlightTocActive();
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
    highlightTocActive();
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
  closeMarkContextMenu();
  window.clearTimeout(saveTimer);
  scheduleVirtualRender();
  updateCurrentChapterFromScroll();
  updateProgress();
  saveTimer = window.setTimeout(() => {
    persistCurrentScroll();
    saveState();
    persistReadingProgress();
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
  showToast("已加书签");
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
  dom.marksButton.disabled = !hasBook;
  dom.tocButton.disabled = !hasBook;
  dom.searchButton.disabled = !hasBook;
  dom.ttsButton.disabled = !hasBook || !ttsSupported();
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
    closeMarksPanel();
    closeTocPanel();
    closeSearchPanel();
    stopTts();
    closeMarkContextMenu();
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
  // 翻译/标记/目录/搜索面板同位（右上浮层），同时只展示一个
  if (state.translator.panelOpen && marksPanelOpen) closeMarksPanel();
  if (state.translator.panelOpen && tocPanelOpen) closeTocPanel();
  if (state.translator.panelOpen && searchPanelOpen) closeSearchPanel();
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
      state.translator.endpoint = "https://open.bigmodel.cn/api/paas/v4/";
    }
  }

  if (key === "parallelMode") {
    state.translator.view = value ? "parallel" : "original";
    state.translator.provider = "model";
    state.translator.endpoint = state.translator.endpoint || "https://open.bigmodel.cn/api/paas/v4/";
  }

  if (key === "view") {
    state.translator.parallelMode = value === "parallel";
    if (value === "parallel") {
      state.translator.provider = "model";
      state.translator.endpoint = state.translator.endpoint || "https://open.bigmodel.cn/api/paas/v4/";
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
  let pieceCount = 0;
  rows.forEach((row) => {
    const index = Number(row.dataset.virtualIndex);
    const block = virtualBook.blocks[index];
    if (!block || block.type !== "paragraph-pair") return;
    block.sentences.forEach((piece) => {
      queueSentenceTranslation(piece);
      pieceCount += 1;
    });
  });
  setTranslatorStatus(`已提交 ${pieceCount} 段可见内容进行翻译。`, "loading");
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
  // 同语言无需翻译：直接复用原文，避免"中→中"被 LLM 重写出措辞略有差异的结果，
  // 也省掉一次 API 调用。译文栏拿到的就是原文，左右两栏内容一致、保持干净。
  if (detectLanguage(sentence) === state.translator.target) {
    return sentence;
  }

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
  if (base.endsWith("/chat/completions")) return base;
  // 已经带版本号的 base（OpenAI 的 /v1、智谱的 /v4 等）直接拼 /chat/completions，
  // 否则按 OpenAI 兼容默认补 /v1/chat/completions。
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
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
    // 完整响应打到 console，方便排查像 "Param Incorrect" 这种笼统报错
    // F12 → Console 能看到接口到底嫌弃哪个字段
    console.error("[translate] API error", response.status, response.url, data);
    const message =
      data?.error?.message ||
      data?.error?.code ||
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
  dom.reader
    .querySelectorAll('.sentence-piece[data-side="translated"]')
    .forEach((piece) => {
      const key = piece.dataset.cacheKey;
      if (key) sentenceTranslationMemory.delete(key);
      updateSentencePiece(piece, "翻译中...", "loading");
    });
  setTranslatorStatus("已清除当前可见段的内存译文；IndexedDB 缓存会继续避免重复消耗。", "success");
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

// 点击任一句 piece：在哪一侧点，就把对侧同 cacheKey 的句子高亮；
// 同一侧再点取消；点不同句切换
function handleSentencePairFocus(event) {
  if (!isParallelTranslationEnabled()) return;
  // 用户正在拖选文本时交给 mouseup 处理，这里跳过
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed && String(selection).length > 0) {
    return;
  }
  if (event.target.closest(".parallel-divider")) return;

  const piece = event.target.closest(".sentence-piece");
  if (!piece || !dom.reader.contains(piece)) return;

  const key = piece.dataset.cacheKey || "";
  const targetSide = getOppositeSide(piece.dataset.side);
  if (!key || !targetSide) return;

  if (focusedSentenceKey === key && focusedSentenceSide === targetSide) {
    focusedSentenceKey = null;
    focusedSentenceSide = null;
  } else {
    focusedSentenceKey = key;
    focusedSentenceSide = targetSide;
  }
  applySentenceFocus();
}

// 鼠标拖选文本结束：在哪一侧选，就高亮对侧同 cacheKey 的句子
function handleSelectionFocus() {
  if (!isParallelTranslationEnabled()) return;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return;
  if (!String(selection).trim()) return;

  const anchorPiece = findSentencePieceFromNode(selection.anchorNode);
  const focusPiece = findSentencePieceFromNode(selection.focusNode);
  // 选区跨多个 piece 时不切换焦点，避免误判
  if (!anchorPiece || anchorPiece !== focusPiece) return;

  const key = anchorPiece.dataset.cacheKey || "";
  const targetSide = getOppositeSide(anchorPiece.dataset.side);
  if (!key || !targetSide) return;

  if (focusedSentenceKey !== key || focusedSentenceSide !== targetSide) {
    focusedSentenceKey = key;
    focusedSentenceSide = targetSide;
    applySentenceFocus();
  }
}

// 同步 piece 级 .is-piece-focused：只有命中 cacheKey + side 的 span 被高亮
function applySentenceFocus() {
  dom.reader.querySelectorAll(".sentence-piece").forEach((piece) => {
    const isTarget =
      Boolean(focusedSentenceKey) &&
      piece.dataset.cacheKey === focusedSentenceKey &&
      piece.dataset.side === focusedSentenceSide;
    piece.classList.toggle("is-piece-focused", isTarget);
  });
}

function getOppositeSide(side) {
  if (side === "original") return "translated";
  if (side === "translated") return "original";
  return null;
}

// 从 Selection 端点节点向上找到所在的 .sentence-piece
function findSentencePieceFromNode(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el?.closest?.(".sentence-piece") || null;
}

// ============ 选中正文中的英文 → 弹出查词弹窗 ============

// 仅允许纯英文短语：必须以字母开头，允许字母 / 空格 / 连字符 / 撇号
const LOOKUP_WORD_REGEX = /^[a-zA-Z][a-zA-Z\s\-']*$/;
let currentLookupPopup = null;
let lookupOutsideClickHandler = null;
// 同一会话里同一个词的"翻译 + 词典释义"做内存缓存：
// 第二次选同一个词直接毫秒级出结果，不再走海外 API
// value: { translation?: string, entry?: object|null }（entry=null 表示词典查过但无释义）
const lookupCache = new Map();

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
  const wordSpan = document.createElement("span");
  wordSpan.textContent = word;
  title.append(wordSpan);
  if (ttsSupported()) {
    const speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.className = "lookup-speak";
    speakBtn.title = "朗读这个词";
    speakBtn.textContent = "🔊";
    speakBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      speakLookupWord(word);
    });
    title.append(speakBtn);
  }

  const body = document.createElement("div");
  body.className = "lookup-body";

  popup.append(title, body);
  // 挂到 .app-shell 内部以继承当前主题变量（夜间/清爽等）
  dom.shell.append(popup);

  currentLookupPopup = popup;
  lookupOutsideClickHandler = (event) => {
    if (popup.contains(event.target)) return;
    closeLookupPopup();
  };
  document.addEventListener("mousedown", lookupOutsideClickHandler);

  const cacheKey = word.trim().toLowerCase();
  const cached = lookupCache.get(cacheKey) || {};
  // partial 同时承担"已知结果"和"渐进式累积"两个角色：
  // - 翻译 / 词典哪一路先回来就刷新一次 body，不再等慢的那路
  // - 任一路写回时同步刷 cache，下次同词命中无需再请求
  const partial = { translation: cached.translation || "", entry: cached.entry };

  const hasAnythingCached = Boolean(partial.translation) || partial.entry !== undefined;
  if (hasAnythingCached) {
    renderLookupBody(body, partial);
  } else {
    body.textContent = "查询中...";
  }
  positionLookupPopup(popup, anchorRect);

  let pending = 0;
  const trackFailure = () => {
    pending -= 1;
    if (pending === 0 && !partial.translation && !partial.entry) {
      body.textContent = "未找到这个词的释义。";
      positionLookupPopup(popup, anchorRect);
    }
  };
  const handleArrival = () => {
    lookupCache.set(cacheKey, { ...partial });
    if (currentLookupPopup !== popup) return;
    renderLookupBody(body, partial);
    positionLookupPopup(popup, anchorRect);
  };

  if (!partial.translation) {
    pending += 1;
    translateWithMyMemory(word, word)
      .then((translation) => {
        partial.translation = translation;
        handleArrival();
      })
      .catch(() => {})
      .finally(trackFailure);
  }

  if (partial.entry === undefined) {
    pending += 1;
    fetchDictionaryEntry(word)
      .then((entry) => {
        partial.entry = entry;
        handleArrival();
      })
      .catch(() => {})
      .finally(trackFailure);
  }
}

// dictionaryapi.dev：免费、免 key、支持 CORS。单词找不到时返回 404，这里把 404 当作"没释义"处理
async function fetchDictionaryEntry(word) {
  const cleaned = word.trim().toLowerCase();
  if (!cleaned || cleaned.includes(" ")) return null; // 多词短语词典通常没有，跳过
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleaned)}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`词典服务返回 ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data[0] : null;
}

function renderLookupBody(body, { translation, entry }) {
  body.replaceChildren();

  if (translation) {
    const transLine = document.createElement("div");
    transLine.className = "lookup-translation";
    transLine.textContent = translation;
    body.append(transLine);
  }

  // 词典释义按词性分组，每个词性最多取 2 条
  const meanings = Array.isArray(entry?.meanings) ? entry.meanings.slice(0, 3) : [];
  meanings.forEach((meaning) => {
    const group = document.createElement("div");
    group.className = "lookup-meaning";

    if (meaning.partOfSpeech) {
      const pos = document.createElement("span");
      pos.className = "lookup-pos";
      pos.textContent = meaning.partOfSpeech;
      group.append(pos);
    }

    const defs = (meaning.definitions || []).slice(0, 2);
    defs.forEach((def) => {
      const line = document.createElement("div");
      line.className = "lookup-def";
      line.textContent = def.definition || "";
      group.append(line);
    });

    body.append(group);
  });

  // 音标（如果词典提供了的话）放在标题旁边的小字
  const phoneticText = entry?.phonetic || entry?.phonetics?.find((p) => p?.text)?.text;
  if (phoneticText) {
    const phon = document.createElement("div");
    phon.className = "lookup-phonetic";
    phon.textContent = phoneticText;
    body.prepend(phon);
  }
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

// ============ 书签 / 笔记：加入、列表面板、跳转、删除 ============

const MARK_TAG_LABELS = {
  bookmark: "书签",
  vocab: "生词",
  good: "好句",
  hard: "难句",
  grammar: "语法",
};

let marksPanelOpen = false;
let marksFilter = "all";
let tocPanelOpen = false;
let searchPanelOpen = false;

// 在指定 block 上追加一条 mark。type/tag 决定它是书签还是哪种标签的笔记。
// overrideText 不为空时（一般是用户的选中文字）会用它作为 selectedText，
// 否则退化到当前 block 文本的前 80 字作为定位预览。
function appendMark(option, blockInfo, overrideText) {
  if (!state.book?.id) return false;
  const block = blockInfo?.block || null;
  const chapter = state.chapters[block?.chapterIndex ?? state.currentChapterIndex];
  const fallbackPreview = (block?.text || "").trim().slice(0, 80);
  const text = (overrideText && overrideText.trim()) ? overrideText.trim() : fallbackPreview;
  const mark = {
    id: createMarkId(),
    type: option.type,
    chapterIndex: block?.chapterIndex ?? state.currentChapterIndex,
    chapterTitle: chapter?.title || "",
    blockIndex: blockInfo?.blockIndex ?? 0,
    scrollTop: dom.reader.scrollTop,
    // 限长避免超长选段把 localStorage 撑爆
    selectedText: text.slice(0, 240),
    comment: "",
    tag: option.tag || null,
    createdAt: Date.now(),
  };
  const marks = readMarks(state.book.id);
  marks.unshift(mark);
  writeMarks(state.book.id, marks);
  if (marksPanelOpen) renderMarksList();
  return true;
}

// "B" 快捷键：当前位置加一条无标签的书签
function addBookmark() {
  if (!state.book?.id || !virtualBook.blocks.length) return;
  if (appendMark({ type: "bookmark", tag: null }, getCurrentBlockInfo())) {
    showToast("已加书签");
  }
}

// ============ 正文右键菜单：选了就标，不选只能加书签 ============

let currentMarkContextMenu = null;
let markContextMenuOutsideHandler = null;

// 缓存"最近一次的非空选区文字+端点节点"。Chrome 在选区外右键时会把选区折叠，
// 等到 contextmenu 事件触发时 window.getSelection() 已经是空的，
// 用缓存兜底才能可靠地拿到用户刚刚选中的那段文字。
let lastNonEmptySelection = null;
document.addEventListener("selectionchange", () => {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return;
  const text = String(selection).trim();
  if (!text) return;
  lastNonEmptySelection = {
    text,
    anchorNode: selection.anchorNode,
    focusNode: selection.focusNode,
    capturedAt: Date.now(),
  };
});

function handleReaderContextMenu(event) {
  // 没书时让浏览器原生菜单走，避免空菜单干扰
  if (!state.book?.id || !virtualBook.blocks.length) return;
  event.preventDefault();

  const selection = window.getSelection?.();
  const liveText = selection && !selection.isCollapsed ? String(selection).trim() : "";

  // 优先用 live 选区；live 没了就回落到 1 秒内的缓存（应付右键自动折叠选区的情况）
  const cachedFresh =
    lastNonEmptySelection && Date.now() - lastNonEmptySelection.capturedAt < 1000
      ? lastNonEmptySelection
      : null;
  const selectedText = liveText || cachedFresh?.text || "";
  const hasSelection = Boolean(selectedText);

  // 选区落点优先：选了字就用选区所在 block，没选就优先使用右键点击元素所在的 block，最后用滚动位置兜底
  let blockInfo = null;
  if (liveText) {
    blockInfo = findBlockFromSelection(selection);
  } else if (cachedFresh) {
    blockInfo = findBlockFromCachedNode(cachedFresh.anchorNode || cachedFresh.focusNode);
  }

  if (!blockInfo && event.target) {
    const blockEl = event.target.closest("[data-virtual-index]");
    if (blockEl) {
      const blockIndex = Number(blockEl.dataset.virtualIndex);
      if (!Number.isNaN(blockIndex)) {
        blockInfo = { blockIndex, block: virtualBook.blocks[blockIndex] || null };
      }
    }
  }

  if (!blockInfo) blockInfo = getCurrentBlockInfo();

  openMarkContextMenu(event.clientX, event.clientY, blockInfo, hasSelection ? selectedText : "");
}

// findBlockFromSelection 的缓存版本：直接从一个 Node 找它所在的虚拟 block
function findBlockFromCachedNode(node) {
  if (!node) return null;
  const fakeSelection = { anchorNode: node, focusNode: node };
  return findBlockFromSelection(fakeSelection);
}

function openMarkContextMenu(clientX, clientY, blockInfo, selectedText) {
  closeMarkContextMenu();
  closeLookupPopup();

  const menu = document.createElement("div");
  menu.className = "mark-context-menu";

  // 有选区给 5 个选项（书签 + 4 个标签）；没选区提供朗读此段与加书签
  const options = selectedText
    ? [
        { label: "加为书签", type: "bookmark", tag: null, toast: "已加书签" },
        { label: "标记为生词", type: "note", tag: "vocab", toast: "已标记为生词" },
        { label: "标记为好句", type: "note", tag: "good", toast: "已标记为好句" },
        { label: "标记为难句", type: "note", tag: "hard", toast: "已标记为难句" },
        { label: "标记为语法", type: "note", tag: "grammar", toast: "已标记为语法" },
      ]
    : [
        { label: "朗读此段", type: "tts", tag: null, toast: null },
        { label: "在当前位置加书签", type: "bookmark", tag: null, toast: "已加书签" },
      ];

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mark-context-menu-item";
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      if (opt.type === "tts") {
        startTts(blockInfo.blockIndex);
      } else {
        if (appendMark(opt, blockInfo, selectedText)) {
          showToast(opt.toast);
        }
      }
      closeMarkContextMenu();
    });
    menu.append(btn);
  });

  dom.shell.append(menu);
  positionMarkContextMenu(menu, clientX, clientY);

  currentMarkContextMenu = menu;
  markContextMenuOutsideHandler = (event) => {
    if (menu.contains(event.target)) return;
    closeMarkContextMenu();
  };
  document.addEventListener("mousedown", markContextMenuOutsideHandler);
}

function closeMarkContextMenu() {
  if (currentMarkContextMenu) {
    currentMarkContextMenu.remove();
    currentMarkContextMenu = null;
  }
  if (markContextMenuOutsideHandler) {
    document.removeEventListener("mousedown", markContextMenuOutsideHandler);
    markContextMenuOutsideHandler = null;
  }
}

function positionMarkContextMenu(menu, x, y) {
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  let left = x;
  let top = y;
  if (left + width > viewportWidth - margin) left = viewportWidth - width - margin;
  if (left < margin) left = margin;
  if (top + height > viewportHeight - margin) top = viewportHeight - height - margin;
  if (top < margin) top = margin;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// 从选区端点反查它所在的虚拟 block
function findBlockFromSelection(selection) {
  if (!selection || !selection.anchorNode) return null;
  const node = selection.anchorNode;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const blockEl = el?.closest?.("[data-virtual-index]");
  if (!blockEl) return null;
  const blockIndex = Number(blockEl.dataset.virtualIndex);
  if (Number.isNaN(blockIndex)) return null;
  return { blockIndex, block: virtualBook.blocks[blockIndex] || null };
}

// 从 dom.reader.scrollTop 推断当前所在的 block
function getCurrentBlockInfo() {
  const blockIndex = findBlockIndexAt(dom.reader.scrollTop);
  return { blockIndex, block: virtualBook.blocks[blockIndex] || null };
}

// 列表面板：开关、互斥（打开时顺手关掉翻译面板，避免叠在一起）
function toggleMarksPanel() {
  if (marksPanelOpen) {
    closeMarksPanel();
  } else {
    openMarksPanel();
  }
}

function openMarksPanel() {
  if (state.translator.panelOpen) closeTranslatorPanel();
  if (tocPanelOpen) closeTocPanel();
  if (searchPanelOpen) closeSearchPanel();
  marksPanelOpen = true;
  dom.marksPanel.hidden = false;
  dom.marksButton.classList.add("active");
  renderMarksList();
}

function closeMarksPanel() {
  marksPanelOpen = false;
  dom.marksPanel.hidden = true;
  dom.marksButton.classList.remove("active");
}

// 目录面板：和翻译/标记面板互斥，点章节跳转后保持打开方便继续浏览
function toggleTocPanel() {
  if (tocPanelOpen) {
    closeTocPanel();
  } else {
    openTocPanel();
  }
}

function openTocPanel() {
  if (state.translator.panelOpen) closeTranslatorPanel();
  if (marksPanelOpen) closeMarksPanel();
  if (searchPanelOpen) closeSearchPanel();
  tocPanelOpen = true;
  dom.tocPanel.hidden = false;
  dom.tocButton.classList.add("active");
  renderTocList();
}

function closeTocPanel() {
  tocPanelOpen = false;
  dom.tocPanel.hidden = true;
  dom.tocButton.classList.remove("active");
}

function renderTocList() {
  const list = dom.tocList;
  list.replaceChildren();

  if (!state.chapters.length) {
    const empty = document.createElement("p");
    empty.className = "toc-empty";
    empty.textContent = "先导入一本书才能看到目录。";
    list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.chapters.forEach((chapter, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "toc-item";
    item.dataset.index = String(index);
    item.setAttribute("role", "listitem");
    if (index === state.currentChapterIndex) item.classList.add("active");

    const indexEl = document.createElement("span");
    indexEl.className = "toc-item-index";
    indexEl.textContent = `${index + 1}.`;

    const titleEl = document.createElement("span");
    titleEl.className = "toc-item-title";
    titleEl.textContent = chapter.title || `第 ${index + 1} 节`;

    item.append(indexEl, titleEl);
    fragment.append(item);
  });
  list.append(fragment);

  // 打开面板时把当前章节滚到视野内，避免长目录看不到自己在哪
  const active = list.querySelector(".toc-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function handleTocListClick(event) {
  const item = event.target.closest(".toc-item");
  if (!item) return;
  const index = Number(item.dataset.index);
  if (!Number.isFinite(index)) return;
  scrollToChapter(index);
}

// 滚动时轻量更新当前章节高亮，不重绘整个列表，避免长目录闪烁
function highlightTocActive() {
  if (!tocPanelOpen) return;
  const items = dom.tocList.querySelectorAll(".toc-item");
  items.forEach((item) => {
    const isActive = Number(item.dataset.index) === state.currentChapterIndex;
    item.classList.toggle("active", isActive);
  });
}

// ============ 全文搜索：扫所有章节段落，点结果跳到对应 block ============

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_SNIPPET_RADIUS = 36;
let searchDebounceTimer = 0;

function toggleSearchPanel() {
  if (searchPanelOpen) {
    closeSearchPanel();
  } else {
    openSearchPanel();
  }
}

function openSearchPanel() {
  if (state.translator.panelOpen) closeTranslatorPanel();
  if (marksPanelOpen) closeMarksPanel();
  if (tocPanelOpen) closeTocPanel();
  searchPanelOpen = true;
  dom.searchPanel.hidden = false;
  dom.searchButton.classList.add("active");
  // 打开就聚焦输入框，方便直接打字
  dom.searchInput.focus();
  dom.searchInput.select();
  renderSearchResults(dom.searchInput.value || "");
}

function closeSearchPanel() {
  searchPanelOpen = false;
  dom.searchPanel.hidden = true;
  dom.searchButton.classList.remove("active");
}

function handleSearchInput(event) {
  clearTimeout(searchDebounceTimer);
  const value = event.target.value;
  searchDebounceTimer = setTimeout(() => renderSearchResults(value), SEARCH_DEBOUNCE_MS);
}

function renderSearchResults(query) {
  const list = dom.searchResults;
  list.replaceChildren();
  const trimmed = query.trim();

  if (!state.chapters.length) {
    dom.searchSummary.textContent = "";
    list.append(buildSearchEmpty("先导入一本书才能搜索。"));
    return;
  }
  if (!trimmed) {
    dom.searchSummary.textContent = "";
    list.append(buildSearchEmpty("输入关键词开始搜索（不区分大小写）。"));
    return;
  }

  const { results, total, truncated } = searchInBook(trimmed);
  if (!results.length) {
    dom.searchSummary.textContent = "";
    list.append(buildSearchEmpty(`没有找到 "${trimmed}"。`));
    return;
  }

  dom.searchSummary.textContent = truncated
    ? `${total}+ 处，只显示前 ${SEARCH_MAX_RESULTS}`
    : `${total} 处`;

  const fragment = document.createDocumentFragment();
  results.forEach((hit) => fragment.append(buildSearchResultItem(hit, trimmed)));
  list.append(fragment);
}

function buildSearchEmpty(text) {
  const p = document.createElement("p");
  p.className = "search-empty";
  p.textContent = text;
  return p;
}

// 在所有章节的段落里做大小写不敏感的 indexOf 搜索；
// 同一段多次命中只取第一处（保持结果列表精简），需要更精细可后续按 hit 序列出
function searchInBook(query) {
  const needle = query.toLowerCase();
  const results = [];
  let total = 0;

  for (let ci = 0; ci < state.chapters.length; ci += 1) {
    const chapter = state.chapters[ci];
    const paragraphs = splitParagraphs(chapter.text || "");
    for (let pi = 0; pi < paragraphs.length; pi += 1) {
      const paragraph = paragraphs[pi];
      const lower = paragraph.toLowerCase();
      let from = 0;
      let hitInParagraph = 0;
      while (from <= lower.length) {
        const idx = lower.indexOf(needle, from);
        if (idx === -1) break;
        total += 1;
        if (hitInParagraph === 0 && results.length < SEARCH_MAX_RESULTS) {
          results.push({
            chapterIndex: ci,
            chapterTitle: chapter.title || `第 ${ci + 1} 章`,
            paragraphIndex: pi,
            paragraph,
            matchStart: idx,
            matchLength: query.length,
          });
        }
        hitInParagraph += 1;
        from = idx + Math.max(1, query.length);
      }
    }
  }

  return { results, total, truncated: total > results.length };
}

function buildSearchResultItem(hit, query) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "search-result";
  item.dataset.chapterIndex = String(hit.chapterIndex);
  item.dataset.paragraphIndex = String(hit.paragraphIndex);
  item.setAttribute("role", "listitem");

  const chapter = document.createElement("div");
  chapter.className = "search-result-chapter";
  chapter.textContent = `${hit.chapterIndex + 1}. ${hit.chapterTitle}`;

  const snippet = document.createElement("div");
  snippet.className = "search-result-snippet";
  appendSnippetWithHighlight(snippet, hit, query);

  item.append(chapter, snippet);
  return item;
}

// 命中位置 ± SEARCH_SNIPPET_RADIUS 字符作为预览，关键词包成 .search-hit 高亮
function appendSnippetWithHighlight(container, hit, query) {
  const start = Math.max(0, hit.matchStart - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(hit.paragraph.length, hit.matchStart + hit.matchLength + SEARCH_SNIPPET_RADIUS);
  const prefix = (start > 0 ? "…" : "") + hit.paragraph.slice(start, hit.matchStart);
  const matched = hit.paragraph.slice(hit.matchStart, hit.matchStart + hit.matchLength);
  const suffix = hit.paragraph.slice(hit.matchStart + hit.matchLength, end) + (end < hit.paragraph.length ? "…" : "");

  container.append(document.createTextNode(prefix));
  const mark = document.createElement("span");
  mark.className = "search-hit";
  mark.textContent = matched;
  container.append(mark);
  container.append(document.createTextNode(suffix));
}

function handleSearchResultClick(event) {
  const item = event.target.closest(".search-result");
  if (!item) return;
  const ci = Number(item.dataset.chapterIndex);
  const pi = Number(item.dataset.paragraphIndex);
  if (!Number.isFinite(ci) || !Number.isFinite(pi)) return;
  jumpToParagraph(ci, pi);
}

// 找到第一个 (chapterIndex, paragraphIndex) 匹配的 block 滚过去；
// 双栏对照里 block.paragraphIndex 即是段索引，原文/双语模式下也带这两字段，可直接用
function jumpToParagraph(chapterIndex, paragraphIndex) {
  if (!virtualBook.blocks.length) return;
  const blockIndex = virtualBook.blocks.findIndex(
    (b) => b.chapterIndex === chapterIndex && b.paragraphIndex === paragraphIndex
  );
  if (blockIndex < 0) {
    // 没匹配到（理论上不会发生），退化到按章跳转
    scrollToChapter(chapterIndex);
    return;
  }
  const offset = virtualBook.offsets[blockIndex] || 0;
  state.currentChapterIndex = chapterIndex;
  
  // 手动跳转段落时，清除上次的朗读续读缓存
  ttsState.lastBlockIndex = -1;
  
  dom.reader.scrollTo({ top: Math.max(0, offset - 12), behavior: "smooth" });
  updateButtons();
  highlightTocActive();
}

// ============ TTS 朗读：浏览器原生 SpeechSynthesis ============

const ttsState = {
  active: false,
  paused: false,
  blockIndex: -1,
  sentenceIndex: 0,
  utterance: null,
  // 当前段在 DOM 中被改写成 sentence span overlay 后的引用，便于句级高亮和恢复
  overlay: null,
  lastBlockIndex: -1, // 上次朗读到哪段，支持续读
};
let ttsVoices = [];
let ttsResumeTimer = 0;

function ttsSupported() {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

function toggleTts() {
  if (!ttsSupported() || !state.chapters.length) return;
  if (ttsState.active) {
    stopTts();
    return;
  }
  
  let targetBlockIndex = -1;
  const [startIndex, endIndex] = virtualBook.renderedRange;
  // 如果有上次播放段落，且该段落仍然在当前可见范围内（说明用户没有大范围翻页滚动），则直接续读
  if (
    ttsState.lastBlockIndex !== -1 &&
    ttsState.lastBlockIndex >= startIndex &&
    ttsState.lastBlockIndex <= endIndex
  ) {
    targetBlockIndex = ttsState.lastBlockIndex;
  } else {
    // 否则从当前可见的首段开始读
    const { blockIndex } = getCurrentBlockInfo();
    targetBlockIndex = Math.max(0, blockIndex);
  }
  
  startTts(targetBlockIndex);
}

function startTts(blockIndex) {
  if (!ttsSupported()) return;
  // iOS Safari 需要在用户手势内首次调一次 speak 才能后续异步触发
  try { speechSynthesis.cancel(); } catch {}
  ttsState.active = true;
  ttsState.paused = false;
  ttsState.blockIndex = blockIndex;
  ttsState.sentenceIndex = 0;
  applyTtsRateUI();
  ensureTtsVoicesLoaded();
  showTtsBar();
  dom.ttsButton.classList.add("active");
  speakCurrentTtsBlock();
}

function stopTts() {
  if (!ttsSupported()) return;
  if (ttsResumeTimer) {
    clearInterval(ttsResumeTimer);
    ttsResumeTimer = 0;
  }
  try { speechSynthesis.cancel(); } catch {}
  // 停止前记下最后段位置，下次点朗读可续读
  ttsState.lastBlockIndex = ttsState.blockIndex;
  removeTtsOverlay();
  clearTtsBlockHighlight();
  ttsState.active = false;
  ttsState.paused = false;
  ttsState.blockIndex = -1;
  ttsState.sentenceIndex = 0;
  ttsState.utterance = null;
  hideTtsBar();
  dom.ttsButton.classList.remove("active");
}

function getSentenceBaseDuration(text) {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const totalLen = text.length || 1;
  const isCjk = (cjkCount / totalLen) > 0.3;
  // 优化后的中英文朗读速率常量（每秒朗读字符数），匹配主流系统和浏览器默认语音包的实际语速
  const charSpeed = isCjk ? 7.2 : 20.0;
  
  // 句末微小停顿缓冲时间调整为 100ms，防止多句叠加后高亮出现明显滞后
  return (totalLen / charSpeed) * 1000 + 100;
}

function startTtsTimer() {
  clearTtsTimer();
  if (!ttsState.active || ttsState.paused) return;
  ttsState.timerId = window.setInterval(updateTtsTimerProgress, 100);
}

function pauseTtsTimer() {
  if (ttsState.timerId) {
    window.clearInterval(ttsState.timerId);
    ttsState.timerId = 0;
  }
}

function clearTtsTimer() {
  pauseTtsTimer();
  ttsState.elapsedOffset = 0;
  ttsState.sentenceEndTimes = [];
}

function updateTtsTimerProgress() {
  // 不再因为 onboundary 触发过就禁用备用计时器：onboundary 在某些 voice 上
  // 只触发零星几次甚至不再触发，禁用计时器会导致高亮卡在首句。
  // 改为双管齐下：boundary 和 timer 谁先发现更靠后的句子谁高亮（applyTtsSentenceHighlight 只前进不倒退）
  const overlay = ttsState.overlay;
  if (!overlay || !ttsState.sentenceEndTimes.length) return;

  const elapsed = (performance.now() - ttsState.startTime) + ttsState.elapsedOffset;
  const rate = clamp(Number(state.settings.ttsRate) || 1, 0.5, 2.5);
  const elapsedAdjusted = elapsed * rate;

  let idx = ttsState.sentenceEndTimes.findIndex((endTime) => elapsedAdjusted < endTime);
  if (idx < 0) {
    idx = ttsState.sentenceEndTimes.length - 1;
  }
  applyTtsSentenceHighlight(idx);
}

// 朗读句级高亮"只前进不倒退"：boundary 和 timer 都会调用，
// 谁先到更靠后的句子就推进；倒退或同句直接忽略，避免来回闪
function applyTtsSentenceHighlight(idx) {
  const overlay = ttsState.overlay;
  if (!overlay) return;
  if (typeof idx !== "number" || idx < 0) return;
  if (idx <= ttsState.sentenceIndex) return;
  ttsState.sentenceIndex = idx;
  overlay.sentences.forEach((s, i) => {
    s.el.classList.toggle("is-active", i === idx);
    s.el.classList.toggle("is-spoken", i < idx);
  });
}

function togglePauseTts() {
  if (!ttsState.active) return;
  if (ttsState.paused) {
    speechSynthesis.resume();
    ttsState.paused = false;
    dom.ttsPlay.textContent = "⏸";
    dom.ttsPlay.title = "暂停";
  } else {
    speechSynthesis.pause();
    ttsState.paused = true;
    dom.ttsPlay.textContent = "▶";
    dom.ttsPlay.title = "继续";
  }
}

function jumpTtsBlock(step) {
  if (!ttsState.active) return;
  const next = clamp(ttsState.blockIndex + step, 0, virtualBook.blocks.length - 1);
  if (next === ttsState.blockIndex) return;
  ttsState.blockIndex = next;
  ttsState.paused = false;
  dom.ttsPlay.textContent = "⏸";
  speakCurrentTtsBlock();
}

// 段切换：准备 overlay + 段级高亮 + 滚到视野，然后开始读第 0 句
function speakCurrentTtsBlock() {
  if (!ttsState.active) return;
  const block = virtualBook.blocks[ttsState.blockIndex];
  if (!block) {
    stopTts();
    return;
  }
  const text = normalizeText(block.text || "").replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!text) {
    ttsState.blockIndex += 1;
    speakCurrentTtsBlock();
    return;
  }

  state.currentChapterIndex = block.chapterIndex;
  scrollBlockIntoTtsView(ttsState.blockIndex);
  highlightTtsBlock(ttsState.blockIndex);
  prepareTtsSentenceOverlay(ttsState.blockIndex, block);

  // Chrome 长 utterance ~15s 自动暂停的 bug：心跳保活
  // 现在每句独立 utterance，大多数英文句子 < 15s，不会触发；但留作兜底
  if (ttsResumeTimer) clearInterval(ttsResumeTimer);
  ttsResumeTimer = setInterval(() => {
    if (!ttsState.active) return;
    if (!ttsState.paused && speechSynthesis.speaking && speechSynthesis.paused) {
      speechSynthesis.resume();
    }
  }, 10000);

  // 句索引重置到 -1，让 speakSentenceInBlock(0) 能正常 highlight 第 0 句
  ttsState.sentenceIndex = -1;
  speakSentenceInBlock(0);
}

// 段内某一句独立 speak：每句一个 utterance，onend 时切下一句，
// 高亮 100% 跟着 utterance 生命周期，不依赖任何 timer/boundary
function speakSentenceInBlock(sentenceIdx) {
  if (!ttsState.active) return;
  const overlay = ttsState.overlay;
  if (!overlay) {
    advanceTtsBlock();
    return;
  }
  const sentence = overlay.sentences[sentenceIdx];
  if (!sentence) {
    advanceTtsBlock();
    return;
  }

  // 切高亮：当前句 active，前面句 spoken
  applyTtsHighlight(sentenceIdx);

  const text = sentence.el.textContent || "";
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = clamp(Number(state.settings.ttsRate) || 1, 0.5, 2.5);
  const voice = pickTtsVoiceForText(text);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  utterance.onend = () => {
    if (!ttsState.active || ttsState.utterance !== utterance) return;
    // 接下一句
    speakSentenceInBlock(sentenceIdx + 1);
  };
  utterance.onerror = (e) => {
    if (e?.error === "interrupted" || e?.error === "canceled") return;
    stopTts();
  };

  ttsState.utterance = utterance;
  try { speechSynthesis.cancel(); } catch {}
  speechSynthesis.speak(utterance);
}

function advanceTtsBlock() {
  if (ttsState.blockIndex < virtualBook.blocks.length - 1) {
    ttsState.blockIndex += 1;
    speakCurrentTtsBlock();
  } else {
    stopTts();
  }
}

// 强制更新句高亮（不走"只前进不倒退"早退）：换段/换句时直接切
function applyTtsHighlight(sentenceIdx) {
  const overlay = ttsState.overlay;
  if (!overlay) return;
  ttsState.sentenceIndex = sentenceIdx;
  overlay.sentences.forEach((s, i) => {
    s.el.classList.toggle("is-active", i === sentenceIdx);
    s.el.classList.toggle("is-spoken", i < sentenceIdx);
  });
}

// 朗读时让正在读的段滚到视野中央：已在视野不滚，避开虚拟列表抖动
function scrollBlockIntoTtsView(blockIndex) {
  const offset = virtualBook.offsets[blockIndex] || 0;
  const blockHeight = virtualBook.blocks[blockIndex]?.height || 0;
  const viewportTop = dom.reader.scrollTop;
  const viewportBottom = viewportTop + dom.reader.clientHeight;
  const blockBottom = offset + blockHeight;
  // 段完全在视野内 → 不滚；否则把段顶滚到上 1/3 处
  if (offset < viewportTop + 80 || blockBottom > viewportBottom - 80) {
    const target = Math.max(0, offset - dom.reader.clientHeight * 0.3);
    dom.reader.scrollTo({ top: target, behavior: "smooth" });
  }
}

function findBlockDomNode(blockIndex) {
  return dom.reader.querySelector(`[data-virtual-index="${blockIndex}"]`);
}

function clearTtsBlockHighlight() {
  dom.reader.querySelectorAll(".tts-block-active").forEach((el) => el.classList.remove("tts-block-active"));
}

function highlightTtsBlock(blockIndex) {
  clearTtsBlockHighlight();
  const node = findBlockDomNode(blockIndex);
  if (node) node.classList.add("tts-block-active");
}

// ============ TTS 句级高亮：在朗读段的 DOM 上拆 sentence span ============

// overlay 结构：{ container, sentences: [{el, start, end}], originalNodes }
function prepareTtsSentenceOverlay(blockIndex, block) {
  removeTtsOverlay();
  const blockNode = findBlockDomNode(blockIndex);
  if (!blockNode) return;
  // 对双栏对照拿原文 cell，对普通段落直接拿段本身
  const target = blockNode.classList.contains("sentence-pair")
    ? blockNode.querySelector(".original-cell")
    : blockNode;
  if (!target) return;

  const normalizedText = normalizeText(block.text || "").replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
  const sentencesWithRange = splitSentencesWithRanges(normalizedText);
  if (!sentencesWithRange.length) return;

  const originalNodes = [...target.childNodes].map((n) => n.cloneNode(true));
  target.replaceChildren();
  const sentenceEls = [];
  sentencesWithRange.forEach((s, i) => {
    if (i > 0) {
      const prevEnd = sentencesWithRange[i - 1].text.slice(-1);
      if (prevEnd && !/[。！？；…]/.test(prevEnd)) target.append(" ");
    }
    const span = document.createElement("span");
    span.className = "tts-sentence";
    span.dataset.ttsIndex = String(i);
    span.textContent = s.text;
    target.append(span);
    sentenceEls.push({ el: span, start: s.start, end: s.end });
  });

  ttsState.overlay = { container: target, sentences: sentenceEls, originalNodes };
  // 高亮交由 speakSentenceInBlock 即时调用 applyTtsHighlight 控制，不在 overlay 创建时预设
}

function removeTtsOverlay() {
  const overlay = ttsState.overlay;
  if (!overlay) return;
  try {
    overlay.container.replaceChildren(...overlay.originalNodes);
  } catch {
    // DOM 已被虚拟列表回收：忽略
  }
  ttsState.overlay = null;
}

function setupTtsBoundary(utterance, text) {
  utterance.onboundary = (event) => {
    if (!ttsState.active || ttsState.utterance !== utterance) return;
    const overlay = ttsState.overlay;
    if (!overlay) return;
    const charIndex = event.charIndex;
    if (typeof charIndex !== "number") return;

    let idx = overlay.sentences.findIndex((s) => charIndex >= s.start && charIndex < s.end);
    if (idx < 0) {
      // 容错：恰好落在句子间隙（空格/句尾标点），取 charIndex 之前的最后一句
      idx = overlay.sentences.findIndex((s, i) => {
        const next = overlay.sentences[i + 1];
        return charIndex >= s.start && (!next || charIndex < next.start);
      });
    }
    if (idx < 0) return;
    // 走统一路径"只前进不倒退"，与备用 timer 共用，避免互相干扰
    applyTtsSentenceHighlight(idx);
  };
}

// 把段落原文切句并记录每句在 text 里的字符区间，用于 onboundary 反查当前句
function splitSentencesWithRanges(text) {
  const sentences = splitSentences(text);
  const ranges = [];
  let cursor = 0;
  sentences.forEach((sentence) => {
    if (!sentence) return;
    const idx = text.indexOf(sentence, cursor);
    if (idx < 0) return;
    ranges.push({ text: sentence, start: idx, end: idx + sentence.length });
    cursor = idx + sentence.length;
  });
  return ranges;
}

// ============ TTS voice 列表 + 自动选 voice + 设置同步 ============

function ensureTtsVoicesLoaded() {
  if (!ttsSupported()) return;
  ttsVoices = speechSynthesis.getVoices() || [];
  if (!ttsVoices.length) {
    // voiceschanged 事件会异步触发 refreshTtsVoiceList
    return;
  }
  refreshTtsVoiceList();
}

function refreshTtsVoiceList() {
  if (!ttsSupported()) return;
  ttsVoices = speechSynthesis.getVoices() || [];
  // 渲染下拉，按语言分组
  dom.ttsVoice.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动";
  dom.ttsVoice.append(auto);
  ttsVoices.forEach((voice) => {
    const opt = document.createElement("option");
    opt.value = voice.voiceURI;
    opt.textContent = `${voice.name} (${voice.lang})`;
    dom.ttsVoice.append(opt);
  });
  // 选回上次的 voice（如果还在）
  const preferred = state.settings.ttsVoiceURI || "";
  if (preferred && ttsVoices.some((v) => v.voiceURI === preferred)) {
    dom.ttsVoice.value = preferred;
  }
}

// 段内主要是 CJK 字符 → 优先中文 voice；否则用英文 voice；都没有再回退
function pickTtsVoiceForText(text) {
  if (!ttsVoices.length) return null;
  const preferredURI = state.settings.ttsVoiceURI;
  if (preferredURI) {
    const found = ttsVoices.find((v) => v.voiceURI === preferredURI);
    if (found) return found;
  }
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  const total = text.length || 1;
  const lang = cjk / total > 0.3 ? /^zh/i : /^en/i;
  return (
    ttsVoices.find((v) => lang.test(v.lang)) ||
    ttsVoices.find((v) => v.default) ||
    ttsVoices[0] ||
    null
  );
}

function handleTtsRateChange(event) {
  const rate = clamp(Number(event.target.value) || 1, 0.5, 2.5);
  state.settings.ttsRate = rate;
  saveState();
  applyTtsRateUI();
  // 即时生效：当前 utterance 改不了 rate，重启当前段
  if (ttsState.active && ttsState.utterance) speakCurrentTtsBlock();
}

function applyTtsRateUI() {
  const rate = Number(state.settings.ttsRate) || 1;
  dom.ttsRate.value = String(rate);
  dom.ttsRateValue.textContent = `${rate.toFixed(1)}×`;
}

function handleTtsVoiceChange(event) {
  state.settings.ttsVoiceURI = event.target.value || "";
  saveState();
  if (ttsState.active) speakCurrentTtsBlock();
}

function showTtsBar() {
  dom.ttsBar.hidden = false;
}

function hideTtsBar() {
  dom.ttsBar.hidden = true;
  dom.ttsPlay.textContent = "⏸";
  dom.ttsPlay.title = "暂停 / 继续";
}

// 查词弹窗里的"朗读"按钮：独立的短朗读，不影响主朗读队列
function speakLookupWord(word) {
  if (!ttsSupported() || !word) return;
  ensureTtsVoicesLoaded();
  // 如果主朗读在进行，先停下避免被覆盖；用户再点工具栏才会重新开始
  if (ttsState.active) stopTts();
  try { speechSynthesis.cancel(); } catch {}
  const utterance = new SpeechSynthesisUtterance(word);
  const voice = pickTtsVoiceForText(word);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = clamp(Number(state.settings.ttsRate) || 1, 0.5, 2.5);
  speechSynthesis.speak(utterance);
}

// 渲染列表：按 createdAt 倒序 + 按 marksFilter 过滤
function renderMarksList() {
  const list = dom.marksList;
  list.replaceChildren();

  // 同步过滤标签的 active 状态
  dom.marksFilter.querySelectorAll(".marks-filter-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.filter === marksFilter);
  });

  if (!state.book?.id) {
    list.append(buildMarksEmpty("先导入一本书才能看到这本书的标记。"));
    return;
  }

  const all = readMarks(state.book.id);
  const filtered = all.filter((mark) => markMatchesFilter(mark, marksFilter));

  if (!filtered.length) {
    list.append(buildMarksEmpty(all.length ? "当前筛选下没有标记。" : "还没有任何标记。"));
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((mark) => fragment.append(buildMarkCard(mark)));
  list.append(fragment);
}

function buildMarksEmpty(text) {
  const p = document.createElement("p");
  p.className = "marks-empty";
  p.textContent = text;
  return p;
}

function markMatchesFilter(mark, filter) {
  if (filter === "all") return true;
  if (filter === "bookmark") return mark.type === "bookmark";
  return mark.type === "note" && mark.tag === filter;
}

function buildMarkCard(mark) {
  const item = document.createElement("div");
  item.className = "mark-item";
  item.dataset.id = mark.id;

  const meta = document.createElement("div");
  meta.className = "mark-meta";

  const chapter = document.createElement("span");
  chapter.className = "mark-chapter";
  chapter.textContent = mark.chapterTitle || `第 ${(mark.chapterIndex ?? 0) + 1} 章`;
  meta.append(chapter);

  const time = document.createElement("span");
  time.className = "mark-time";
  time.textContent = formatRelativeTime(mark.createdAt);
  meta.append(time);

  const tagKey = mark.type === "bookmark" ? "bookmark" : mark.tag;
  if (tagKey) {
    const tag = document.createElement("span");
    tag.className = `mark-tag tag-${tagKey}`;
    tag.textContent = MARK_TAG_LABELS[tagKey] || tagKey;
    meta.append(tag);
  }

  item.append(meta);

  if (mark.selectedText) {
    const text = document.createElement("p");
    text.className = "mark-text";
    text.textContent = mark.selectedText;
    item.append(text);
  }

  if (mark.comment) {
    const comment = document.createElement("p");
    comment.className = "mark-comment";
    comment.textContent = mark.comment;
    item.append(comment);
  }

  const actions = document.createElement("div");
  actions.className = "mark-actions";

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "mark-jump";
  jump.dataset.action = "jump";
  jump.textContent = "跳转";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "mark-delete";
  del.dataset.action = "delete";
  del.textContent = "删除";

  actions.append(jump, del);
  item.append(actions);

  return item;
}

// "5 分钟前 / 3 小时前 / 2 天前 / yyyy-mm-dd" 格式
function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const diff = Date.now() - Number(timestamp);
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function createMarkId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  // 兜底：极旧浏览器没 randomUUID 时拼时间戳 + 随机数
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 过滤标签栏的事件委托：点哪一个就切到它
function handleMarksFilterClick(event) {
  const tab = event.target.closest(".marks-filter-tab");
  if (!tab) return;
  const next = tab.dataset.filter || "all";
  if (next === marksFilter) return;
  marksFilter = next;
  renderMarksList();
}

// 列表卡片里的"跳转/删除"按钮事件委托
function handleMarksListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".mark-item");
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;

  if (button.dataset.action === "jump") {
    jumpToMarkById(id);
  } else if (button.dataset.action === "delete") {
    deleteMarkById(id);
  }
}

function jumpToMarkById(id) {
  if (!state.book?.id) return;
  const mark = readMarks(state.book.id).find((m) => m.id === id);
  if (!mark) return;

  // 章节定位：把 currentChapterIndex 调过去，updateButtons 才会同步
  state.currentChapterIndex = Number(mark.chapterIndex) || 0;
  // blockIndex 在当前 virtualBook 范围内就用它，否则用 scrollTop 兜底
  if (
    typeof mark.blockIndex === "number" &&
    mark.blockIndex >= 0 &&
    mark.blockIndex < virtualBook.offsets.length
  ) {
    restoreScroll(virtualBook.offsets[mark.blockIndex]);
  } else {
    restoreScroll(Number(mark.scrollTop) || 0);
  }
  closeMarksPanel();
}

function deleteMarkById(id) {
  if (!state.book?.id) return;
  const marks = readMarks(state.book.id).filter((m) => m.id !== id);
  writeMarks(state.book.id, marks);
  renderMarksList();
  showToast("已删除");
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
    addBookmark();
  }
}

function handleImmersivePointer(event) {
  if (!state.immersive) return;
  dom.shell.classList.toggle("immersive-peek", event.clientY < 72);
}

function clearBook() {
  // 清空当前书时关掉标记/目录面板和右键菜单（没书也就没标记/目录可看）；
  // 注意 rt_progress / rt_notes 不主动清，重新导入同一本书还能找回。
  closeMarksPanel();
  closeTocPanel();
  closeSearchPanel();
  stopTts();
  ttsState.lastBlockIndex = -1; // 清除续读缓存
  closeMarkContextMenu();
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

    // 向后兼容：Phase 1 之前导入的书没有 SHA-256 id，给它一个根据
    // fileName+size 的同步 fallback，保证书签 / 列表 / 进度 API 都能正常找到 bookId。
    // 新格式（SHA-256 hex）和旧格式（"legacy-…"）格式不同，互不冲突。
    const book = ensureLegacyBookId(saved?.book);

    return {
      ...structuredClone(defaultState),
      ...(saved || {}),
      book,
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

function ensureLegacyBookId(book) {
  if (!book) return null;
  if (book.id) return book;
  const key = `${book.fileName || book.title || ""}::${book.size || 0}`;
  return { ...book, id: `legacy-${hashText(key)}` };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("ReadTaylor 保存失败：", error);
  }
}

// ============ bookId + 按书持久化（进度 / 标记） ============

// 用文件全量内容的 SHA-256 作为 bookId。同名同大小但内容不同的文件不会混淆，
// 重命名后再导入也能找回原书的进度和标记。
async function computeFileBookId(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readProgress(bookId) {
  if (!bookId) return null;
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY_PREFIX + bookId) || "null");
  } catch {
    return null;
  }
}

function writeProgress(bookId, progress) {
  if (!bookId) return;
  try {
    localStorage.setItem(PROGRESS_KEY_PREFIX + bookId, JSON.stringify(progress));
  } catch (error) {
    console.warn("ReadTaylor 写入阅读进度失败：", error);
  }
}

function readMarks(bookId) {
  if (!bookId) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY_PREFIX + bookId) || "null");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeMarks(bookId, marks) {
  if (!bookId) return;
  try {
    localStorage.setItem(NOTES_KEY_PREFIX + bookId, JSON.stringify(marks));
  } catch (error) {
    console.warn("ReadTaylor 写入标记失败：", error);
  }
}

// 滚动停下时把当前位置写到 rt_progress_{bookId}。
// 优先记录 blockIndex（稳定锚点），scrollTop 仅作字号/翻译开关变化后的兜底。
function persistReadingProgress() {
  if (!state.book?.id || !virtualBook.blocks.length) return;
  const blockIndex = findBlockIndexAt(dom.reader.scrollTop);
  writeProgress(state.book.id, {
    chapterIndex: state.currentChapterIndex,
    blockIndex,
    scrollTop: dom.reader.scrollTop,
    updatedAt: Date.now(),
  });
}

// 按进度记录恢复滚动位置：优先用 blockIndex → 现有 virtualBook.offsets，
// 没法用时回落到 scrollTop。
function restoreFromProgress(progress) {
  if (!progress) {
    restoreScroll(0);
    return;
  }
  if (
    typeof progress.blockIndex === "number" &&
    progress.blockIndex >= 0 &&
    progress.blockIndex < virtualBook.offsets.length
  ) {
    restoreScroll(virtualBook.offsets[progress.blockIndex]);
    return;
  }
  restoreScroll(Number(progress.scrollTop) || 0);
}

// 轻量 toast，自动 2s 淡出，主要给"已恢复阅读位置"这类一过性提示用
let toastHideTimer = 0;
function showToast(message, duration = 2000) {
  let toast = document.querySelector(".rt-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "rt-toast";
    // 挂到 .app-shell 内部以继承当前主题变量（夜间/清爽等）
    dom.shell.append(toast);
  }
  toast.textContent = message;
  // 强制 reflow，否则刚创建的元素拿不到过渡起点
  void toast.offsetHeight;
  toast.classList.add("visible");
  window.clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => {
    toast.classList.remove("visible");
  }, duration);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 必须放在最底部：保证 toastHideTimer / marksPanelOpen / currentLookupPopup 等
// 模块级 let 声明都先初始化完，init() 里调用 showToast 等才不会撞上 TDZ。
init();
