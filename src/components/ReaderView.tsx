import { useState, useRef, useEffect } from "react";
import {
  ArrowLeft,
  Sun,
  Moon,
  Minus,
  Plus,
  AlignJustify,
  Check,
  NotebookPen,
  Pencil,
  StickyNote,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Square,
  Volume2,
  Languages,
  LoaderCircle,
  BookOpenText,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { Book } from "../lib/books";
import { renderChapter, resolveInternalIndex, cleanup as cleanupEpub } from "../lib/epubRender";
import { paginateFrame, scrollFrameToPage } from "../lib/epubPagination";
import { loadNotes, saveNotes, type NoteColor, type ReadingNote } from "../lib/notes";
import { loadPaginationCache, savePaginationCache } from "../lib/paginationCache";
import {
  loadBookFontSize,
  loadSpeechRate,
  loadTranslationLanguage,
  saveBookFontSize,
  saveSpeechRate,
  saveTranslationLanguage,
} from "../lib/readerPreferences";
import {
  loadCachedTranslation,
  requestTranslation,
  saveCachedTranslation,
  TRANSLATION_LANGUAGES,
} from "../lib/translation";

interface ReaderViewProps {
  book: Book;
  onBack: (lastChapterIndex: number, lastScroll: number) => void;
  onPositionChange: (lastChapterIndex: number, lastScroll: number) => void;
  isDark: boolean;
  onToggleDark: () => void;
}

type PendingPage =
  | { chapterIndex: number; mode: "first" | "last" }
  | { chapterIndex: number; mode: "progress"; progress: number };

type SelectionTarget = {
  text: string;
  x: number;
  y: number;
  source: "reader" | "iframe";
  chapterId: string;
  chapterTitle: string;
  pageIndex?: number;
  startOffset: number;
  endOffset: number;
};

type NoteComposer = {
  id?: string;
  quote: string;
  body: string;
  chapterId: string;
  chapterTitle: string;
  pageIndex?: number;
  createdAt?: number;
  color: NoteColor;
  startOffset?: number;
  endOffset?: number;
};

type ActiveNoteRange = {
  note: ReadingNote;
  startOffset: number;
  endOffset: number;
};

type VisibleTranslationSource = {
  text: string;
  pageKey: string;
};

const NOTE_COLORS: Array<{ id: NoteColor; label: string; hex: string; fill: string }> = [
  { id: "yellow", label: "黄色", hex: "#C58B20", fill: "rgba(236, 190, 76, 0.42)" },
  { id: "orange", label: "橙色", hex: "#C96B2C", fill: "rgba(230, 132, 62, 0.38)" },
  { id: "red", label: "红色", hex: "#B84A4A", fill: "rgba(214, 83, 83, 0.34)" },
  { id: "blue", label: "蓝色", hex: "#447DB6", fill: "rgba(74, 137, 199, 0.32)" },
  { id: "green", label: "绿色", hex: "#4E8A68", fill: "rgba(76, 148, 103, 0.32)" },
];

function noteColor(color?: NoteColor) {
  return NOTE_COLORS.find((item) => item.id === color) || NOTE_COLORS[0];
}

function getRangeOffsets(root: Node, range: Range, selectedText: string): { startOffset: number; endOffset: number } {
  const rawText = range.toString();
  const leadingWhitespace = rawText.length - rawText.trimStart().length;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const startOffset = before.toString().length + leadingWhitespace;
  return { startOffset, endOffset: startOffset + selectedText.length };
}

function rangeFromOffsets(root: Node, startOffset: number, endOffset: number): Range | null {
  if (startOffset < 0 || endOffset <= startOffset) return null;
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startInNode = 0;
  let endInNode = 0;
  let node = walker.nextNode() as Text | null;

  while (node) {
    const nextPosition = position + node.data.length;
    if (!startNode && startOffset >= position && startOffset <= nextPosition) {
      startNode = node;
      startInNode = startOffset - position;
    }
    if (endOffset >= position && endOffset <= nextPosition) {
      endNode = node;
      endInNode = endOffset - position;
      break;
    }
    position = nextPosition;
    node = walker.nextNode() as Text | null;
  }

  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, startInNode);
  range.setEnd(endNode, endInNode);
  return range;
}

function resolveNoteRange(root: Node, note: ReadingNote): ActiveNoteRange | null {
  const text = root.textContent || "";
  let startOffset = note.startOffset;
  let endOffset = note.endOffset;
  if (
    startOffset == null
    || endOffset == null
    || text.slice(startOffset, endOffset) !== note.quote
  ) {
    startOffset = text.indexOf(note.quote);
    endOffset = startOffset >= 0 ? startOffset + note.quote.length : -1;
  }
  if (startOffset < 0 || endOffset <= startOffset) return null;
  return { note, startOffset, endOffset };
}

function clearNoteHighlightMarks(root: Node): void {
  const marks = (root as ParentNode).querySelectorAll?.<HTMLElement>("mark[data-readtaylor-note-highlight]");
  marks?.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  });
}

function wrapNoteRange(doc: Document, root: Node, item: ActiveNoteRange): void {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: Array<{ node: Text; start: number; end: number }> = [];
  let position = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const nextPosition = position + node.data.length;
    const start = Math.max(0, item.startOffset - position);
    const end = Math.min(node.data.length, item.endOffset - position);
    if (end > start) segments.push({ node, start, end });
    if (nextPosition >= item.endOffset) break;
    position = nextPosition;
    node = walker.nextNode() as Text | null;
  }

  const color = noteColor(item.note.color);
  segments.reverse().forEach(({ node: textNode, start, end }) => {
    const selected = textNode.splitText(start);
    selected.splitText(end - start);
    const mark = doc.createElement("mark");
    mark.dataset.readtaylorNoteHighlight = "true";
    mark.dataset.noteId = item.note.id;
    mark.dataset.noteColor = color.id;
    selected.parentNode?.replaceChild(mark, selected);
    mark.appendChild(selected);
  });
}

function applyNoteHighlights(doc: Document, root: Node, notes: ReadingNote[]): ActiveNoteRange[] {
  clearNoteHighlightMarks(root);
  const activeRanges = notes
    .map((note) => resolveNoteRange(root, note))
    .filter((item): item is ActiveNoteRange => item != null);

  const highlightCss = doc.defaultView?.CSS as typeof CSS & {
    highlights?: { delete: (name: string) => void; set: (name: string, value: unknown) => void };
  };
  const HighlightConstructor = (doc.defaultView as Window & {
    Highlight?: new (...ranges: Range[]) => unknown;
  } | null)?.Highlight;
  let style = doc.getElementById("readtaylor-note-highlights") as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = "readtaylor-note-highlights";
    doc.head.appendChild(style);
  }
  style.textContent = NOTE_COLORS.map((color) => `
    ::highlight(readtaylor-note-${color.id}) {
      text-decoration: underline;
      text-decoration-color: ${color.hex};
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
    }
    mark[data-readtaylor-note-highlight][data-note-color="${color.id}"] {
      background: ${color.fill};
      box-shadow: inset 0 -2px 0 ${color.hex};
    }
  `).join("\n");

  style.textContent += `
    mark[data-readtaylor-note-highlight] {
      margin: 0;
      padding: 0;
      border-radius: 2px;
      color: inherit;
      font: inherit;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
  `;

  NOTE_COLORS.forEach((color) => {
    const name = `readtaylor-note-${color.id}`;
    highlightCss.highlights?.delete(name);
    if (!highlightCss?.highlights || !HighlightConstructor) return;
    const ranges = activeRanges
      .filter((item) => noteColor(item.note.color).id === color.id)
      .map((item) => rangeFromOffsets(root, item.startOffset, item.endOffset))
      .filter((range): range is Range => range != null);
    if (ranges.length) highlightCss.highlights?.set(name, new HighlightConstructor(...ranges));
  });
  // 同时插入轻量 mark，确保不支持或没有正确绘制 CSS Highlights 的浏览器也能看见标记。
  [...activeRanges]
    .sort((a, b) => b.startOffset - a.startOffset)
    .forEach((item) => wrapNoteRange(doc, root, item));
  return activeRanges;
}

function textOffsetAtPoint(doc: Document, root: Node, x: number, y: number): number | null {
  const legacyRange = (doc as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
  }).caretRangeFromPoint?.(x, y);
  const caretPosition = (doc as Document & {
    caretPositionFromPoint?: (clientX: number, clientY: number) => { offsetNode: Node; offset: number } | null;
  }).caretPositionFromPoint?.(x, y);
  const node = legacyRange?.startContainer || caretPosition?.offsetNode;
  const offset = legacyRange?.startOffset ?? caretPosition?.offset;
  if (!node || offset == null || !root.contains(node)) return null;
  const before = doc.createRange();
  before.selectNodeContents(root);
  before.setEnd(node, offset);
  return before.toString().length;
}

function clampProgress(value: number): number {
  return Math.min(Math.max(value || 0, 0), 1);
}

function createSpeechChunks(text: string, progress: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const approximateOffset = Math.floor(normalized.length * clampProgress(progress));
  let remaining = normalized.slice(approximateOffset);
  if (approximateOffset > 0) {
    const nextSentence = remaining.search(/[。！？!?；;]/);
    if (nextSentence >= 0 && nextSentence < 160) remaining = remaining.slice(nextSentence + 1).trim();
  }
  if (!remaining) remaining = normalized;

  const sentences = remaining.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [remaining];
  const chunks: string[] = [];
  sentences.forEach((sentence) => {
    let rest = sentence.trim();
    while (rest.length > 180) {
      const candidates = [rest.lastIndexOf("，", 180), rest.lastIndexOf(",", 180), rest.lastIndexOf(" ", 180)];
      const splitAt = Math.max(...candidates, 100);
      chunks.push(rest.slice(0, splitAt + 1).trim());
      rest = rest.slice(splitAt + 1).trim();
    }
    if (rest) chunks.push(rest);
  });
  return chunks;
}

function usesTouchSelection(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") return window.matchMedia("(pointer: coarse)").matches;
  return navigator.maxTouchPoints > 0;
}

function intersectsViewport(rect: DOMRect, viewport: DOMRect): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.right > viewport.left
    && rect.left < viewport.right
    && rect.bottom > viewport.top
    && rect.top < viewport.bottom;
}

function visibleTextFromRoot(doc: Document, root: Node, viewport: DOMRect, maxLength = 6000): string {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, button, [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const pieces: string[] = [];
  let length = 0;
  let node = walker.nextNode() as Text | null;

  while (node && length < maxLength) {
    const value = node.data;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    const visibleRects = rects.filter((rect) => intersectsViewport(rect, viewport));
    let visible = "";

    if (visibleRects.length === rects.length && rects.length > 0) {
      visible = value;
    } else if (visibleRects.length > 0) {
      // 只在跨页的边界文本上逐字判断，避免把下一页的半段文字带入译文。
      for (let index = 0; index < value.length && length + visible.length < maxLength; index += 1) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        if (Array.from(range.getClientRects()).some((rect) => intersectsViewport(rect, viewport))) {
          visible += value[index];
        }
      }
    }

    const normalized = visible.replace(/\s+/g, " ").trim();
    if (normalized) {
      pieces.push(normalized);
      length += normalized.length + 1;
    }
    node = walker.nextNode() as Text | null;
  }
  return pieces.join("\n").slice(0, maxLength).trim();
}

export function ReaderView({ book, onBack, onPositionChange, isDark, onToggleDark }: ReaderViewProps) {
  const initialChapterIndex = Math.min(book.lastChapter || 0, book.chapters.length - 1);
  const initialProgress = clampProgress(book.lastScroll || 0);
  const isFidelity = book.mode === "fidelity";
  const fixedLayout = isFidelity && book.layout === "fixed";
  const [chapterIndex, setChapterIndex] = useState(initialChapterIndex);
  const [chapterPageIndex, setChapterPageIndex] = useState(0);
  const [chapterPageCounts, setChapterPageCounts] = useState<Array<number | null>>(() => (
    fixedLayout ? book.chapters.map(() => 1) : book.chapters.map(() => null)
  ));
  // 等阅读区拿到准确尺寸后再决定读取缓存还是重新测量。
  const [measurementIndex, setMeasurementIndex] = useState(-1);
  const [measurementSrcdoc, setMeasurementSrcdoc] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [fontSize, setFontSize] = useState(() => loadBookFontSize(book.id, isFidelity ? 16 : 18));
  const [showChapters, setShowChapters] = useState(false);
  const [selectionTarget, setSelectionTarget] = useState<SelectionTarget | null>(null);
  const [noteComposer, setNoteComposer] = useState<NoteComposer | null>(null);
  const [notes, setNotes] = useState<ReadingNote[]>(() => loadNotes(book.id));
  const [showNotes, setShowNotes] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState("");
  const [scrollProgress, setScrollProgress] = useState(initialProgress);
  const [showSpeechControls, setShowSpeechControls] = useState(false);
  const [speechRate, setSpeechRate] = useState(loadSpeechRate);
  const [speechStatus, setSpeechStatus] = useState<"idle" | "playing" | "paused">("idle");
  const [speechMessage, setSpeechMessage] = useState("");
  const [translationLanguage, setTranslationLanguage] = useState(loadTranslationLanguage);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationText, setTranslationText] = useState("");
  const [translationError, setTranslationError] = useState("");
  const [translationDetectedLanguage, setTranslationDetectedLanguage] = useState("");
  const [desktopWorkspace, setDesktopWorkspace] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [studySections, setStudySections] = useState({ notes: true, translation: false });
  const contentRef = useRef<HTMLDivElement>(null);
  const restorePositionRef = useRef({
    chapterIndex: initialChapterIndex,
    progress: initialProgress,
  });
  const pendingPageRef = useRef<PendingPage>({
    chapterIndex: initialChapterIndex,
    mode: "progress",
    progress: initialProgress,
  });
  const paginationPositionRef = useRef({
    chapterIndex: initialChapterIndex,
    pageIndex: 0,
    pageCount: 1,
  });
  const latestReadingPositionRef = useRef({
    chapterIndex: initialChapterIndex,
    progress: initialProgress,
  });
  const persistedReadingPositionRef = useRef({
    chapterIndex: initialChapterIndex,
    progress: initialProgress,
  });
  const positionSaveTimerRef = useRef<number | undefined>(undefined);
  const onPositionChangeRef = useRef(onPositionChange);
  const [srcdoc, setSrcdoc] = useState("");
  const [srcdocRevision, setSrcdocRevision] = useState(0);
  const [rendering, setRendering] = useState(isFidelity);
  const [renderError, setRenderError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const measurementIframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const paginationViewportRef = useRef({ width: 0, height: 0 });
  const fontSizeRef = useRef(fontSize);
  const previousFidelityFontSizeRef = useRef(fontSize);
  const activeNoteRangesRef = useRef<ActiveNoteRange[]>([]);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const speechQueueRef = useRef<string[]>([]);
  const speechIndexRef = useRef(0);
  const speechSessionRef = useRef(0);
  const speechRateRef = useRef(speechRate);
  const mobileSelectionTimerRef = useRef<number | undefined>(undefined);
  const translationRequestRef = useRef<AbortController | null>(null);
  const translationSourceRef = useRef<VisibleTranslationSource | null>(null);
  fontSizeRef.current = fontSize;
  speechRateRef.current = speechRate;
  onPositionChangeRef.current = onPositionChange;

  const chapter = book.chapters[chapterIndex];

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setDesktopWorkspace(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // 原版模式：渲染当前章节的原 HTML
  useEffect(() => {
    if (!isFidelity) return;
    let cancelled = false;
    setRendering(true);
    setRenderError("");
    renderChapter(book, chapterIndex)
      .then((html) => {
        if (!cancelled) {
          setSrcdoc(html);
          // Chromium 偶尔只更新 srcdoc 属性却不重载内容，改变 key 可确保章节真正切换。
          setSrcdocRevision((revision) => revision + 1);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setRenderError(String(e?.message || e));
          setRendering(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isFidelity, book, chapterIndex, layoutRevision]);

  // 在不可见但与阅读区同尺寸的 iframe 中逐章排版，得到真实的全书总页数。
  useEffect(() => {
    if (!isFidelity || fixedLayout || measurementIndex < 0) return;
    let cancelled = false;
    setMeasurementSrcdoc("");
    renderChapter(book, measurementIndex)
      .then((html) => !cancelled && setMeasurementSrcdoc(html))
      .catch(() => {
        if (!cancelled) {
          setChapterPageCounts((previous) => {
            const next = [...previous];
            next[measurementIndex] = 1;
            return next;
          });
          setMeasurementIndex((index) => (
            index + 1 < book.chapters.length ? index + 1 : -1
          ));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isFidelity, fixedLayout, measurementIndex, book, layoutRevision]);

  const onMeasurementLoad = async () => {
    const frame = measurementIframeRef.current;
    const measuredChapter = measurementIndex;
    if (!frame || measuredChapter < 0) return;
    const measuredChapterInfo = book.chapters[measuredChapter];
    const { pageCount } = await paginateFrame(
      frame,
      false,
      fontSize,
      Boolean(measuredChapterInfo?.isCover) || measuredChapter === 0
    );
    if (measuredChapter !== measurementIndex) return;
    setChapterPageCounts((previous) => {
      const next = [...previous];
      next[measuredChapter] = pageCount;
      return next;
    });
    setMeasurementIndex(
      measuredChapter + 1 < book.chapters.length ? measuredChapter + 1 : -1
    );
  };

  // 一整本书在当前阅读区尺寸下测量完成后，保存页数供下次直接使用。
  useEffect(() => {
    if (!isFidelity || fixedLayout) return;
    if (!chapterPageCounts.every((count): count is number => count != null && count > 0)) return;
    const { width, height } = paginationViewportRef.current;
    savePaginationCache(book, width, height, fontSize, chapterPageCounts);
  }, [isFidelity, fixedLayout, book, fontSize, chapterPageCounts]);

  // 首次进入优先读取相同尺寸的分页缓存；只有未命中或尺寸变化时才重新计算。
  useEffect(() => {
    if (!isFidelity || !viewportRef.current) return;
    let previousSize = "";
    let resizeTimer = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const nextSize = `${width}x${height}`;
      if (!width || !height || nextSize === previousSize) return;
      paginationViewportRef.current = { width, height };
      if (!previousSize) {
        previousSize = nextSize;
        if (fixedLayout) return;
        const cached = loadPaginationCache(book, width, height, fontSizeRef.current);
        setChapterPageCounts(cached || book.chapters.map(() => null));
        setMeasurementIndex(cached ? -1 : 0);
        return;
      }
      previousSize = nextSize;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const cached = fixedLayout ? null : loadPaginationCache(book, width, height, fontSizeRef.current);
        const position = paginationPositionRef.current;
        pendingPageRef.current = {
          chapterIndex: position.chapterIndex,
          mode: "progress",
          progress: position.pageCount > 1
            ? position.pageIndex / (position.pageCount - 1)
            : 0,
        };
        setChapterPageIndex(0);
        setChapterPageCounts(fixedLayout
          ? book.chapters.map(() => 1)
          : cached || book.chapters.map(() => null)
        );
        setMeasurementIndex(fixedLayout || cached ? -1 : 0);
        setMeasurementSrcdoc("");
        setLayoutRevision((value) => value + 1);
      }, 180);
    });
    observer.observe(viewportRef.current);
    return () => {
      observer.disconnect();
      window.clearTimeout(resizeTimer);
    };
  }, [isFidelity, fixedLayout, book.id, book.chapters.length]);

  useEffect(() => {
    saveBookFontSize(book.id, fontSize);
  }, [book.id, fontSize]);

  // 原版文字书调整字号后重新排版；相同字号与窗口尺寸优先读取已有缓存。
  useEffect(() => {
    if (!isFidelity || fixedLayout) return;
    if (previousFidelityFontSizeRef.current === fontSize) return;
    previousFidelityFontSizeRef.current = fontSize;
    const { width, height } = paginationViewportRef.current;
    if (!width || !height) return;

    const position = paginationPositionRef.current;
    pendingPageRef.current = {
      chapterIndex: position.chapterIndex,
      mode: "progress",
      progress: position.pageCount > 1
        ? position.pageIndex / (position.pageCount - 1)
        : 0,
    };
    const cached = loadPaginationCache(book, width, height, fontSize);
    setChapterPageIndex(0);
    setChapterPageCounts(cached || book.chapters.map(() => null));
    setMeasurementIndex(cached ? -1 : 0);
    setMeasurementSrcdoc("");
    setLayoutRevision((revision) => revision + 1);
  }, [isFidelity, fixedLayout, book, fontSize]);

  // 离开阅读器时回收 EPUB 的 blob URL
  useEffect(() => () => cleanupEpub(), []);

  useEffect(() => () => window.clearTimeout(feedbackTimerRef.current), []);

  useEffect(() => () => {
    window.clearTimeout(mobileSelectionTimerRef.current);
    translationRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    setSelectionTarget(null);
    setTranslationVisible(false);
    setTranslationError("");
    translationRequestRef.current?.abort();
  }, [chapterIndex, chapterPageIndex]);

  const flashNoteFeedback = (message: string) => {
    setNoteFeedback(message);
    window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setNoteFeedback(""), 2200);
  };

  const openNoteComposerForSelection = (selected: SelectionTarget) => {
    setNoteComposer({
      quote: selected.text,
      body: "",
      chapterId: selected.chapterId,
      chapterTitle: selected.chapterTitle,
      pageIndex: selected.pageIndex,
      color: "yellow",
      startOffset: selected.startOffset,
      endOffset: selected.endOffset,
    });
    if (selected.source === "iframe") iframeRef.current?.contentWindow?.getSelection()?.removeAllRanges();
    else window.getSelection()?.removeAllRanges();
    setSelectionTarget(null);
  };

  const captureSelection = (
    selection: Selection | null,
    source: SelectionTarget["source"],
    root: Node | null,
    offsetLeft = 0,
    offsetTop = 0
  ) => {
    const text = selection?.toString().trim() || "";
    if (!selection || selection.rangeCount === 0 || !text) {
      setSelectionTarget((current) => current?.source === source ? null : current);
      return false;
    }

    if (!root) return false;
    const commonAncestor = selection.getRangeAt(0).commonAncestorContainer;
    if (!root.contains(commonAncestor)) return false;

    const range = selection.getRangeAt(0);
    const rangeRect = range.getBoundingClientRect();
    const firstRect = range.getClientRects()[0];
    const rect = rangeRect.width || rangeRect.height ? rangeRect : firstRect;
    if (!rect) return false;

    const left = offsetLeft + rect.left;
    const top = offsetTop + rect.top;
    const right = offsetLeft + rect.right;
    const bottom = offsetTop + rect.bottom;
    const x = Math.min(Math.max((left + right) / 2, 68), window.innerWidth - 68);
    const y = bottom + 58 < window.innerHeight ? bottom + 10 : Math.max(10, top - 50);
    const { startOffset, endOffset } = getRangeOffsets(root, range, text);

    const selected: SelectionTarget = {
      text: text.slice(0, 5000),
      x,
      y,
      source,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      pageIndex: isFidelity ? chapterPageIndex : undefined,
      startOffset,
      endOffset,
    };
    if (usesTouchSelection()) openNoteComposerForSelection(selected);
    else setSelectionTarget(selected);
    return true;
  };

  const captureReaderSelection = () => {
    window.requestAnimationFrame(() => captureSelection(
      window.getSelection(),
      "reader",
      contentRef.current
    ));
  };

  const scheduleReaderSelection = () => {
    window.clearTimeout(mobileSelectionTimerRef.current);
    mobileSelectionTimerRef.current = window.setTimeout(captureReaderSelection, 320);
  };

  useEffect(() => {
    if (isFidelity || !usesTouchSelection()) return;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) scheduleReaderSelection();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [isFidelity, chapterIndex]);

  const startNoteFromSelection = () => {
    if (!selectionTarget) return;
    openNoteComposerForSelection(selectionTarget);
  };

  const editNote = (note: ReadingNote) => {
    setShowNotes(false);
    setNoteComposer({
      id: note.id,
      quote: note.quote,
      body: note.body,
      chapterId: note.chapterId,
      chapterTitle: note.chapterTitle,
      pageIndex: note.pageIndex,
      createdAt: note.createdAt,
      color: note.color || "yellow",
      startOffset: note.startOffset,
      endOffset: note.endOffset,
    });
  };

  const commitNote = () => {
    if (!noteComposer) return;
    const now = Date.now();
    const nextNote: ReadingNote = {
      id: noteComposer.id || `${now}-${Math.random().toString(36).slice(2, 9)}`,
      bookId: book.id,
      chapterId: noteComposer.chapterId,
      chapterTitle: noteComposer.chapterTitle,
      quote: noteComposer.quote,
      body: noteComposer.body.trim(),
      color: noteComposer.color,
      startOffset: noteComposer.startOffset,
      endOffset: noteComposer.endOffset,
      pageIndex: noteComposer.pageIndex,
      createdAt: noteComposer.createdAt || now,
      updatedAt: now,
    };
    const nextNotes = noteComposer.id
      ? notes.map((note) => note.id === noteComposer.id ? nextNote : note)
      : [nextNote, ...notes];
    nextNotes.sort((a, b) => b.updatedAt - a.updatedAt);
    if (!saveNotes(book.id, nextNotes)) {
      flashNoteFeedback("本地空间不足，笔记未能保存");
      return;
    }
    setNotes(nextNotes);
    setNoteComposer(null);
    flashNoteFeedback(noteComposer.id ? "笔记已更新" : "笔记已保存");
  };

  const removeNote = (note: ReadingNote) => {
    if (!window.confirm("删除这条笔记？")) return;
    const nextNotes = notes.filter((item) => item.id !== note.id);
    if (!saveNotes(book.id, nextNotes)) {
      flashNoteFeedback("删除失败，请稍后再试");
      return;
    }
    setNotes(nextNotes);
    flashNoteFeedback("笔记已删除");
  };

  const refreshNoteHighlights = () => {
    const chapterNotes = notes.filter((note) => note.chapterId === chapter.id);
    if (isFidelity) {
      const doc = iframeRef.current?.contentDocument;
      if (!doc?.body) return;
      activeNoteRangesRef.current = applyNoteHighlights(doc, doc.body, chapterNotes);
    } else if (contentRef.current) {
      activeNoteRangesRef.current = applyNoteHighlights(document, contentRef.current, chapterNotes);
    }
  };

  const noteAtPoint = (doc: Document, root: Node, x: number, y: number): ReadingNote | null => {
    const offset = textOffsetAtPoint(doc, root, x, y);
    if (offset == null) return null;
    return activeNoteRangesRef.current.find((item) => (
      offset >= item.startOffset && offset <= item.endOffset
    ))?.note || null;
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(refreshNoteHighlights);
    return () => window.cancelAnimationFrame(frame);
  }, [notes, chapterIndex, isFidelity, srcdoc, rendering]);

  const onIframeLoad = async () => {
    const frame = iframeRef.current;
    const cdoc = frame?.contentDocument;
    const cwin = frame?.contentWindow;
    if (!cdoc || !cwin) return;
    const { pageCount } = await paginateFrame(
      frame,
      fixedLayout,
      fontSize,
      Boolean(chapter.isCover) || chapterIndex === 0
    );
    setChapterPageCounts((previous) => {
      const next = [...previous];
      next[chapterIndex] = pageCount;
      return next;
    });

    const pending = pendingPageRef.current;
    let targetPage = Math.min(chapterPageIndex, pageCount - 1);
    if (pending.chapterIndex === chapterIndex) {
      if (pending.mode === "last") targetPage = pageCount - 1;
      else if (pending.mode === "first") targetPage = 0;
      else if (pending.mode === "progress") {
        targetPage = Math.round((pageCount - 1) * pending.progress);
      }
      pendingPageRef.current = { chapterIndex: -1, mode: "first" };
    }
    setChapterPageIndex(targetPage);
    scrollFrameToPage(frame, targetPage);
    setRendering(false);

    const captureIframeSelection = () => {
      window.requestAnimationFrame(() => {
        const frameRect = frame.getBoundingClientRect();
        captureSelection(cwin.getSelection(), "iframe", cdoc.body, frameRect.left, frameRect.top);
      });
    };
    const scheduleIframeSelection = () => {
      window.clearTimeout(mobileSelectionTimerRef.current);
      mobileSelectionTimerRef.current = window.setTimeout(captureIframeSelection, 320);
    };
    cdoc.addEventListener("mouseup", captureIframeSelection);
    cdoc.addEventListener("touchend", scheduleIframeSelection);
    cdoc.addEventListener("keyup", captureIframeSelection);
    cdoc.addEventListener("contextmenu", (event) => {
      if (!usesTouchSelection() || !cwin.getSelection()?.toString().trim()) return;
      event.preventDefault();
      scheduleIframeSelection();
    });
    cdoc.addEventListener("selectionchange", () => {
      const selection = cwin.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionTarget((current) => current?.source === "iframe" ? null : current);
      } else if (usesTouchSelection()) {
        scheduleIframeSelection();
      }
    });

    cdoc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement)?.closest?.("a");
      if (a) {
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        const idx = resolveInternalIndex(book, chapterIndex, href);
        if (idx != null) {
          if (idx === chapterIndex) {
            setChapterPageIndex(0);
            scrollFrameToPage(frame, 0);
          } else {
            pendingPageRef.current = { chapterIndex: idx, mode: "first" };
            setChapterPageIndex(0);
            setChapterIndex(idx);
          }
        }
        else if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener");
        return;
      }
      if (cwin.getSelection()?.toString().trim()) {
        return;
      }
      const noteId = (e.target as HTMLElement)?.closest?.("mark[data-readtaylor-note-highlight]")?.getAttribute("data-note-id");
      const markedNote = notes.find((note) => note.id === noteId);
      if (markedNote) {
        editNote(markedNote);
        return;
      }
      const highlightedNote = noteAtPoint(cdoc, cdoc.body, e.clientX, e.clientY);
      if (highlightedNote) {
        editNote(highlightedNote);
        return;
      }
    });
    refreshNoteHighlights();
  };

  useEffect(() => {
    if (isFidelity) scrollFrameToPage(iframeRef.current, chapterPageIndex);
  }, [isFidelity, chapterPageIndex]);

  const currentChapterPageCount = chapterPageCounts[chapterIndex] || 1;
  paginationPositionRef.current = {
    chapterIndex,
    pageIndex: chapterPageIndex,
    pageCount: currentChapterPageCount,
  };
  latestReadingPositionRef.current = {
    chapterIndex,
    progress: isFidelity
      ? currentChapterPageCount > 1
        ? chapterPageIndex / (currentChapterPageCount - 1)
        : 0
      : scrollProgress,
  };

  const flushReadingPosition = () => {
    window.clearTimeout(positionSaveTimerRef.current);
    const current = latestReadingPositionRef.current;
    const persisted = persistedReadingPositionRef.current;
    if (
      current.chapterIndex === persisted.chapterIndex
      && Math.abs(current.progress - persisted.progress) < 0.0001
    ) return;
    persistedReadingPositionRef.current = current;
    onPositionChangeRef.current(current.chapterIndex, current.progress);
  };

  // 翻页或滚动后自动保存；短暂延迟可以避免连续滚动时频繁写入本地存储。
  useEffect(() => {
    if (isFidelity && rendering) return;
    window.clearTimeout(positionSaveTimerRef.current);
    positionSaveTimerRef.current = window.setTimeout(flushReadingPosition, 300);
    return () => window.clearTimeout(positionSaveTimerRef.current);
  }, [chapterIndex, chapterPageIndex, currentChapterPageCount, scrollProgress, isFidelity, rendering]);

  // pagehide 兼容关闭标签页、刷新、手机浏览器切后台等离开方式。
  useEffect(() => {
    const handlePageHide = () => flushReadingPosition();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushReadingPosition();
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushReadingPosition();
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
  const pagesBeforeAreReady = chapterPageCounts
    .slice(0, chapterIndex)
    .every((count) => count != null);
  const currentGlobalPage = pagesBeforeAreReady
    ? chapterPageCounts.slice(0, chapterIndex).reduce<number>(
      (sum, count) => sum + (count || 0),
      0
    )
      + chapterPageIndex
      + 1
    : null;
  const totalPagesReady = chapterPageCounts.every((count) => count != null);
  const totalPages = totalPagesReady
    ? chapterPageCounts.reduce<number>((sum, count) => sum + (count || 0), 0)
    : null;
  const pageLabel = currentGlobalPage != null && totalPages != null
    ? `${currentGlobalPage} / ${totalPages}`
    : currentGlobalPage != null
      ? `${currentGlobalPage} / 计算中…`
      : "正在计算全书页码…";
  const fidelityProgress = currentGlobalPage != null && totalPages != null
    ? totalPages > 1 ? (currentGlobalPage - 1) / (totalPages - 1) : 1
    : (chapterIndex + chapterPageIndex / currentChapterPageCount) / book.chapters.length;
  const overallProgress = isFidelity
    ? fidelityProgress
    : Math.min(1, (chapterIndex + scrollProgress) / Math.max(1, book.chapters.length));
  const currentPageNotes = notes.filter((note) => (
    note.chapterId === chapter.id
    && (!isFidelity || note.pageIndex == null || note.pageIndex === chapterPageIndex)
  ));

  const currentPageTranslationSource = (): VisibleTranslationSource => {
    if (isFidelity) {
      const frame = iframeRef.current;
      const doc = frame?.contentDocument;
      if (!frame || !doc?.body) return { text: "", pageKey: `${chapterIndex}:${chapterPageIndex}` };
      const viewport = new DOMRect(0, 0, frame.clientWidth, frame.clientHeight);
      return {
        text: visibleTextFromRoot(doc, doc.body, viewport),
        pageKey: `${chapterIndex}:${chapterPageIndex}`,
      };
    }
    const content = contentRef.current;
    if (!content) return { text: "", pageKey: `${chapterIndex}:0` };
    return {
      text: visibleTextFromRoot(document, content, content.getBoundingClientRect()),
      pageKey: `${chapterIndex}:${Math.round(scrollProgress * 1000)}`,
    };
  };

  const translateSource = async (source: VisibleTranslationSource, targetLanguage: string) => {
    translationRequestRef.current?.abort();
    translationSourceRef.current = source;
    setTranslationVisible(true);
    setTranslationError("");
    setTranslationDetectedLanguage("");

    if (!source.text) {
      setTranslationText("");
      setTranslationLoading(false);
      setTranslationError("当前页面没有可翻译的文字");
      return;
    }

    const cached = loadCachedTranslation(book.id, chapter.id, source.pageKey, source.text, targetLanguage);
    if (cached) {
      setTranslationText(cached.text);
      setTranslationDetectedLanguage(cached.detectedLanguage || "");
      setTranslationLoading(false);
      return;
    }

    const controller = new AbortController();
    translationRequestRef.current = controller;
    setTranslationText("");
    setTranslationLoading(true);
    try {
      const result = await requestTranslation(source.text, targetLanguage, controller.signal);
      if (translationRequestRef.current !== controller) return;
      saveCachedTranslation(book.id, chapter.id, source.pageKey, source.text, result);
      setTranslationText(result.text);
      setTranslationDetectedLanguage(result.detectedLanguage || "");
    } catch (error) {
      if (controller.signal.aborted) return;
      setTranslationError(error instanceof Error ? error.message : "翻译失败，请稍后重试");
    } finally {
      if (translationRequestRef.current === controller) {
        translationRequestRef.current = null;
        setTranslationLoading(false);
      }
    }
  };

  const toggleCurrentPageTranslation = () => {
    if (desktopWorkspace) {
      setRightSidebarOpen(true);
      setStudySections((sections) => ({ ...sections, translation: true }));
      if (!translationVisible) void translateSource(currentPageTranslationSource(), translationLanguage);
      return;
    }
    if (translationVisible) {
      translationRequestRef.current?.abort();
      setTranslationVisible(false);
      return;
    }
    void translateSource(currentPageTranslationSource(), translationLanguage);
  };

  const changeTranslationLanguage = (language: string) => {
    setTranslationLanguage(language);
    saveTranslationLanguage(language);
    const source = translationSourceRef.current;
    if (translationVisible && source) void translateSource(source, language);
  };

  const openChapterNavigation = () => {
    if (desktopWorkspace) setLeftSidebarOpen(true);
    else setShowChapters(true);
  };

  const openNotesWorkspace = () => {
    if (desktopWorkspace) {
      setRightSidebarOpen(true);
      setStudySections((sections) => ({ ...sections, notes: true }));
    } else {
      setShowNotes(true);
    }
  };

  const toggleStudySection = (section: keyof typeof studySections) => {
    const opening = !studySections[section];
    setStudySections((sections) => ({ ...sections, [section]: !sections[section] }));
    if (section === "translation" && opening && !translationVisible) {
      void translateSource(currentPageTranslationSource(), translationLanguage);
    }
  };

  const translationOverlay = translationVisible && !desktopWorkspace && (
    <div
      className="absolute inset-0 z-20 flex flex-col"
      style={{ background: "var(--background)", color: "var(--foreground)" }}
      aria-label="当前页译文"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-3"
        style={{ padding: "12px clamp(16px, 4vw, 28px)", borderBottom: "1px solid var(--border)", background: "var(--card)" }}
      >
        <div className="min-w-0">
          <div style={{ fontFamily: "Lora, serif", fontSize: "15px", fontWeight: 600 }}>当前页译文</div>
          <div className="truncate" style={{ marginTop: "2px", fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--muted-foreground)" }}>
            {translationDetectedLanguage ? `已识别原文语言：${translationDetectedLanguage}` : "只翻译当前可见页面"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            aria-label="选择翻译语言"
            value={translationLanguage}
            onChange={(event) => changeTranslationLanguage(event.target.value)}
            className="h-9 rounded-lg px-2"
            style={{ border: "1px solid var(--border)", background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "12px" }}
          >
            {TRANSLATION_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
          <button
            onClick={() => setTranslationVisible(false)}
            aria-label="关闭译文，查看原文"
            className="w-9 h-9 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: "clamp(24px, 6vw, 64px) clamp(20px, 8vw, 110px)", scrollbarWidth: "none" }}
      >
        {translationLoading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: "var(--muted-foreground)" }}>
            <LoaderCircle className="animate-spin" size={24} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px" }}>正在翻译当前页…</span>
          </div>
        ) : translationError ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p style={{ maxWidth: "420px", fontFamily: "Inter, sans-serif", fontSize: "13px", lineHeight: 1.7, color: "var(--muted-foreground)" }}>
              {translationError}
            </p>
            <button
              onClick={() => translationSourceRef.current && void translateSource(translationSourceRef.current, translationLanguage)}
              className="mt-4 h-10 rounded-xl px-5"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px" }}
            >
              重试
            </button>
          </div>
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "Lora, serif", fontSize: `${fontSize}px`, lineHeight: 1.9, textAlign: "justify" }}>
            {translationText}
          </p>
        )}
      </div>
    </div>
  );

  const speechSupported = typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof SpeechSynthesisUtterance !== "undefined";

  const stopSpeech = (message = "") => {
    speechSessionRef.current += 1;
    if (speechSupported) window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    speechIndexRef.current = 0;
    setSpeechStatus("idle");
    setSpeechMessage(message);
  };

  const speakNextChunk = (session: number) => {
    if (!speechSupported || session !== speechSessionRef.current) return;
    const text = speechQueueRef.current[speechIndexRef.current];
    if (!text) {
      speechQueueRef.current = [];
      setSpeechStatus("idle");
      setSpeechMessage("本章朗读完成");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speechRateRef.current;
    utterance.lang = /[\u3400-\u9fff]/.test(text) ? "zh-CN" : "en-US";
    utterance.onend = () => {
      if (session !== speechSessionRef.current) return;
      speechIndexRef.current += 1;
      speakNextChunk(session);
    };
    utterance.onerror = (event) => {
      if (session !== speechSessionRef.current || event.error === "canceled" || event.error === "interrupted") return;
      stopSpeech("朗读暂时不可用，请稍后重试");
    };
    window.speechSynthesis.speak(utterance);
  };

  const startSpeech = () => {
    if (!speechSupported) {
      setSpeechMessage("当前浏览器不支持朗读，请使用最新版 Chrome 或桌面版");
      return;
    }
    const progress = isFidelity
      ? chapterPageIndex / Math.max(1, currentChapterPageCount)
      : scrollProgress;
    const readableText = isFidelity
      ? iframeRef.current?.contentDocument?.body?.innerText || ""
      : chapter.content;
    const chunks = createSpeechChunks(readableText, progress);
    if (!chunks.length) {
      setSpeechMessage("当前章节没有可朗读的文字");
      return;
    }

    speechSessionRef.current += 1;
    window.speechSynthesis.cancel();
    speechQueueRef.current = chunks;
    speechIndexRef.current = 0;
    setSpeechMessage("从当前阅读位置开始朗读");
    setSpeechStatus("playing");
    speakNextChunk(speechSessionRef.current);
    setShowSpeechControls(false);
  };

  const toggleSpeech = () => {
    if (speechStatus === "playing") {
      window.speechSynthesis.pause();
      setSpeechStatus("paused");
      setSpeechMessage("已暂停");
    } else if (speechStatus === "paused") {
      window.speechSynthesis.resume();
      setSpeechStatus("playing");
      setSpeechMessage("继续朗读");
      setShowSpeechControls(false);
    } else {
      startSpeech();
    }
  };

  const changeSpeechRate = (change: number) => {
    setSpeechRate((rate) => {
      const next = Math.round(Math.min(2, Math.max(0.5, rate + change)) * 100) / 100;
      saveSpeechRate(next);
      return next;
    });
    if (speechStatus !== "idle") setSpeechMessage("新语速将在下一句生效");
  };

  useEffect(() => {
    if (isFidelity) setScrollProgress(fidelityProgress);
  }, [isFidelity, fidelityProgress]);

  useEffect(() => {
    speechSessionRef.current += 1;
    if (speechSupported) window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    speechIndexRef.current = 0;
    setSpeechStatus("idle");
    setSpeechMessage("");
  }, [chapterIndex]);

  useEffect(() => () => {
    speechSessionRef.current += 1;
    if (speechSupported) window.speechSynthesis.cancel();
  }, []);

  const goToChapter = (targetChapter: number, targetPage: "first" | "last" = "first") => {
    const safeChapter = Math.min(Math.max(targetChapter, 0), book.chapters.length - 1);
    if (safeChapter === chapterIndex) {
      const nextPage = targetPage === "last" ? currentChapterPageCount - 1 : 0;
      setChapterPageIndex(nextPage);
      return;
    }
    pendingPageRef.current = { chapterIndex: safeChapter, mode: targetPage };
    setChapterPageIndex(0);
    setChapterIndex(safeChapter);
  };

  const goToPreviousPage = () => {
    if (rendering) return;
    if (chapterPageIndex > 0) setChapterPageIndex((page) => page - 1);
    else if (chapterIndex > 0) goToChapter(chapterIndex - 1, "last");
  };

  const goToNextPage = () => {
    if (rendering) return;
    if (chapterPageIndex + 1 < currentChapterPageCount) {
      setChapterPageIndex((page) => page + 1);
    } else if (chapterIndex + 1 < book.chapters.length) {
      goToChapter(chapterIndex + 1, "first");
    }
  };

  useEffect(() => {
    if (!isFidelity) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input,textarea,select,[contenteditable='true']")) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goToPreviousPage();
      } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        goToNextPage();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setScrollProgress(scrollTop / (scrollHeight - clientHeight) || 0);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [chapterIndex]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const saved = restorePositionRef.current;
    const progress = saved.chapterIndex === chapterIndex ? saved.progress : 0;
    restorePositionRef.current = { chapterIndex: -1, progress: 0 };
    window.requestAnimationFrame(() => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight) * progress;
      setScrollProgress(progress);
    });
  }, [chapterIndex]);

  return (
    <div
      className={`reader-workspace relative h-screen overflow-hidden${leftSidebarOpen ? "" : " reader-workspace-left-collapsed"}${rightSidebarOpen ? "" : " reader-workspace-right-collapsed"}`}
      style={{
        background: isDark ? "var(--background)" : "#faf6ef",
        height: "100dvh",
        minHeight: "100svh",
      }}
    >
      <aside
        aria-label="阅读目录与进度"
        className={`reader-desktop-sidebar reader-left-sidebar${leftSidebarOpen ? "" : " reader-sidebar-collapsed"}`}
      >
        {leftSidebarOpen ? (
          <>
            <div className="reader-sidebar-header">
              <div className="flex min-w-0 items-center gap-2">
                <BookOpenText size={17} />
                <span>目录</span>
              </div>
              <button
                onClick={() => setLeftSidebarOpen(false)}
                aria-label="收起目录侧栏"
                className="reader-sidebar-icon-button"
              >
                <ChevronsLeft size={17} />
              </button>
            </div>
            <nav className="reader-chapter-rail" aria-label="章节目录">
              {book.chapters.map((item, index) => (
                <button
                  key={item.id}
                  onClick={() => goToChapter(index, "first")}
                  aria-current={index === chapterIndex ? "page" : undefined}
                  className={`reader-chapter-link${index === chapterIndex ? " is-current" : ""}`}
                >
                  <span className="reader-chapter-dot" aria-hidden="true" />
                  <span>{item.title}</span>
                </button>
              ))}
            </nav>
            <div className="reader-sidebar-progress">
              <span>阅读进度</span>
              <div className="reader-progress-track" aria-hidden="true">
                <span style={{ width: `${overallProgress * 100}%` }} />
              </div>
              <div className="reader-progress-meta">
                <span>{isFidelity ? pageLabel : `${chapterIndex + 1} / ${book.chapters.length}`}</span>
                <span>{Math.round(overallProgress * 1000) / 10}%</span>
              </div>
            </div>
          </>
        ) : (
          <button
            onClick={() => setLeftSidebarOpen(true)}
            aria-label="展开目录侧栏"
            className="reader-collapsed-rail-button"
          >
            <ChevronRight size={18} />
          </button>
        )}
      </aside>

      <main className="reader-main relative flex min-w-0 flex-col overflow-hidden">
      {/* Progress bar */}
      <div
        className="absolute top-0 left-0 h-0.5 z-20 transition-all duration-200"
        style={{
          width: `${overallProgress * 100}%`,
          background: "var(--accent)",
        }}
      />

      {/* Header */}
      <div
        className="flex items-center justify-between z-10"
        style={{
          borderBottom: "1px solid var(--border)",
          padding: "max(10px, env(safe-area-inset-top)) clamp(12px, 4vw, 20px) 10px",
        }}
      >
        <button
          onClick={() => {
            flushReadingPosition();
            onBack(
              chapterIndex,
              isFidelity
                ? currentChapterPageCount > 1
                  ? chapterPageIndex / (currentChapterPageCount - 1)
                  : 0
                : scrollProgress
            );
          }}
          aria-label="返回书架"
          className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "var(--secondary)" }}
        >
          <ArrowLeft size={18} style={{ color: "var(--foreground)" }} />
        </button>

        <button
          onClick={openChapterNavigation}
          aria-label="打开目录"
          className="flex-1 min-w-0 mx-3 sm:mx-4 text-center truncate"
          style={{ fontFamily: "Inter, sans-serif", color: "var(--muted-foreground)", fontSize: "13px" }}
        >
          {chapter.title}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={toggleCurrentPageTranslation}
            aria-label={desktopWorkspace ? "在学习工作台中翻译当前页" : translationVisible ? "关闭译文，查看原文" : "翻译当前页"}
            aria-pressed={translationVisible}
            className="w-10 h-10 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            {translationLoading ? (
              <LoaderCircle className="animate-spin" size={18} style={{ color: "var(--accent)" }} />
            ) : (
              <Languages size={18} style={{ color: translationVisible ? "var(--accent)" : "var(--muted-foreground)" }} />
            )}
          </button>
          <button
            onClick={() => setShowSpeechControls((show) => !show)}
            aria-label={speechStatus === "idle" ? "打开朗读" : "打开朗读控制"}
            aria-expanded={showSpeechControls}
            className="w-10 h-10 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            <Volume2 size={18} style={{ color: speechStatus === "idle" ? "var(--muted-foreground)" : "var(--accent)" }} />
          </button>
          <button
            onClick={openNotesWorkspace}
            aria-label={`打开笔记${notes.length ? `，共 ${notes.length} 条` : ""}`}
            className="relative w-10 h-10 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            <StickyNote size={18} style={{ color: notes.length ? "var(--accent)" : "var(--muted-foreground)" }} />
            {notes.length > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: "-3px",
                  top: "-5px",
                  minWidth: "17px",
                  height: "17px",
                  padding: "0 4px",
                  borderRadius: "9px",
                  background: "var(--accent)",
                  color: "var(--accent-foreground)",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "10px",
                  lineHeight: "17px",
                }}
              >
                {notes.length > 99 ? "99+" : notes.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 旧版导入的 EPUB（纯文本、无原始文件）提示重新上传 */}
      {!isFidelity && book.fileType === "EPUB" && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--secondary)",
            borderBottom: "1px solid var(--border)",
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--muted-foreground)",
            textAlign: "center",
          }}
        >
          这本书是旧版导入的纯文本。删除后重新上传即可「原版显示」。
        </div>
      )}

      {/* Content — 原版（EPUB iframe）或文本模式 */}
      {isFidelity ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="reader-reading-stage flex-1 overflow-hidden">
          <div
            ref={viewportRef}
            className={`reader-page-frame relative h-full overflow-hidden${fixedLayout ? " reader-page-frame-fixed" : ""}`}
          >
            {renderError ? (
              <div
                className="absolute inset-0 flex items-center justify-center px-8 text-center"
                style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", lineHeight: 1.7, color: "var(--muted-foreground)" }}
              >
                {renderError}
              </div>
            ) : (
              <iframe
                key={`${book.id}-${chapterIndex}-${layoutRevision}-${srcdocRevision}`}
                ref={iframeRef}
                title={chapter.title}
                srcDoc={srcdoc}
                onLoad={onIframeLoad}
                sandbox="allow-same-origin"
                style={{ width: "100%", height: "100%", border: "none", background: "#faf6ef", display: "block" }}
              />
            )}
            {!fixedLayout && measurementIndex >= 0 && measurementSrcdoc && (
              <iframe
                key={`measure-${book.id}-${measurementIndex}-${layoutRevision}`}
                ref={measurementIframeRef}
                title="计算全书页码"
                srcDoc={measurementSrcdoc}
                onLoad={onMeasurementLoad}
                sandbox="allow-same-origin"
                aria-hidden="true"
                tabIndex={-1}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  border: "none",
                  visibility: "hidden",
                  pointerEvents: "none",
                }}
              />
            )}
            {rendering && !renderError && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ background: "#faf6ef", fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--muted-foreground)" }}
              >
                正在渲染原版排版…
              </div>
            )}
            {translationOverlay}
          </div>
          </div>

          {/* 原版模式：按全书实际排版页数翻页 */}
          <div
            className="flex items-center justify-between gap-2"
            style={{
              borderTop: "1px solid var(--border)",
              background: "var(--card)",
              padding: "8px clamp(10px, 3vw, 16px) max(8px, env(safe-area-inset-bottom))",
            }}
          >
            <button
              onClick={goToPreviousPage}
              disabled={rendering || (chapterIndex === 0 && chapterPageIndex === 0)}
              aria-label="上一页"
              className="flex shrink-0 items-center gap-1 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px", minHeight: "40px", padding: "7px clamp(9px, 3vw, 14px)" }}
            >
              <ChevronLeft size={15} /> <span className="hidden sm:inline">上一页</span>
            </button>
            {!fixedLayout && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setFontSize((size) => Math.max(14, size - 1))}
                  disabled={fontSize <= 14}
                  aria-label="减小字号"
                  className="w-8 h-8 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
                  style={{ background: "var(--secondary)" }}
                >
                  <Minus size={13} style={{ color: "var(--foreground)" }} />
                </button>
                <span style={{ fontFamily: "Inter, sans-serif", color: "var(--foreground)", fontSize: "11px", width: "20px", textAlign: "center" }}>
                  {fontSize}
                </span>
                <button
                  onClick={() => setFontSize((size) => Math.min(28, size + 1))}
                  disabled={fontSize >= 28}
                  aria-label="增大字号"
                  className="w-8 h-8 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
                  style={{ background: "var(--secondary)" }}
                >
                  <Plus size={13} style={{ color: "var(--foreground)" }} />
                </button>
              </div>
            )}
            <span style={{ color: "var(--muted-foreground)", fontFamily: "Inter, sans-serif", fontSize: "12px", flex: 1, minWidth: 0, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {pageLabel}
            </span>
            <button
              onClick={onToggleDark}
              aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
              className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full"
              style={{ background: "var(--secondary)" }}
            >
              {isDark ? (
                <Sun size={17} style={{ color: "var(--accent)" }} />
              ) : (
                <Moon size={17} style={{ color: "var(--muted-foreground)" }} />
              )}
            </button>
            <button
              onClick={openChapterNavigation}
              aria-label="打开目录"
              className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full"
              style={{ background: "var(--secondary)" }}
            >
              <AlignJustify size={17} style={{ color: "var(--muted-foreground)" }} />
            </button>
            <button
              onClick={goToNextPage}
              disabled={rendering || (
                chapterIndex === book.chapters.length - 1
                && chapterPageIndex >= currentChapterPageCount - 1
              )}
              aria-label="下一页"
              className="flex shrink-0 items-center gap-1 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px", minHeight: "40px", padding: "7px clamp(9px, 3vw, 14px)" }}
            >
              <span className="hidden sm:inline">下一页</span> <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        <>
        <div className="reader-reading-stage flex-1 relative overflow-hidden">
        <div
          ref={contentRef}
          className="reader-text-page h-full overflow-y-auto"
          style={{
            scrollbarWidth: "none",
            padding: "clamp(22px, 5vw, 36px) clamp(18px, 7vw, 72px)",
          }}
          onMouseUp={captureReaderSelection}
          onTouchEnd={scheduleReaderSelection}
          onKeyUp={captureReaderSelection}
          onContextMenu={(event) => {
            if (!usesTouchSelection() || !window.getSelection()?.toString().trim()) return;
            event.preventDefault();
            scheduleReaderSelection();
          }}
          onClick={(event) => {
            if (window.getSelection()?.toString().trim()) {
              return;
            }
            const noteId = (event.target as HTMLElement)?.closest?.("mark[data-readtaylor-note-highlight]")?.getAttribute("data-note-id");
            const markedNote = notes.find((note) => note.id === noteId);
            if (markedNote) {
              editNote(markedNote);
              return;
            }
            const highlightedNote = contentRef.current
              ? noteAtPoint(document, contentRef.current, event.clientX, event.clientY)
              : null;
            if (highlightedNote) {
              editNote(highlightedNote);
              return;
            }
          }}
        >
          <h2
            className="mb-8"
            style={{
              fontFamily: "Lora, serif",
              fontSize: `${fontSize + 4}px`,
              fontWeight: 600,
              color: "var(--foreground)",
              lineHeight: 1.3,
            }}
          >
            {chapter.title}
          </h2>

          {chapter.content.split("\n\n").map((para, i) => (
            <p
              key={i}
              className="mb-6"
              style={{
                fontFamily: "Lora, serif",
                fontSize: `${fontSize}px`,
                lineHeight: 1.9,
                color: "var(--foreground)",
                textAlign: "justify",
              }}
            >
              {para}
            </p>
          ))}

          {/* Chapter navigation */}
          <div className="flex items-center justify-between mt-12 mb-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setChapterIndex((i) => Math.max(0, i - 1));
              }}
              disabled={chapterIndex === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "14px" }}
            >
              <ChevronLeft size={16} /> 上一章
            </button>
            <span style={{ color: "var(--muted-foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px" }}>
              {chapterIndex + 1} / {book.chapters.length}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setChapterIndex((i) => Math.min(book.chapters.length - 1, i + 1));
              }}
              disabled={chapterIndex === book.chapters.length - 1}
              className="flex items-center gap-2 px-4 py-2 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "14px" }}
            >
              下一章 <ChevronRight size={16} />
            </button>
          </div>
        </div>
        {translationOverlay}
        </div>
        <div
          className="flex shrink-0 items-center justify-between gap-3"
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--card)",
            padding: "8px clamp(12px, 4vw, 20px) max(8px, env(safe-area-inset-bottom))",
          }}
        >
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFontSize((size) => Math.max(14, size - 1))}
              disabled={fontSize <= 14}
              aria-label="减小字号"
              className="w-10 h-10 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)" }}
            >
              <Minus size={15} style={{ color: "var(--foreground)" }} />
            </button>
            <span style={{ fontFamily: "Inter, sans-serif", color: "var(--foreground)", fontSize: "13px", width: "26px", textAlign: "center" }}>
              {fontSize}
            </span>
            <button
              onClick={() => setFontSize((size) => Math.min(28, size + 1))}
              disabled={fontSize >= 28}
              aria-label="增大字号"
              className="w-10 h-10 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)" }}
            >
              <Plus size={15} style={{ color: "var(--foreground)" }} />
            </button>
          </div>
          <button
            onClick={onToggleDark}
            aria-label={isDark ? "切换浅色模式" : "切换深色模式"}
            className="w-10 h-10 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            {isDark ? (
              <Sun size={17} style={{ color: "var(--accent)" }} />
            ) : (
              <Moon size={17} style={{ color: "var(--muted-foreground)" }} />
            )}
          </button>
          <button
            onClick={openChapterNavigation}
            aria-label="打开目录"
            className="w-10 h-10 flex items-center justify-center rounded-full"
            style={{ background: "var(--secondary)" }}
          >
            <AlignJustify size={17} style={{ color: "var(--muted-foreground)" }} />
          </button>
        </div>
        </>
      )}

      <AnimatePresence>
        {showSpeechControls && (
          <motion.div
            key="speech-controls"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            role="dialog"
            aria-label="朗读控制"
            className="absolute z-40 rounded-2xl"
            style={{
              top: "max(66px, calc(env(safe-area-inset-top) + 58px))",
              right: "12px",
              width: "min(340px, calc(100% - 24px))",
              padding: "16px",
              border: "1px solid var(--border)",
              background: "var(--card)",
              boxShadow: "0 12px 36px rgba(58, 46, 32, 0.16)",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div style={{ fontFamily: "Lora, serif", fontWeight: 600, fontSize: "16px", color: "var(--foreground)" }}>朗读本章</div>
                <div style={{ marginTop: "3px", fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)" }}>
                  从当前阅读位置开始
                </div>
              </div>
              <button
                onClick={() => setShowSpeechControls(false)}
                aria-label="关闭朗读控制"
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full"
                style={{ background: "var(--secondary)" }}
              >
                <X size={15} style={{ color: "var(--muted-foreground)" }} />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={toggleSpeech}
                aria-label={speechStatus === "playing" ? "暂停朗读" : speechStatus === "paused" ? "继续朗读" : "开始朗读"}
                className="h-10 flex-1 flex items-center justify-center gap-2 rounded-xl"
                style={{ background: "var(--accent)", color: "var(--accent-foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px" }}
              >
                {speechStatus === "playing" ? <Pause size={16} /> : <Play size={16} />}
                {speechStatus === "playing" ? "暂停" : speechStatus === "paused" ? "继续" : "开始朗读"}
              </button>
              <button
                onClick={() => stopSpeech("已停止")}
                disabled={speechStatus === "idle"}
                aria-label="停止朗读"
                className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl transition-opacity disabled:opacity-30"
                style={{ background: "var(--secondary)" }}
              >
                <Square size={14} style={{ color: "var(--foreground)" }} />
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--muted-foreground)" }}>语速</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => changeSpeechRate(-0.25)}
                  disabled={speechRate <= 0.5}
                  aria-label="降低语速"
                  className="w-8 h-8 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
                  style={{ background: "var(--secondary)" }}
                >
                  <Minus size={13} style={{ color: "var(--foreground)" }} />
                </button>
                <span style={{ width: "44px", textAlign: "center", fontFamily: "Inter, sans-serif", fontSize: "13px", fontWeight: 600, color: "var(--foreground)" }}>
                  {speechRate.toFixed(2).replace(/\.00$/, ".0")}×
                </span>
                <button
                  onClick={() => changeSpeechRate(0.25)}
                  disabled={speechRate >= 2}
                  aria-label="提高语速"
                  className="w-8 h-8 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30"
                  style={{ background: "var(--secondary)" }}
                >
                  <Plus size={13} style={{ color: "var(--foreground)" }} />
                </button>
              </div>
            </div>

            <div aria-live="polite" style={{ minHeight: "18px", marginTop: "10px", fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)" }}>
              {speechMessage || (speechSupported ? "使用设备自带的语音朗读" : "当前浏览器不支持朗读")}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Text selection action — keep it separate from the normal reading toolbar. */}
      <AnimatePresence>
        {selectionTarget && !noteComposer && (
          <motion.button
            key="selection-note-action"
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            transition={{ duration: 0.14 }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={startNoteFromSelection}
            className="fixed z-50 flex items-center gap-2 rounded-full"
            style={{
              left: selectionTarget.x,
              top: selectionTarget.y,
              transform: "translateX(-50%)",
              minHeight: "40px",
              padding: "9px 15px",
              border: "1px solid color-mix(in srgb, var(--accent) 38%, var(--border))",
              background: "var(--foreground)",
              color: "var(--background)",
              boxShadow: "0 10px 30px rgba(39, 29, 18, 0.2)",
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            <NotebookPen size={16} />
            做笔记
          </motion.button>
        )}
      </AnimatePresence>

      {/* Saved notes drawer */}
      <AnimatePresence>
        {showNotes && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30"
              style={{ background: "rgba(0,0,0,0.4)" }}
              onClick={() => setShowNotes(false)}
            />
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              aria-label="我的笔记"
              className="absolute right-0 top-0 bottom-0 z-40 flex flex-col"
              style={{
                background: "var(--card)",
                width: "min(92vw, 420px)",
                paddingTop: "env(safe-area-inset-top)",
                paddingBottom: "env(safe-area-inset-bottom)",
              }}
            >
              <div
                className="flex items-center justify-between px-5 py-3.5"
                style={{ borderBottom: "1px solid var(--border)", minHeight: "56px" }}
              >
                <div>
                  <div style={{ fontFamily: "Lora, serif", fontSize: "17px", fontWeight: 600, color: "var(--foreground)" }}>
                    我的笔记
                  </div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)", marginTop: "2px" }}>
                    {notes.length ? `${notes.length} 条 · 仅保存在本机` : "仅保存在本机"}
                  </div>
                </div>
                <button
                  onClick={() => setShowNotes(false)}
                  aria-label="关闭笔记"
                  className="w-10 h-10 flex items-center justify-center rounded-full"
                >
                  <X size={20} style={{ color: "var(--muted-foreground)" }} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto" style={{ padding: "14px", scrollbarWidth: "none" }}>
                {notes.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center text-center" style={{ padding: "32px 24px" }}>
                    <div className="flex items-center justify-center rounded-full" style={{ width: "56px", height: "56px", background: "var(--secondary)", marginBottom: "14px" }}>
                      <NotebookPen size={23} style={{ color: "var(--muted-foreground)" }} />
                    </div>
                    <p style={{ fontFamily: "Lora, serif", fontSize: "16px", fontWeight: 600, color: "var(--foreground)", margin: "0 0 7px" }}>
                      还没有笔记
                    </p>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", lineHeight: 1.7, color: "var(--muted-foreground)", margin: 0, maxWidth: "250px" }}>
                      关闭这里，在正文中选中文字，就能添加第一条笔记。
                    </p>
                  </div>
                ) : notes.map((note) => (
                  <article
                    key={note.id}
                    style={{
                      background: "var(--secondary)",
                      border: "1px solid var(--border)",
                      borderLeft: `4px solid ${noteColor(note.color).hex}`,
                      borderRadius: "14px",
                      padding: "14px",
                      marginBottom: "12px",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3" style={{ marginBottom: "9px" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {note.chapterTitle}{note.pageIndex != null ? ` · 第 ${note.pageIndex + 1} 页` : ""}
                        </div>
                        <div style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--muted-foreground)", marginTop: "3px" }}>
                          {new Date(note.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => editNote(note)}
                          aria-label="编辑笔记"
                          className="w-8 h-8 flex items-center justify-center rounded-full"
                          style={{ background: "var(--card)" }}
                        >
                          <Pencil size={14} style={{ color: "var(--muted-foreground)" }} />
                        </button>
                        <button
                          onClick={() => removeNote(note)}
                          aria-label="删除笔记"
                          className="w-8 h-8 flex items-center justify-center rounded-full"
                          style={{ background: "var(--card)" }}
                        >
                          <Trash2 size={14} style={{ color: "var(--muted-foreground)" }} />
                        </button>
                      </div>
                    </div>
                    <blockquote
                      style={{
                        borderLeft: "2px solid var(--accent)",
                        color: "var(--muted-foreground)",
                        fontFamily: "Lora, serif",
                        fontSize: "12px",
                        lineHeight: 1.65,
                        margin: "0 0 10px",
                        paddingLeft: "10px",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {note.quote}
                    </blockquote>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", lineHeight: 1.65, color: note.body ? "var(--foreground)" : "var(--muted-foreground)", margin: 0, whiteSpace: "pre-wrap" }}>
                      {note.body || "仅标记，没有附加文字"}
                    </p>
                  </article>
                ))}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Note composer */}
      <AnimatePresence>
        {noteComposer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[60] flex items-end justify-center sm:items-center"
            style={{ background: "rgba(20, 16, 12, 0.46)", padding: "clamp(10px, 3vw, 24px)" }}
            onClick={() => setNoteComposer(null)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={noteComposer.id ? "编辑笔记" : "添加笔记"}
              initial={{ opacity: 0, y: 22, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 22, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "min(100%, 520px)",
                maxHeight: "min(78vh, 620px)",
                overflowY: "auto",
                borderRadius: "18px",
                border: "1px solid var(--border)",
                background: "var(--card)",
                boxShadow: "0 24px 70px rgba(20, 16, 12, 0.28)",
                padding: "18px",
                scrollbarWidth: "none",
              }}
            >
              <div className="flex items-center justify-between" style={{ marginBottom: "13px" }}>
                <div>
                  <div style={{ fontFamily: "Lora, serif", fontSize: "18px", fontWeight: 600, color: "var(--foreground)" }}>
                    {noteComposer.id ? "编辑笔记" : "做笔记"}
                  </div>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)", marginTop: "3px" }}>
                    {noteComposer.chapterTitle}{noteComposer.pageIndex != null ? ` · 第 ${noteComposer.pageIndex + 1} 页` : ""}
                  </div>
                </div>
                <button
                  onClick={() => setNoteComposer(null)}
                  aria-label="关闭"
                  className="w-9 h-9 flex items-center justify-center rounded-full"
                  style={{ background: "var(--secondary)" }}
                >
                  <X size={18} style={{ color: "var(--muted-foreground)" }} />
                </button>
              </div>

              <blockquote
                style={{
                  maxHeight: "128px",
                  overflowY: "auto",
                  borderLeft: "3px solid var(--accent)",
                  borderRadius: "0 10px 10px 0",
                  background: "var(--secondary)",
                  color: "var(--muted-foreground)",
                  fontFamily: "Lora, serif",
                  fontSize: "13px",
                  lineHeight: 1.7,
                  margin: "0 0 13px",
                  padding: "10px 12px",
                  scrollbarWidth: "thin",
                }}
              >
                {noteComposer.quote}
              </blockquote>

              <div style={{ marginBottom: "13px" }}>
                <div style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--muted-foreground)", marginBottom: "8px" }}>
                  标记颜色
                </div>
                <div className="flex flex-wrap items-center" style={{ gap: "9px" }}>
                  {NOTE_COLORS.map((color) => {
                    const selected = noteComposer.color === color.id;
                    return (
                      <button
                        key={color.id}
                        type="button"
                        onClick={() => setNoteComposer((current) => current ? { ...current, color: color.id } : current)}
                        aria-label={`选择${color.label}标记`}
                        aria-pressed={selected}
                        className="flex items-center gap-2 rounded-full"
                        style={{
                          minHeight: "34px",
                          padding: "6px 10px 6px 7px",
                          border: selected ? `2px solid ${color.hex}` : "1px solid var(--border)",
                          background: selected ? color.fill : "var(--secondary)",
                          color: "var(--foreground)",
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                        }}
                      >
                        <span style={{ width: "17px", height: "17px", borderRadius: "50%", background: color.hex, display: "inline-block" }} />
                        {color.label}
                        {selected && <Check size={13} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <textarea
                autoFocus
                value={noteComposer.body}
                onChange={(event) => setNoteComposer((current) => current ? { ...current, body: event.target.value } : current)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") commitNote();
                }}
                placeholder="写下你的想法（可选）…"
                rows={5}
                style={{
                  width: "100%",
                  minHeight: "132px",
                  resize: "vertical",
                  border: "1px solid var(--border)",
                  borderRadius: "12px",
                  outline: "none",
                  background: "var(--background)",
                  color: "var(--foreground)",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "14px",
                  lineHeight: 1.7,
                  padding: "12px",
                }}
              />

              <div className="flex items-center justify-between gap-3" style={{ marginTop: "13px" }}>
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--muted-foreground)" }}>
                  Ctrl / ⌘ + Enter 保存
                </span>
                <button
                  onClick={commitNote}
                  className="flex items-center gap-2 rounded-full"
                  style={{
                    minHeight: "40px",
                    border: "none",
                    background: "var(--accent)",
                    color: "var(--accent-foreground)",
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    fontWeight: 600,
                    padding: "9px 17px",
                  }}
                >
                  <Check size={16} /> 保存笔记
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {noteFeedback && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute left-1/2 z-[80] rounded-full"
            style={{
              top: "max(76px, calc(env(safe-area-inset-top) + 64px))",
              transform: "translateX(-50%)",
              background: "var(--foreground)",
              color: "var(--background)",
              boxShadow: "0 8px 24px rgba(20, 16, 12, 0.18)",
              fontFamily: "Inter, sans-serif",
              fontSize: "12px",
              padding: "9px 14px",
              whiteSpace: "nowrap",
            }}
          >
            {noteFeedback}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chapter list drawer */}
      <AnimatePresence>
        {showChapters && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30"
              style={{ background: "rgba(0,0,0,0.4)" }}
              onClick={() => setShowChapters(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              aria-label="章节目录"
              className="absolute right-0 top-0 bottom-0 z-40 flex flex-col"
              style={{
                background: "var(--card)",
                width: "min(88vw, 360px)",
                paddingTop: "env(safe-area-inset-top)",
                paddingBottom: "env(safe-area-inset-bottom)",
              }}
            >
              <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--border)", minHeight: "56px" }}>
                <span style={{ fontFamily: "Lora, serif", fontSize: "17px", fontWeight: 600, color: "var(--foreground)" }}>目录</span>
                <button
                  onClick={() => setShowChapters(false)}
                  aria-label="关闭目录"
                  className="w-10 h-10 flex items-center justify-center rounded-full"
                >
                  <X size={20} style={{ color: "var(--muted-foreground)" }} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: "none" }}>
                {book.chapters.map((ch, i) => (
                  <button
                    key={ch.id}
                    onClick={() => {
                      goToChapter(i, "first");
                      setShowChapters(false);
                    }}
                    className="w-full flex items-center px-5 py-3.5 text-left transition-colors"
                    style={{
                      background: i === chapterIndex ? "var(--secondary)" : "transparent",
                      borderLeft: i === chapterIndex ? "3px solid var(--accent)" : "3px solid transparent",
                      minHeight: "48px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "Lora, serif",
                        fontSize: "15px",
                        color: i === chapterIndex ? "var(--foreground)" : "var(--muted-foreground)",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ch.title}
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      </main>

      <aside
        aria-label="学习工作台"
        className={`reader-desktop-sidebar reader-right-sidebar${rightSidebarOpen ? "" : " reader-sidebar-collapsed"}`}
      >
        {rightSidebarOpen ? (
          <>
            <div className="reader-sidebar-header">
              <span>学习工作台</span>
              <button
                onClick={() => setRightSidebarOpen(false)}
                aria-label="收起学习工作台"
                className="reader-sidebar-icon-button"
              >
                <ChevronsRight size={17} />
              </button>
            </div>
            <div className="reader-study-scroll">
              <section className="reader-study-section">
                <button
                  onClick={() => toggleStudySection("notes")}
                  className="reader-study-section-heading"
                  aria-expanded={studySections.notes}
                >
                  <span>本页笔记</span>
                  <span className="flex items-center gap-2">
                    {currentPageNotes.length > 0 && <small>{currentPageNotes.length}</small>}
                    {studySections.notes ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </span>
                </button>
                {studySections.notes && (
                  <div className="reader-study-section-content">
                    {currentPageNotes.length === 0 ? (
                      <div className="reader-study-empty">
                        本页还没有笔记，选中文字即可添加。
                      </div>
                    ) : currentPageNotes.slice(0, 4).map((note) => (
                      <article key={note.id} className="reader-note-preview" style={{ borderLeftColor: noteColor(note.color).hex }}>
                        <div className="reader-note-preview-actions">
                          <button onClick={() => editNote(note)} aria-label="编辑笔记"><Pencil size={13} /></button>
                          <button onClick={() => removeNote(note)} aria-label="删除笔记"><Trash2 size={13} /></button>
                        </div>
                        <blockquote>{note.quote}</blockquote>
                        {note.body && <p>{note.body}</p>}
                        <time>{new Date(note.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="reader-study-section">
                <button
                  onClick={() => toggleStudySection("translation")}
                  className="reader-study-section-heading"
                  aria-expanded={studySections.translation}
                >
                  <span>本页翻译</span>
                  {studySections.translation ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
                {studySections.translation && (
                  <div className="reader-study-section-content">
                    <select
                      aria-label="选择翻译语言"
                      value={translationLanguage}
                      onChange={(event) => changeTranslationLanguage(event.target.value)}
                      className="reader-study-language"
                    >
                      {TRANSLATION_LANGUAGES.map((language) => (
                        <option key={language.code} value={language.code}>{language.label}</option>
                      ))}
                    </select>
                    {translationLoading ? (
                      <div className="reader-study-loading"><LoaderCircle className="animate-spin" size={16} /> 正在翻译当前页…</div>
                    ) : translationError ? (
                      <div className="reader-study-error">
                        <p>{translationError}</p>
                        <button onClick={() => void translateSource(currentPageTranslationSource(), translationLanguage)}>重试</button>
                      </div>
                    ) : translationText ? (
                      <div className="reader-translation-preview">{translationText}</div>
                    ) : (
                      <button
                        onClick={() => void translateSource(currentPageTranslationSource(), translationLanguage)}
                        className="reader-study-primary-button"
                      >
                        翻译当前页
                      </button>
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        ) : (
          <button
            onClick={() => setRightSidebarOpen(true)}
            aria-label="展开学习工作台"
            className="reader-collapsed-rail-button"
          >
            <ChevronLeft size={18} />
          </button>
        )}
      </aside>
    </div>
  );
}
