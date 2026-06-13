// 本地书库：所有书籍来自用户上传的文件，只存在浏览器本地。
// ReadTaylor 不内置任何书籍内容。

export interface Chapter {
  id: string;
  title: string;
  content: string; // 段落之间用 \n\n 分隔
}

export interface Book {
  id: string;
  title: string;
  author: string;
  fileType: string; // TXT / MD ...
  color: string; // 生成的封面底色
  chapters: Chapter[];
  progress: number; // 0-100
  lastChapter: number;
  addedAt: number;
}

const STORAGE_KEY = "readtaylor.books.v1";

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

export interface AddResult {
  book?: Book;
  error?: string;
}

export async function bookFromFile(file: File): Promise<AddResult> {
  const baseName = file.name.replace(/\.[^.]+$/, "") || "未命名";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isText = ext === "txt" || ext === "md" || file.type.startsWith("text/");

  if (!isText) {
    return {
      error: `${ext.toUpperCase() || "该格式"} 解析将在下一步接入，目前支持 TXT / MD`,
    };
  }

  const text = await file.text();
  const chapters = parseTextToChapters(text, baseName);
  const book: Book = {
    id: uid(),
    title: baseName,
    author: "本地上传",
    fileType: ext.toUpperCase() || "TXT",
    color: coverColor(baseName),
    chapters,
    progress: 0,
    lastChapter: 0,
    addedAt: Date.now(),
  };
  return { book };
}

export function loadBooks(): Book[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Book[]) : [];
  } catch {
    return [];
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
