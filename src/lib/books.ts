// 本地书库：所有书籍来自用户上传的文件，只存在浏览器本地。
// ReadTaylor 不内置任何书籍内容。
import { putFile } from "./filestore";
import { archiveToFixedLayoutEPUB, pdfToFixedLayoutEPUB } from "./fixedLayoutEpub";
import { findEpubCover, storeBookCover } from "./epubCover";

export interface Chapter {
  id: string;
  title: string;
  content: string; // 文本模式：段落之间用 \n\n 分隔；原版模式可为空
  href?: string; // 原版模式：章节在 EPUB 包内的完整路径
  isCover?: boolean; // 文字型 EPUB 的封面章节仍需按整页显示，不能被正文分页切开
}

export interface Book {
  id: string;
  title: string;
  author: string;
  fileType: string; // TXT / MD / PDF / EPUB
  color: string; // 生成的封面底色
  chapters: Chapter[];
  progress: number; // 0-100
  lastChapter: number;
  lastScroll?: number; // 0-1，章节内的阅读位置
  addedAt: number;
  mode?: "text" | "fidelity"; // 缺省按 text 处理；EPUB 为 fidelity（原版渲染）
  layout?: "reflowable" | "fixed"; // EPUB 排版：文字重排或固定页面（漫画 / 扫描 PDF）
  sourceKey?: string; // 同一来源再次打开时更新现有书籍，避免重复
}

export interface BookImportOptions {
  id?: string;
  sourceKey?: string;
}

const STORAGE_KEY = "readtaylor.books.v1";
const READING_POSITION_STORAGE_KEY = "readtaylor.reading-positions.v1";

interface SavedReadingPosition {
  lastChapter: number;
  lastScroll: number;
  progress: number;
}

type SavedReadingPositions = Record<string, SavedReadingPosition>;

// 暖色书脊调色板，呼应整体米色 / 棕金主题
const PALETTE = [
  "#8B6914",
  "#2d5a27",
  "#7a2020",
  "#3a5fa8",
  "#5a3a7a",
  "#1f5a5a",
  "#a8612a",
  "#494f6e",
];

export function coverColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

export function shade(hex: string, factor = 0.7): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function uid(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// 章节标题识别：第X章/回/节/卷、序章、楔子、Chapter N 等
const HEADING =
  /^(?:序章?|楔子|引子|前言|序言|尾声|后记|番外|卷[零一二三四五六七八九十百千]+|第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷部篇集]|chapter\s+\d+|chapter\s+[ivxlc]+)/i;

function isHeading(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 40 && HEADING.test(t);
}

function toParagraphs(raw: string): string {
  const text = raw.replace(/\r/g, "");
  const hasBlank = /\n[ \t]*\n/.test(text);
  const parts = hasBlank ? text.split(/\n[ \t]*\n/) : text.split(/\n/);
  return parts
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function parseTextToChapters(text: string, fallbackTitle: string): Chapter[] {
  const norm = text.replace(/\r/g, "");
  const lines = norm.split("\n");
  const headingIdx: number[] = [];
  lines.forEach((line, i) => {
    if (isHeading(line)) headingIdx.push(i);
  });

  const chapters: Chapter[] = [];

  if (headingIdx.length >= 2) {
    // 第一个标题之前的内容（如果有）作为开篇
    if (headingIdx[0] > 0) {
      const body = toParagraphs(lines.slice(0, headingIdx[0]).join("\n"));
      if (body) chapters.push({ id: "c0", title: "开篇", content: body });
    }
    headingIdx.forEach((start, idx) => {
      const end = idx + 1 < headingIdx.length ? headingIdx[idx + 1] : lines.length;
      const title = lines[start].trim();
      const body = toParagraphs(lines.slice(start + 1, end).join("\n"));
      chapters.push({ id: `c${idx + 1}`, title, content: body || title });
    });
  } else {
    // 没有章节标记：按段落数切成若干「节」，避免一屏几万字
    const paras = toParagraphs(norm).split("\n\n").filter(Boolean);
    const CHUNK = 80;
    if (paras.length <= CHUNK) {
      chapters.push({ id: "c1", title: fallbackTitle, content: paras.join("\n\n") });
    } else {
      for (let i = 0; i < paras.length; i += CHUNK) {
        const idx = Math.floor(i / CHUNK);
        chapters.push({
          id: `c${idx}`,
          title: `第 ${idx + 1} 节`,
          content: paras.slice(i, i + CHUNK).join("\n\n"),
        });
      }
    }
  }

  if (chapters.length === 0) {
    chapters.push({ id: "c1", title: fallbackTitle, content: "（文件为空）" });
  }
  return chapters;
}

// 把 PDF 抽取出的「视觉行」重新拼成段落：
// 句末标点收尾的行 → 段落结束；章节标题行单独成段，便于后续切章。
function linesToProse(lines: string[]): string {
  const enders = /[。！？…”』》】.!?]["'’”]?$/;
  const paras: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) paras.push(cur.trim());
    cur = "";
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (isHeading(line)) {
      flush();
      paras.push(line);
      continue;
    }
    // 拉丁文之间补空格，中文直接相接
    cur += cur && /[a-zA-Z0-9,;:]$/.test(cur) ? " " + line : line;
    if (enders.test(line)) flush();
  }
  flush();
  return paras.join("\n\n");
}

async function pdfToText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const allLines: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items as Array<{ str: string; hasEOL?: boolean }>) {
      line += item.str;
      if (item.hasEOL) {
        allLines.push(line);
        line = "";
      }
    }
    if (line) allLines.push(line);
    allLines.push(""); // 翻页留空行
    page.cleanup();
  }
  doc.destroy();
  return linesToProse(allLines);
}

function buildBook(
  title: string,
  fileType: string,
  chapters: Chapter[],
  author = "本地上传",
  options: BookImportOptions = {}
): Book {
  return {
    id: options.id || uid(),
    title,
    author,
    fileType,
    color: coverColor(title),
    chapters,
    progress: 0,
    lastChapter: 0,
    lastScroll: 0,
    addedAt: Date.now(),
    sourceKey: options.sourceKey,
  };
}

// 把相对路径基于 baseDir 归一化为 zip 内的完整路径（去掉锚点 #...）
function resolvePath(baseDir: string, rel: string): string {
  const cleaned = decodeURIComponent(rel.split("#")[0]);
  const parts = (baseDir ? baseDir.split("/") : []).concat(cleaned.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function localTags(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((e) => e.localName === local);
}

async function epubToBook(
  file: File,
  fallbackTitle: string,
  options: BookImportOptions
): Promise<AddResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const read = async (path: string): Promise<string> => {
    const entry = zip.file(path);
    return entry ? entry.async("text") : "";
  };
  const parser = new DOMParser();

  // 1. 通过 container.xml 找到 OPF
  const container = parser.parseFromString(await read("META-INF/container.xml"), "application/xml");
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) return { error: "EPUB 结构异常：找不到 OPF 清单。" };
  const opfDir = dirOf(opfPath);

  // 2. 解析 OPF：元数据 + manifest + spine
  const opf = parser.parseFromString(await read(opfPath), "application/xml");
  const bookTitle = localTags(opf, "title")[0]?.textContent?.trim() || fallbackTitle;
  const author = localTags(opf, "creator")[0]?.textContent?.trim() || "本地上传";
  const cover = await findEpubCover(zip, opf, opfPath).catch(() => null);

  const hrefById: Record<string, string> = {};
  let navHref = "";
  for (const item of localTags(opf, "item")) {
    const id = item.getAttribute("id") || "";
    const href = item.getAttribute("href") || "";
    hrefById[id] = href;
    if ((item.getAttribute("properties") || "").split(/\s+/).includes("nav")) navHref = href;
  }
  const spine = localTags(opf, "itemref")
    .map((ref) => ref.getAttribute("idref") || "")
    .map((id) => hrefById[id])
    .filter(Boolean);

  // 3. 目录标题：href(完整路径) → 章节名
  const tocMap: Record<string, string> = {};
  if (navHref) {
    const navPath = resolvePath(opfDir, navHref);
    const nav = parser.parseFromString(await read(navPath), "text/html");
    nav.querySelectorAll("a[href]").forEach((a) => {
      const label = a.textContent?.replace(/\s+/g, " ").trim();
      const href = a.getAttribute("href") || "";
      if (label) tocMap[resolvePath(dirOf(navPath), href)] = label;
    });
  }

  // 4. 逐个 spine 文件确定章节标题（原版模式：正文由 iframe 直接渲染原 HTML，
  //    此处只取标题，path 存入 chapter.href）
  const chapters: Chapter[] = [];
  for (let i = 0; i < spine.length; i++) {
    const path = resolvePath(opfDir, spine[i]);
    const html = await read(path);
    if (!html) continue;
    let title = tocMap[path];
    if (!title) {
      const doc = parser.parseFromString(html, "text/html");
      const heading = doc.querySelector("h1,h2,h3,h4,h5,h6");
      title =
        heading?.textContent?.replace(/\s+/g, " ").trim() ||
        doc.title?.trim() ||
        `第 ${chapters.length + 1} 章`;
    }
    chapters.push({
      id: `c${i}`,
      title,
      content: "",
      href: path,
      isCover: cover?.documentPath === path,
    });
  }

  if (chapters.length === 0) return { error: "无法从这个 EPUB 解析出章节。" };

  const fixedLayout = localTags(opf, "meta").some((meta) => (
    meta.getAttribute("property") === "rendition:layout"
    && meta.textContent?.trim() === "pre-paginated"
  ));
  const book = buildBook(bookTitle, "EPUB", chapters, author, options);
  book.mode = "fidelity";
  book.layout = fixedLayout ? "fixed" : "reflowable";
  // 原始文件存入 IndexedDB，供原版渲染反复读取
  await putFile(book.id, file);
  await storeBookCover(book.id, cover?.blob || null).catch(() => undefined);
  return { book };
}

export interface AddResult {
  book?: Book;
  error?: string;
}

export async function bookFromFile(
  file: File,
  options: BookImportOptions = {}
): Promise<AddResult> {
  const baseName = file.name.replace(/\.[^.]+$/, "") || "未命名";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isText = ext === "txt" || ext === "md" || file.type.startsWith("text/");

  if (isText) {
    const text = await file.text();
    return {
      book: buildBook(
        baseName,
        ext.toUpperCase() || "TXT",
        parseTextToChapters(text, baseName),
        "本地上传",
        options
      ),
    };
  }

  if (ext === "pdf" || file.type === "application/pdf") {
    try {
      const text = await pdfToText(file);
      if (!text.trim()) {
        const fixedLayout = await pdfToFixedLayoutEPUB(file);
        const result = await epubToBook(fixedLayout, baseName, options);
        if (result.book) result.book.fileType = "PDF";
        return result;
      }
      return {
        book: buildBook(
          baseName,
          "PDF",
          parseTextToChapters(text, baseName),
          "本地上传",
          options
        ),
      };
    } catch (e) {
      console.error("PDF 解析失败", e);
      return { error: "PDF 解析失败，文件可能已加密或损坏。" };
    }
  }

  if (ext === "cbz" || ext === "zip") {
    try {
      const fixedLayout = await archiveToFixedLayoutEPUB(file);
      const result = await epubToBook(fixedLayout, baseName, options);
      if (result.book) result.book.fileType = ext.toUpperCase();
      return result;
    } catch (e) {
      console.error("漫画压缩包解析失败", e);
      return { error: "漫画压缩包解析失败，请确认里面是按顺序排列的图片。" };
    }
  }

  if (ext === "epub" || file.type === "application/epub+zip") {
    try {
      return await epubToBook(file, baseName, options);
    } catch (e) {
      console.error("EPUB 解析失败", e);
      return { error: "EPUB 解析失败，文件可能已损坏或带 DRM 加密。" };
    }
  }

  return {
    error: `${ext.toUpperCase() || "该格式"} 暂不支持，目前支持 TXT / MD / PDF / EPUB / CBZ / ZIP`,
  };
}

export function loadBooks(): Book[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const positions = loadReadingPositions();
    return (parsed as Book[]).map((book) => {
      const saved = positions[book.id];
      if (!saved) return book;
      return {
        ...book,
        lastChapter: Math.min(Math.max(0, saved.lastChapter), Math.max(0, book.chapters.length - 1)),
        lastScroll: Math.min(1, Math.max(0, saved.lastScroll)),
        progress: Math.min(100, Math.max(0, saved.progress)),
      };
    });
  } catch {
    return [];
  }
}

function loadReadingPositions(): SavedReadingPositions {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_POSITION_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as SavedReadingPositions
      : {};
  } catch {
    return {};
  }
}

// 阅读过程中只写入很小的位置记录，避免滚动时反复重写整本书的内容。
export function saveReadingPosition(
  bookId: string,
  lastChapter: number,
  lastScroll: number,
  chapterCount: number
): boolean {
  try {
    const safeChapterCount = Math.max(1, chapterCount);
    const safeChapter = Math.min(Math.max(0, lastChapter), safeChapterCount - 1);
    const safeScroll = Math.min(1, Math.max(0, lastScroll));
    const positions = loadReadingPositions();
    positions[bookId] = {
      lastChapter: safeChapter,
      lastScroll: safeScroll,
      progress: Math.round(((safeChapter + 1) / safeChapterCount) * 100),
    };
    localStorage.setItem(READING_POSITION_STORAGE_KEY, JSON.stringify(positions));
    return true;
  } catch {
    return false;
  }
}

export function deleteReadingPosition(bookId: string): void {
  try {
    const positions = loadReadingPositions();
    if (!(bookId in positions)) return;
    delete positions[bookId];
    localStorage.setItem(READING_POSITION_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // 清理失败不影响用户继续使用书架。
  }
}

// 返回 false 表示写入失败（通常是 localStorage 超额），调用方可提示用户
export function saveBooks(books: Book[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
    return true;
  } catch {
    return false;
  }
}
