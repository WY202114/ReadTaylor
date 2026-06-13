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

interface ReaderViewProps {
  book: Book;
  onBack: (lastChapterIndex: number) => void;
  isDark: boolean;
  onToggleDark: () => void;
}

export function ReaderView({ book, onBack, isDark, onToggleDark }: ReaderViewProps) {
  const [chapterIndex, setChapterIndex] = useState(
    Math.min(book.lastChapter || 0, book.chapters.length - 1)
  );
  const [fontSize, setFontSize] = useState(18);
  const [showToolbar, setShowToolbar] = useState(false);
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [showChapters, setShowChapters] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const isFidelity = book.mode === "fidelity";
  const [srcdoc, setSrcdoc] = useState("");
  const [rendering, setRendering] = useState(isFidelity);
  const [renderError, setRenderError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
      .catch((e) => !cancelled && setRenderError(String(e?.message || e)))
      .finally(() => !cancelled && setRendering(false));
    return () => {
      cancelled = true;
    };
  }, [isFidelity, book, chapterIndex]);

  // 离开阅读器时回收 EPUB 的 blob URL
  useEffect(() => () => cleanupEpub(), []);

  const onIframeLoad = () => {
    const cdoc = iframeRef.current?.contentDocument;
    const cwin = iframeRef.current?.contentWindow;
    if (!cdoc || !cwin) return;
    setScrollProgress(0);
    const onScroll = () => {
      const el = cdoc.scrollingElement || cdoc.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      setScrollProgress(max > 0 ? el.scrollTop / max : 0);
    };
    cwin.addEventListener("scroll", onScroll);
    cdoc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement)?.closest?.("a");
      if (a) {
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        const idx = resolveInternalIndex(book, chapterIndex, href);
        if (idx != null) setChapterIndex(idx);
        else if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener");
        return;
      }
      setShowToolbar((v) => !v);
    });
  };

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
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setScrollProgress(0);
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
      style={{ background: isDark ? "var(--background)" : "#faf6ef" }}
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
        className="flex items-center justify-between px-5 py-4 z-10"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <button
          onClick={() => onBack(chapterIndex)}
          className="w-9 h-9 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "var(--secondary)" }}
        >
          <ArrowLeft size={18} style={{ color: "var(--foreground)" }} />
        </button>

        <button
          onClick={() => setShowChapters(true)}
          className="flex-1 mx-4 text-center truncate"
          style={{ fontFamily: "Inter, sans-serif", color: "var(--muted-foreground)", fontSize: "13px" }}
        >
          {chapter.title}
        </button>

        <button
          onClick={toggleBookmark}
          className="w-9 h-9 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "var(--secondary)" }}
        >
          {isBookmarked ? (
            <BookmarkCheck size={18} style={{ color: "var(--accent)" }} />
          ) : (
            <Bookmark size={18} style={{ color: "var(--muted-foreground)" }} />
          )}
        </button>
      </div>

      {/* Content — 原版（EPUB iframe）或文本模式 */}
      {isFidelity ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 relative overflow-hidden">
            {renderError ? (
              <div
                className="absolute inset-0 flex items-center justify-center px-8 text-center"
                style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", lineHeight: 1.7, color: "var(--muted-foreground)" }}
              >
                {renderError}
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                title={chapter.title}
                srcDoc={srcdoc}
                onLoad={onIframeLoad}
                sandbox="allow-same-origin"
                style={{ width: "100%", height: "100%", border: "none", background: "#faf6ef", display: "block" }}
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

          {/* 原版模式：常驻翻章条 */}
          <div
            className="flex items-center justify-between px-4 py-2"
            style={{ borderTop: "1px solid var(--border)", background: "var(--card)" }}
          >
            <button
              onClick={() => setChapterIndex((i) => Math.max(0, i - 1))}
              disabled={chapterIndex === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px" }}
            >
              <ChevronLeft size={15} /> 上一章
            </button>
            <span style={{ color: "var(--muted-foreground)", fontFamily: "Inter, sans-serif", fontSize: "12px" }}>
              {chapterIndex + 1} / {book.chapters.length}
            </span>
            <button
              onClick={() => setChapterIndex((i) => Math.min(book.chapters.length - 1, i + 1))}
              disabled={chapterIndex === book.chapters.length - 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--secondary)", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "13px" }}
            >
              下一章 <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={contentRef}
          className="flex-1 overflow-y-auto px-6 py-8"
          style={{ scrollbarWidth: "none" }}
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
              className="absolute right-0 top-0 bottom-0 z-40 w-72 flex flex-col"
              style={{ background: "var(--card)" }}
            >
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontFamily: "Lora, serif", fontSize: "17px", fontWeight: 600, color: "var(--foreground)" }}>目录</span>
                <button onClick={() => setShowChapters(false)}>
                  <X size={20} style={{ color: "var(--muted-foreground)" }} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: "none" }}>
                {book.chapters.map((ch, i) => (
                  <button
                    key={ch.id}
                    onClick={() => {
                      setChapterIndex(i);
                      setShowChapters(false);
                    }}
                    className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors"
                    style={{
                      background: i === chapterIndex ? "var(--secondary)" : "transparent",
                      borderLeft: i === chapterIndex ? "3px solid var(--accent)" : "3px solid transparent",
                    }}
                  >
                    <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--muted-foreground)", width: "20px" }}>
                      {i + 1}
                    </span>
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
