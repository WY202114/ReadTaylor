import { useState, useRef, useEffect } from "react";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Sun,
  Moon,
  Minus,
  Plus,
  AlignJustify,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { Book } from "../lib/books";
import { renderChapter, resolveInternalIndex, cleanup as cleanupEpub } from "../lib/epubRender";
import { paginateFrame, scrollFrameToPage } from "../lib/epubPagination";

interface ReaderViewProps {
  book: Book;
  onBack: (lastChapterIndex: number, lastScroll: number) => void;
  isDark: boolean;
  onToggleDark: () => void;
}

type PendingPage =
  | { chapterIndex: number; mode: "first" | "last" }
  | { chapterIndex: number; mode: "progress"; progress: number };

function clampProgress(value: number): number {
  return Math.min(Math.max(value || 0, 0), 1);
}

export function ReaderView({ book, onBack, isDark, onToggleDark }: ReaderViewProps) {
  const initialChapterIndex = Math.min(book.lastChapter || 0, book.chapters.length - 1);
  const initialProgress = clampProgress(book.lastScroll || 0);
  const isFidelity = book.mode === "fidelity";
  const fixedLayout = isFidelity && book.layout === "fixed";
  const [chapterIndex, setChapterIndex] = useState(initialChapterIndex);
  const [chapterPageIndex, setChapterPageIndex] = useState(0);
  const [chapterPageCounts, setChapterPageCounts] = useState<Array<number | null>>(() => (
    fixedLayout ? book.chapters.map(() => 1) : book.chapters.map(() => null)
  ));
  const [measurementIndex, setMeasurementIndex] = useState(fixedLayout ? -1 : 0);
  const [measurementSrcdoc, setMeasurementSrcdoc] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [showToolbar, setShowToolbar] = useState(false);
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [showChapters, setShowChapters] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(initialProgress);
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
  const [srcdoc, setSrcdoc] = useState("");
  const [rendering, setRendering] = useState(isFidelity);
  const [renderError, setRenderError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const measurementIframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const chapter = book.chapters[chapterIndex];
  const bookmarkKey = `${book.id}-${chapter.id}`;
  const isBookmarked = bookmarks.has(bookmarkKey);

  // 原版模式：渲染当前章节的原 HTML
  useEffect(() => {
    if (!isFidelity) return;
    let cancelled = false;
    setRendering(true);
    setRenderError("");
    renderChapter(book, chapterIndex)
      .then((html) => !cancelled && setSrcdoc(html))
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
    const { pageCount } = await paginateFrame(frame, false);
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

  // 窗口尺寸改变后页数会变化；保留当前章节内的相对位置并重新计算全书页码。
  useEffect(() => {
    if (!isFidelity || !viewportRef.current) return;
    let previousSize = "";
    let resizeTimer = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const nextSize = `${width}x${height}`;
      if (!width || !height || nextSize === previousSize) return;
      if (!previousSize) {
        previousSize = nextSize;
        return;
      }
      previousSize = nextSize;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const position = paginationPositionRef.current;
        pendingPageRef.current = {
          chapterIndex: position.chapterIndex,
          mode: "progress",
          progress: position.pageCount > 1
            ? position.pageIndex / (position.pageCount - 1)
            : 0,
        };
        setChapterPageIndex(0);
        setChapterPageCounts(
          fixedLayout ? book.chapters.map(() => 1) : book.chapters.map(() => null)
        );
        setMeasurementIndex(fixedLayout ? -1 : 0);
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

  // 离开阅读器时回收 EPUB 的 blob URL
  useEffect(() => () => cleanupEpub(), []);

  const onIframeLoad = async () => {
    const frame = iframeRef.current;
    const cdoc = frame?.contentDocument;
    const cwin = frame?.contentWindow;
    if (!cdoc || !cwin) return;
    const { pageCount } = await paginateFrame(frame, fixedLayout);
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
      setShowToolbar((v) => !v);
    });
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

  useEffect(() => {
    if (isFidelity) setScrollProgress(fidelityProgress);
  }, [isFidelity, fidelityProgress]);

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

  const toggleBookmark = () => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(bookmarkKey)) next.delete(bookmarkKey);
      else next.add(bookmarkKey);
      return next;
    });
  };

  return (
    <div
      className="relative flex flex-col h-screen overflow-hidden"
      style={{
        background: isDark ? "var(--background)" : "#faf6ef",
        height: "100dvh",
        minHeight: "100svh",
      }}
    >
      {/* Progress bar */}
      <div
        className="absolute top-0 left-0 h-0.5 z-20 transition-all duration-200"
        style={{
          width: `${scrollProgress * 100}%`,
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
          onClick={() => onBack(
            chapterIndex,
            isFidelity
              ? currentChapterPageCount > 1
                ? chapterPageIndex / (currentChapterPageCount - 1)
                : 0
              : scrollProgress
          )}
          aria-label="返回书架"
          className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "var(--secondary)" }}
        >
          <ArrowLeft size={18} style={{ color: "var(--foreground)" }} />
        </button>

        <button
          onClick={() => setShowChapters(true)}
          aria-label="打开目录"
          className="flex-1 min-w-0 mx-3 sm:mx-4 text-center truncate"
          style={{ fontFamily: "Inter, sans-serif", color: "var(--muted-foreground)", fontSize: "13px" }}
        >
          {chapter.title}
        </button>

        <button
          onClick={toggleBookmark}
          aria-label={isBookmarked ? "取消书签" : "添加书签"}
          className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "var(--secondary)" }}
        >
          {isBookmarked ? (
            <BookmarkCheck size={18} style={{ color: "var(--accent)" }} />
          ) : (
            <Bookmark size={18} style={{ color: "var(--muted-foreground)" }} />
          )}
        </button>
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
          <div ref={viewportRef} className="flex-1 relative overflow-hidden">
            {renderError ? (
              <div
                className="absolute inset-0 flex items-center justify-center px-8 text-center"
                style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", lineHeight: 1.7, color: "var(--muted-foreground)" }}
              >
                {renderError}
              </div>
            ) : (
              <iframe
                key={`${book.id}-${chapterIndex}-${layoutRevision}`}
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
              className="flex shrink-0 items-center gap-1 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px", minHeight: "40px", padding: "7px clamp(9px, 3vw, 14px)" }}
            >
              <ChevronLeft size={15} /> 上一页
            </button>
            <span style={{ color: "var(--muted-foreground)", fontFamily: "Inter, sans-serif", fontSize: "12px", flex: 1, minWidth: 0, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {pageLabel}
            </span>
            <button
              onClick={goToNextPage}
              disabled={rendering || (
                chapterIndex === book.chapters.length - 1
                && chapterPageIndex >= currentChapterPageCount - 1
              )}
              className="flex shrink-0 items-center gap-1 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px", minHeight: "40px", padding: "7px clamp(9px, 3vw, 14px)" }}
            >
              下一页 <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={contentRef}
          className="flex-1 overflow-y-auto"
          style={{
            scrollbarWidth: "none",
            padding: "clamp(22px, 5vw, 36px) clamp(18px, 7vw, 72px)",
          }}
          onClick={() => setShowToolbar((v) => !v)}
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
      )}

      {/* Bottom toolbar */}
      <AnimatePresence>
        {showToolbar && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="absolute bottom-0 left-0 right-0 z-20 px-6 py-5"
            style={{
              background: "var(--card)",
              borderTop: "1px solid var(--border)",
              padding: "16px clamp(16px, 5vw, 24px) max(16px, env(safe-area-inset-bottom))",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              {/* Font size — 原版模式下对正文无效，隐藏 */}
              {isFidelity ? (
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--muted-foreground)" }}>
                  原版排版
                </span>
              ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setFontSize((s) => Math.max(14, s - 1))}
                  className="w-9 h-9 flex items-center justify-center rounded-full"
                  style={{ background: "var(--secondary)" }}
                >
                  <Minus size={15} style={{ color: "var(--foreground)" }} />
                </button>
                <span style={{ fontFamily: "Inter, sans-serif", color: "var(--foreground)", fontSize: "14px", width: "28px", textAlign: "center" }}>
                  {fontSize}
                </span>
                <button
                  onClick={() => setFontSize((s) => Math.min(28, s + 1))}
                  className="w-9 h-9 flex items-center justify-center rounded-full"
                  style={{ background: "var(--secondary)" }}
                >
                  <Plus size={15} style={{ color: "var(--foreground)" }} />
                </button>
              </div>
              )}

              {/* Dark mode */}
              <button
                onClick={onToggleDark}
                className="w-9 h-9 flex items-center justify-center rounded-full"
                style={{ background: "var(--secondary)" }}
              >
                {isDark ? (
                  <Sun size={17} style={{ color: "var(--accent)" }} />
                ) : (
                  <Moon size={17} style={{ color: "var(--muted-foreground)" }} />
                )}
              </button>

              {/* Chapters */}
              <button
                onClick={() => setShowChapters(true)}
                aria-label="打开目录"
                className="w-9 h-9 flex items-center justify-center rounded-full"
                style={{ background: "var(--secondary)" }}
              >
                <AlignJustify size={17} style={{ color: "var(--muted-foreground)" }} />
              </button>
            </div>
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
                    {bookmarks.has(`${book.id}-${ch.id}`) && (
                      <BookmarkCheck size={14} style={{ color: "var(--accent)", marginLeft: "auto" }} />
                    )}
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
