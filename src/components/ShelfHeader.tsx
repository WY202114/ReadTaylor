import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Book } from "../lib/books";
import type { BookshelfPreferences } from "./bookshelfPreferences";
import { BookCover } from "./BookCover";
import { ShelfSearch } from "./ShelfSearch";
import { ShelfToolbar } from "./ShelfToolbar";

interface ShelfHeaderProps {
  search: string;
  onSearch: (query: string) => void;
  count: number;
  preferences: BookshelfPreferences;
  onPreferencesChange: (preferences: BookshelfPreferences) => void;
  resumeBook?: Book;
  resumeMetadata: string;
  chapterTitle?: string;
  dateLabel: string;
  onOpen: (book: Book) => void;
}

export function ShelfHeader(props: ShelfHeaderProps) {
  const { resumeBook, resumeMetadata, chapterTitle, dateLabel, onOpen } = props;
  const header = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const element = header.current;
    const scroller = element?.closest<HTMLElement>(".library-main");
    if (!element || !scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.scrollTop;
      setScrolled(top > 2);
      // Different enter/leave thresholds prevent flicker near the switching point.
      setCompact((previous) => previous ? top > 8 : top > 40);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(() => {
      scroller.style.setProperty("--shelf-header-height", `${element.getBoundingClientRect().height + 12}px`);
    });
    observer.observe(element);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller.style.removeProperty("--shelf-header-height");
    };
  }, []);

  return <>
    <header ref={header} className="shelf-sticky-header" data-compact={compact || undefined} data-scrolled={scrolled || undefined} aria-label="书架搜索与阅读工具">
      <ShelfSearch search={props.search} onSearch={props.onSearch} />
      <ShelfToolbar count={props.count} search={props.search} preferences={props.preferences} onPreferencesChange={props.onPreferencesChange} />
      {resumeBook && <section className="shelf-resume" aria-label="继续上次的阅读">
        <button className="shelf-resume-cover" aria-label={`继续阅读 ${resumeBook.title}`} onClick={() => onOpen(resumeBook)}>
          <BookCover book={resumeBook} variant="shelf" style={{ width: "100%", height: "100%", borderRadius: "4px" }} />
        </button>
        <div className="shelf-resume-copy">
          <h2 title={resumeBook.title}>{resumeBook.title}</h2>
          <p className="shelf-resume-metadata" title={resumeMetadata}>
            <span>{resumeBook.author || "作者未知"}</span>
            {chapterTitle && <><span aria-hidden="true"> · </span><span>{chapterTitle}</span></>}
            {dateLabel && <><span aria-hidden="true"> · </span><time dateTime={new Date(resumeBook.lastReadAt!).toISOString()}>{dateLabel}</time></>}
          </p>
          <div className="shelf-resume-progress">
            <div className="progress-track" role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={resumeBook.progress}><span style={{ width: `${resumeBook.progress}%` }} /></div>
            <span>已读 {resumeBook.progress}%</span>
          </div>
        </div>
        <button className="primary-button shelf-resume-button" onClick={() => onOpen(resumeBook)}>继续阅读<ArrowUpRight size={17} aria-hidden="true" /></button>
      </section>}
    </header>
    {/* Equal and opposite heights keep scrollTop/content stable while the sticky bar shrinks.
        This must be a sibling: a short wrapper would limit the sticky header's travel. */}
    {resumeBook && <div className="shelf-header-spacer" data-compact={compact || undefined} aria-hidden="true" />}
  </>;
}
