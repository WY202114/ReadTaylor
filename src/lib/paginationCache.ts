import type { Book } from "./books";

interface PaginationCacheEntry {
  bookId: string;
  bookSignature: string;
  width: number;
  height: number;
  fontSize: number;
  pageCounts: number[];
  updatedAt: number;
}

const STORAGE_KEY = "readtaylor.pagination.v1";
const MAX_CACHE_ENTRIES = 24;

function bookSignature(book: Book): string {
  return [
    book.layout || "reflowable",
    ...book.chapters.map((chapter) => `${chapter.id}:${chapter.href || ""}`),
  ].join("|");
}

function loadEntries(): PaginationCacheEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed as PaginationCacheEntry[] : [];
  } catch {
    return [];
  }
}

export function loadPaginationCache(
  book: Book,
  width: number,
  height: number,
  fontSize: number
): number[] | null {
  const signature = bookSignature(book);
  const entry = loadEntries().find((item) => (
    item.bookId === book.id
    && item.bookSignature === signature
    && item.width === width
    && item.height === height
    && item.fontSize === fontSize
    && item.pageCounts.length === book.chapters.length
    && item.pageCounts.every((count) => Number.isInteger(count) && count > 0)
  ));
  return entry ? [...entry.pageCounts] : null;
}

export function savePaginationCache(
  book: Book,
  width: number,
  height: number,
  fontSize: number,
  pageCounts: number[]
): void {
  if (!width || !height || pageCounts.length !== book.chapters.length) return;
  if (!pageCounts.every((count) => Number.isInteger(count) && count > 0)) return;

  try {
    const signature = bookSignature(book);
    const remaining = loadEntries().filter((entry) => !(
      entry.bookId === book.id
      && entry.bookSignature === signature
      && entry.width === width
      && entry.height === height
      && entry.fontSize === fontSize
    ));
    const next: PaginationCacheEntry = {
      bookId: book.id,
      bookSignature: signature,
      width,
      height,
      fontSize,
      pageCounts,
      updatedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([next, ...remaining].slice(0, MAX_CACHE_ENTRIES)));
  } catch {
    // 缓存失败只会触发下次重新计算，不应影响正常阅读。
  }
}

export function deletePaginationCacheForBook(bookId: string): void {
  try {
    const remaining = loadEntries().filter((entry) => entry.bookId !== bookId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // 删除书籍不应因清理分页缓存失败而中断。
  }
}
