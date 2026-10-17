import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, MoreHorizontal, Trash2 } from "lucide-react";
import type { Book } from "../lib/books";
import { BookCover } from "./BookCover";

interface ShelfBookCardProps {
  book: Book;
  onOpen: () => void;
  onRemove: () => void;
  view?: "grid" | "list";
}

export function ShelfBookCard({ book, onOpen, onRemove, view = "grid" }: ShelfBookCardProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const progress = Math.min(100, Math.max(0, book.progress));

  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !card.current?.contains(event.target)) {
        setMoreOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);

  const moreAction = (
    <button
      ref={moreButton}
      className="shelf-book-more"
      onClick={() => setMoreOpen((open) => !open)}
      aria-label={`更多操作 ${book.title}`}
      aria-expanded={moreOpen}
      aria-controls={menuId}
    >
      <MoreHorizontal size={14} aria-hidden="true" /><span>更多</span>
    </button>
  );
  const moreMenu = moreOpen && (
    <div className="shelf-book-menu" id={menuId} role="group" aria-label="书籍操作">
      <button onClick={() => { setMoreOpen(false); onRemove(); }}>
        <Trash2 size={14} aria-hidden="true" />从书架移除
      </button>
    </div>
  );

  return (
    <article
      ref={card}
      className={`shelf-book shelf-book-card${view === "list" ? " shelf-book-card--list" : ""}`}
      data-more-open={moreOpen || undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMoreOpen(false);
      }}
    >
      <div className="shelf-book-cover">
        <button className="shelf-cover-open" onClick={onOpen} aria-label={`阅读 ${book.title}`}>
          <BookCover book={book} variant="shelf" />
        </button>
        {view === "grid" && <>
          <span className="shelf-book-format">{book.fileType}</span>
          <div className="shelf-book-actions">
            <button className="shelf-book-continue" onClick={onOpen} aria-label={`继续阅读 ${book.title}`}>
              <BookOpen size={14} aria-hidden="true" />继续阅读
            </button>
            {moreAction}
          </div>
          {moreMenu}
        </>}
      </div>
      <div className="shelf-book-progress" aria-label={`已读 ${progress}%`}>
        <div className="progress-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
        <span>已读 {progress}%</span>
      </div>
      <button className="book-open shelf-book-title" onClick={onOpen} title={book.title}>
        <h3>{book.title}</h3>
      </button>
      <p className="shelf-book-author" title={book.author}>{book.author || "作者未知"}</p>
      <span className="shelf-book-chapters">{book.chapters.length} 章</span>
      {view === "list" && <div className="shelf-list-actions">{moreAction}{moreMenu}</div>}
    </article>
  );
}
