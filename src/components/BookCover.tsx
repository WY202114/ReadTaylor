import { useEffect, useState, type CSSProperties } from "react";
import type { Book } from "../lib/books";
import { shade } from "../lib/books";
import { loadBookCover } from "../lib/epubCover";

interface BookCoverProps {
  book: Pick<Book, "id" | "title" | "color" | "fileType">;
  style?: CSSProperties;
  dimmed?: boolean;
}

export function BookCover({ book, style, dimmed }: BookCoverProps) {
  const [coverUrl, setCoverUrl] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setCoverUrl("");
    void loadBookCover(book.id).then((cover) => {
      if (!active || !cover) return;
      objectUrl = URL.createObjectURL(cover);
      setCoverUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [book.id]);

  return (
    <div
      style={{
        background: `linear-gradient(150deg, ${book.color}, ${shade(book.color, 0.62)})`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "10px 11px",
        overflow: "hidden",
        position: "relative",
        opacity: dimmed ? 0.7 : 1,
        ...style,
      }}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt={`《${book.title}》封面`}
          onError={() => setCoverUrl("")}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "var(--card)",
          }}
        />
      ) : (
        <>
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "8px",
              letterSpacing: "1.5px",
              fontWeight: 600,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            {book.fileType}
          </span>
          <span
            style={{
              fontFamily: "Lora, serif",
              fontSize: "13px",
              fontWeight: 600,
              color: "#fff",
              lineHeight: 1.3,
              textShadow: "0 1px 3px rgba(0,0,0,0.25)",
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {book.title}
          </span>
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "6px",
              width: "2px",
              background: "rgba(255,255,255,0.18)",
            }}
          />
        </>
      )}
    </div>
  );
}
