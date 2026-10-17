import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, List, Minus, Plus, RotateCw, Search, Sun, Moon, X } from "lucide-react";
import type { Book } from "../../lib/books";
import { PdfSession, type PdfOutlineItem } from "../../lib/pdf/session";
import type { PdfPageAccess, PdfPosition, PdfZoom } from "../../lib/pdf/types";
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
    <button style={{ paddingInlineStart: `${14 + Math.min(depth, 8) * 12}px` }} onClick={() => onChoose(item)}>{item.title || "未命名目录项"}</button>
    {item.items?.length > 0 && <Outline items={item.items} onChoose={onChoose} depth={depth + 1} />}
  </li>)}</ul>;
}

export function PdfReaderView({ book, isDark, onToggleDark, onBack, onPositionChange, onPageAccess }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const session = useRef<PdfSession>();
  const searchInput = useRef<HTMLInputElement>(null);
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
      }
      if (event.key === "Escape") { setOutlineOpen(false); setSearchOpen(false); session.current?.closeSearch(); }
      if (event.target instanceof HTMLElement && (event.target.matches("input, select, textarea, button") || event.target.isContentEditable)) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); void session.current?.goToPage(page + 1); }
      if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); void session.current?.goToPage(page - 1); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [page]);

  const jump = (event: FormEvent) => { event.preventDefault(); void session.current?.goToPage(Number(pageInput)); };
  const noText = book.pdf?.pagesWithText[page - 1] === false;
  const zoomValue = typeof zoom === "number" ? "custom" : zoom;
  const searchNext = (previous = false) => session.current?.search(query, true, previous);

  return (
    <main className="pdf-reader" aria-label={`原版阅读 ${book.title}`} data-source-sha256={book.pdf?.sha256}>
      <header className="pdf-reader-header">
        <button onClick={() => { session.current?.flush(); onBack(); }} aria-label="返回书架"><ArrowLeft size={18} /></button>
        <div className="pdf-reader-title"><h1 title={book.title}>{book.title}</h1><span>PDF 原版阅读 · 页面保持原色</span></div>
        <button onClick={onToggleDark} aria-label={isDark ? "切换日间模式" : "切换夜间模式"}>{isDark ? <Sun size={18} /> : <Moon size={18} />}</button>
      </header>
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <button disabled={!ready} onClick={() => setOutlineOpen(!outlineOpen)} aria-label="文档目录" aria-expanded={outlineOpen}><List size={17} /><span>目录</span></button>
        <div className="pdf-control-group">
          <button disabled={!ready || page <= 1} onClick={() => void session.current?.goToPage(page - 1)} aria-label="上一页"><ChevronLeft size={17} /></button>
          <form onSubmit={jump}><label className="pdf-sr-only" htmlFor="pdf-page">物理页码</label><input id="pdf-page" type="number" min="1" max={count} value={pageInput} onChange={(event) => setPageInput(event.target.value)} disabled={!ready} /><span>/ {count}</span></form>
          <button disabled={!ready || page >= count} onClick={() => void session.current?.goToPage(page + 1)} aria-label="下一页"><ChevronRight size={17} /></button>
        </div>
        <div className="pdf-control-group pdf-zoom-controls">
          <button disabled={!ready || scale <= .25} onClick={() => session.current?.setZoom(scale / 1.2)} aria-label="缩小"><Minus size={16} /></button>
          <select aria-label="缩放方式" value={zoomValue} disabled={!ready} onChange={(event) => session.current?.setZoom(event.target.value === "custom" ? scale : event.target.value as PdfZoom)}>
            <option value="page-width">适应宽度</option><option value="page-fit">适应页面</option><option value="custom">自定义</option>
          </select>
          <form onSubmit={(event) => { event.preventDefault(); const value = Number(customZoom); if (Number.isFinite(value) && value > 0) session.current?.setZoom(value / 100); }}>
            <input aria-label="自定义缩放百分比" type="number" min="25" max="500" value={customZoom} disabled={!ready} onChange={(event) => setCustomZoom(event.target.value)} /><span>%</span>
          </form>
          <button disabled={!ready || scale >= 5} onClick={() => session.current?.setZoom(scale * 1.2)} aria-label="放大"><Plus size={16} /></button>
        </div>
        <button disabled={!ready} onClick={() => session.current?.rotate()} aria-label={`旋转页面，当前 ${rotation} 度`}><RotateCw size={17} /></button>
        <button disabled={!ready} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) session.current?.closeSearch(); else requestAnimationFrame(() => searchInput.current?.focus()); }} aria-label="搜索文档" aria-expanded={searchOpen}><Search size={17} /><span>搜索</span></button>
      </div>
      {searchOpen && <form className="pdf-search" role="search" onSubmit={(event) => { event.preventDefault(); searchNext(event.nativeEvent instanceof KeyboardEvent && event.nativeEvent.shiftKey); }}>
        <Search size={16} /><input ref={searchInput} aria-label="搜索文档文字" placeholder="搜索文档文字" value={query} onChange={(event) => { setQuery(event.target.value); setMatch({ current: 0, total: 0, state: 3 }); session.current?.search(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); searchNext(true); } }} />
        <span role="status">{query ? (match.state === 3 ? "搜索中…" : match.total ? `${match.current} / ${match.total}` : "没有找到匹配文字") : "Ctrl+F"}</span>
        <button type="button" disabled={!query} onClick={() => searchNext(true)} aria-label="上一个结果"><ChevronLeft size={16} /></button>
        <button type="submit" disabled={!query} aria-label="下一个结果"><ChevronRight size={16} /></button>
        <button type="button" onClick={() => { setSearchOpen(false); session.current?.closeSearch(); }} aria-label="关闭搜索"><X size={16} /></button>
      </form>}
      {storageError && <p className="pdf-notice" role="alert">本机存储空间不足，阅读位置未能保存。请释放空间后重试。</p>}
      {noText && <p className="pdf-notice" role="status">此页没有可提取的文字层，仍可原版阅读；当前不提供 OCR。</p>}
      {error && <p className="pdf-notice pdf-error" role="alert">{error}</p>}
      <div className="pdf-reader-body">
        {outlineOpen && <aside className="pdf-outline" aria-label="PDF 目录">
          <header><strong>文档目录</strong><button onClick={() => setOutlineOpen(false)} aria-label="关闭目录"><X size={17} /></button></header>
          {outline.length ? <nav><Outline items={outline} onChoose={(item) => { session.current?.navigateOutline(item); if (window.innerWidth < 760) setOutlineOpen(false); }} /></nav> : <p>这份 PDF 没有提供目录。可以通过物理页码跳转。</p>}
        </aside>}
        <div className="pdf-page-stage">
          {!ready && !error && <p className="pdf-loading" role="status">正在打开原 PDF…</p>}
          <div ref={container} className="pdf-viewport" tabIndex={0} aria-label="PDF 原始页面"><div ref={pages} className="pdfViewer" /></div>
        </div>
      </div>
    </main>
  );
}
