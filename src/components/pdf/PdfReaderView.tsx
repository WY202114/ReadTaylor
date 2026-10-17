import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, List, Minus, Pin, Plus, RotateCw, Search, Sun, Moon, X } from "lucide-react";
import type { Book } from "../../lib/books";
import { PdfSession, type PdfOutlineItem } from "../../lib/pdf/session";
import type { PdfPageAccess, PdfPosition, PdfZoom } from "../../lib/pdf/types";
import { usePdfToolbar } from "./usePdfToolbar";
import "pdfjs-dist/web/pdf_viewer.css";

interface Props {
  book: Book;
  isDark: boolean;
  onToggleDark: () => void;
  onBack: () => void;
  onPositionChange: (position: PdfPosition) => void;
  /** Future highlights use PDF coordinates rather than zoom-dependent DOM offsets. */
  onPageAccess?: (access: PdfPageAccess | null) => void;
}

function Outline({ items, onChoose, depth = 0 }: { items: PdfOutlineItem[]; onChoose: (item: PdfOutlineItem) => void; depth?: number }) {
  return <ul>{items.map((item, index) => <li key={index}>
    <button title={item.title || "未命名目录项"} style={{ paddingInlineStart: `${14 + Math.min(depth, 8) * 12}px` }} onClick={() => onChoose(item)}>{item.title || "未命名目录项"}</button>
    {item.items?.length > 0 && <Outline items={item.items} onChoose={onChoose} depth={depth + 1} />}
  </li>)}</ul>;
}

export function PdfReaderView({ book, isDark, onToggleDark, onBack, onPositionChange, onPageAccess }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const session = useRef<PdfSession>();
  const searchInput = useRef<HTMLInputElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; time: number }>();
  const toolbar = usePdfToolbar();
  const [chromeHeight, setChromeHeight] = useState(0);
  const [chromeFocused, setChromeFocused] = useState(false);
  const callbacks = useRef({ onPositionChange, onPageAccess });
  callbacks.current = { onPositionChange, onPageAccess };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [count, setCount] = useState(book.pdf?.pageCount || 0);
  const [zoom, setZoom] = useState<PdfZoom>("page-width");
  const [scale, setScale] = useState(1);
  const [customZoom, setCustomZoom] = useState("100");
  const [rotation, setRotation] = useState(0);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState({ current: 0, total: 0, state: 0 });
  const toolsVisible = toolbar.pinned || toolbar.peeking || chromeFocused || searchOpen || outlineOpen;

  useLayoutEffect(() => {
    const element = chrome.current;
    if (!element) return;
    const measure = () => setChromeHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { if (chrome.current) chrome.current.inert = !toolsVisible; }, [toolsVisible]);

  const returnToBook = () => container.current?.focus({ preventScroll: true });
  const setPinned = (value: boolean) => {
    if (!value) {
      returnToBook(); setChromeFocused(false); setOutlineOpen(false); setSearchOpen(false);
      session.current?.closeSearch();
    }
    toolbar.pin(value);
  };
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
  };
  const closeSearch = () => { setSearchOpen(false); session.current?.closeSearch(); returnToBook(); };
  const back = () => { session.current?.flush(); onBack(); };
  const editable = (target: EventTarget | null) => target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable);
  const changeZoom = (factor: number) => {
    const current = session.current;
    if (current?.pageCount) current.setZoom(current.viewer.currentScale * factor);
  };

  useEffect(() => {
    if (!container.current || !pages.current) return;
    let active = true;
    const current = new PdfSession(book, container.current, pages.current, {
      ready: (total, items) => { if (active) { setReady(true); setCount(total); setOutline(items); } },
      view: (number, value, actualScale, angle) => {
        if (!active) return;
        setPage(number); setPageInput(String(number)); setZoom(value); setScale(actualScale);
        setCustomZoom(String(Math.round(actualScale * 100))); setRotation(angle);
      },
      matches: (number, total, state = 0) => { if (active) setMatch({ current: number, total, state }); },
      error: (message) => { if (active) setError(message); },
      storageError: () => { if (active) setStorageError(true); },
      position: (position) => callbacks.current.onPositionChange(position),
    });
    session.current = current;
    callbacks.current.onPageAccess?.(current);
    void current.open().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "PDF 打开失败，请重新导入原文件。"); });
    return () => { active = false; current.destroy(); session.current = undefined; callbacks.current.onPageAccess?.(null); };
  }, [book.id]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (searchOpen) { event.preventDefault(); closeSearch(); }
        else if (outlineOpen) { event.preventDefault(); setOutlineOpen(false); returnToBook(); }
        else if (toolbar.peeking || (!toolbar.pinned && chromeFocused)) {
          event.preventDefault(); returnToBook(); setChromeFocused(false); toolbar.dismissPeek();
        } else if (!editable(event.target)) { event.preventDefault(); back(); }
        return;
      }
      if (editable(event.target) || event.altKey) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if ((modifier && key === "f") || (!modifier && key === "/")) { event.preventDefault(); openSearch(); }
      else if (!modifier && key === "h" && !event.repeat) { event.preventDefault(); setPinned(!toolbar.pinned); }
      else if (!modifier && (key === "arrowright" || key === "pagedown")) { event.preventDefault(); void session.current?.goToPage(page + 1); }
      else if (!modifier && (key === "arrowleft" || key === "pageup")) { event.preventDefault(); void session.current?.goToPage(page - 1); }
      else if (key === "+" || key === "=") { event.preventDefault(); changeZoom(1.2); }
      else if (key === "-") { event.preventDefault(); changeZoom(1 / 1.2); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [page, searchOpen, outlineOpen, toolbar.pinned, toolbar.peeking, chromeFocused]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    let delta = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || editable(event.target) || !session.current) return;
      event.preventDefault(); delta += event.deltaY;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (delta) changeZoom(delta < 0 ? 1.1 : 1 / 1.1);
        delta = 0;
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { element.removeEventListener("wheel", wheel); cancelAnimationFrame(frame); };
  }, []);

  const touchStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") touch.current = event.isPrimary ? { x: event.clientX, y: event.clientY, time: Date.now() } : undefined;
  };
  const touchEnd = (event: PointerEvent<HTMLDivElement>) => {
    const start = touch.current; touch.current = undefined;
    if (!start || event.pointerType !== "touch" || Date.now() - start.time > 450 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, .annotationLayer")) return;
    if (window.getSelection()?.toString().trim()) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (x > .25 && x < .75 && y > .25 && y < .75) setPinned(!toolbar.pinned);
  };

  const jump = (event: FormEvent) => { event.preventDefault(); void session.current?.goToPage(Number(pageInput)); };
  const noText = book.pdf?.pagesWithText[page - 1] === false;
  const zoomValue = typeof zoom === "number" ? "custom" : zoom;
  const searchNext = (previous = false) => session.current?.search(query, true, previous);

  return (
    <main ref={root} className="pdf-reader" aria-label={`原版阅读 ${book.title}`} data-source-sha256={book.pdf?.sha256}
      data-toolbar={toolsVisible ? (toolbar.pinned ? "pinned" : "peek") : "hidden"}
      style={{ "--pdf-chrome-height": `${chromeHeight}px` } as CSSProperties}
      onPointerMove={(event) => toolbar.pointerMove(event, chrome.current?.getBoundingClientRect().bottom || 0)} onPointerLeave={toolbar.dismissPeek}>
      <div className="pdf-chrome-slot" aria-hidden="true" />
      <div ref={chrome} id="pdf-reader-controls" className="pdf-chrome" aria-hidden={!toolsVisible}
        onFocusCapture={(event) => {
          // Keyboard focus and active text editing stay accessible; mouse-clicked buttons may fade on leave.
          setChromeFocused(event.target.matches(":focus-visible") || editable(event.target));
        }} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setChromeFocused(false); }}>
      <header className="pdf-reader-header">
        <button onClick={back} aria-label="返回书架（Esc）" title="返回书架（Esc，先关闭搜索或弹层）"><ArrowLeft size={18} /></button>
        <div className="pdf-reader-title"><h1 title={book.title}>{book.title}</h1><span>PDF 原版阅读 · 页面保持原色</span></div>
        {!toolbar.pinned && <button onClick={() => setPinned(true)} aria-label="固定显示工具栏（H）" title="固定显示工具栏（H）"><Pin size={16} /><span>固定显示</span></button>}
        <button onClick={onToggleDark} aria-label={isDark ? "切换日间模式" : "切换夜间模式"} title={isDark ? "切换日间模式" : "切换夜间模式"}>{isDark ? <Sun size={18} /> : <Moon size={18} />}</button>
        <button onClick={() => setPinned(false)} aria-label="隐藏工具栏（H）" title="隐藏工具栏（H）" aria-keyshortcuts="H"><ChevronUp size={17} /><span>隐藏</span></button>
      </header>
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <button disabled={!ready} onClick={() => setOutlineOpen(!outlineOpen)} aria-label="文档目录" title="文档目录（Esc 关闭）" aria-expanded={outlineOpen}><List size={17} /><span>目录</span></button>
        <div className="pdf-control-group">
          <button disabled={!ready || page <= 1} onClick={() => void session.current?.goToPage(page - 1)} aria-label="上一页" title="上一页（← / PageUp）" aria-keyshortcuts="ArrowLeft PageUp"><ChevronLeft size={17} /></button>
          <form onSubmit={jump}><label className="pdf-sr-only" htmlFor="pdf-page">物理页码</label><input id="pdf-page" title="输入物理页码后按 Enter 跳转" type="number" min="1" max={count} value={pageInput} onChange={(event) => setPageInput(event.target.value)} disabled={!ready} /><span>/ {count}</span></form>
          <button disabled={!ready || page >= count} onClick={() => void session.current?.goToPage(page + 1)} aria-label="下一页" title="下一页（→ / PageDown）" aria-keyshortcuts="ArrowRight PageDown"><ChevronRight size={17} /></button>
        </div>
        <div className="pdf-control-group pdf-zoom-controls">
          <button disabled={!ready || scale <= .25} onClick={() => changeZoom(1 / 1.2)} aria-label="缩小" title="缩小（- / Ctrl+滚轮）"><Minus size={16} /></button>
          <select aria-label="缩放方式" title="缩放方式（适应宽度最多约 1000px）" value={zoomValue} disabled={!ready} onChange={(event) => session.current?.setZoom(event.target.value === "custom" ? scale : event.target.value as PdfZoom)}>
            <option value="page-width">适应宽度</option><option value="page-fit">适应页面</option><option value="custom">自定义</option>
          </select>
          <form onSubmit={(event) => { event.preventDefault(); const value = Number(customZoom); if (Number.isFinite(value) && value > 0) session.current?.setZoom(value / 100); }}>
            <input aria-label="自定义缩放百分比" title="输入缩放百分比后按 Enter 应用（25–500%）" type="number" min="25" max="500" value={customZoom} disabled={!ready} onChange={(event) => setCustomZoom(event.target.value)} /><span>%</span>
          </form>
          <button disabled={!ready || scale >= 5} onClick={() => changeZoom(1.2)} aria-label="放大" title="放大（+ / Ctrl+滚轮）"><Plus size={16} /></button>
        </div>
        <button disabled={!ready} onClick={() => session.current?.rotate()} aria-label={`旋转页面，当前 ${rotation} 度`} title={`顺时针旋转 90°（当前 ${rotation}°）`}><RotateCw size={17} /></button>
        <button disabled={!ready} onClick={() => searchOpen ? closeSearch() : openSearch()} aria-label="搜索文档" title="搜索文档（Ctrl+F 或 /）" aria-keyshortcuts="Control+f Meta+f /" aria-expanded={searchOpen}><Search size={17} /><span>搜索</span></button>
      </div>
      {searchOpen && <form className="pdf-search" role="search" onSubmit={(event) => { event.preventDefault(); searchNext(event.nativeEvent instanceof KeyboardEvent && event.nativeEvent.shiftKey); }}>
        <Search size={16} /><input ref={searchInput} aria-label="搜索文档文字" title="搜索文档文字（Enter 下一个，Shift+Enter 上一个，Esc 关闭）" placeholder="搜索文档文字" value={query} onChange={(event) => { setQuery(event.target.value); setMatch({ current: 0, total: 0, state: 3 }); session.current?.search(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); searchNext(true); } }} />
        <span role="status">{query ? (match.state === 3 ? "搜索中…" : match.total ? `${match.current} / ${match.total}` : "没有找到匹配文字") : "Ctrl+F"}</span>
        <button type="button" disabled={!query} onClick={() => searchNext(true)} aria-label="上一个结果" title="上一个结果（Shift+Enter）"><ChevronLeft size={16} /></button>
        <button type="submit" disabled={!query} aria-label="下一个结果" title="下一个结果（Enter）"><ChevronRight size={16} /></button>
        <button type="button" onClick={closeSearch} aria-label="关闭搜索" title="关闭搜索（Esc）"><X size={16} /></button>
      </form>}
      </div>
      {!toolsVisible && <div className="pdf-top-edge"><button className="pdf-toolbar-reveal" onClick={() => setPinned(true)} aria-label="显示并固定工具栏（H）" title="显示并固定工具栏（H）" aria-keyshortcuts="H" aria-controls="pdf-reader-controls" aria-expanded="false"><ChevronDown size={15} /></button></div>}
      <p className="pdf-toolbar-hint" data-show={toolbar.hint && !toolsVisible || undefined} role="status" aria-hidden={!toolbar.hint || toolsVisible}>移到顶部或按 H 显示工具栏</p>
      {storageError && <p className="pdf-notice" role="alert">本机存储空间不足，阅读位置未能保存。请释放空间后重试。</p>}
      {noText && <p className="pdf-notice" role="status">此页没有可提取的文字层，仍可原版阅读；当前不提供 OCR。</p>}
      {error && <p className="pdf-notice pdf-error" role="alert">{error}</p>}
      <div className="pdf-reader-body">
        {outlineOpen && <aside className="pdf-outline" aria-label="PDF 目录">
          <header><strong>文档目录</strong><button onClick={() => { setOutlineOpen(false); returnToBook(); }} aria-label="关闭目录" title="关闭目录（Esc）"><X size={17} /></button></header>
          {outline.length ? <nav><Outline items={outline} onChoose={(item) => { session.current?.navigateOutline(item); if (window.innerWidth < 760) setOutlineOpen(false); }} /></nav> : <p>这份 PDF 没有提供目录。可以通过物理页码跳转。</p>}
        </aside>}
        <div className="pdf-page-stage">
          {!ready && !error && <p className="pdf-loading" role="status">正在打开原 PDF…</p>}
          <div ref={container} className="pdf-viewport" data-fit-width={zoom === "page-width" || undefined} tabIndex={0} aria-label="PDF 原始页面"
            onPointerDown={touchStart} onPointerUp={touchEnd} onPointerCancel={() => { touch.current = undefined; }}><div ref={pages} className="pdfViewer" /></div>
        </div>
      </div>
      {ready && !toolsVisible && <span className="pdf-floating-page" aria-label={`第 ${page} 页，共 ${count} 页`}>{page} / {count}</span>}
    </main>
  );
}
