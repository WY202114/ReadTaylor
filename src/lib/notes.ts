export type NoteColor = "yellow" | "orange" | "red" | "blue" | "green";

export interface ReadingNote {
  id: string;
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  quote: string;
  body: string;
  color?: NoteColor;
  startOffset?: number;
  endOffset?: number;
  pageIndex?: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "readtaylor.notes.v1";

function loadAllNotes(): ReadingNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ReadingNote[] : [];
  } catch {
    return [];
  }
}

export function loadNotes(bookId: string): ReadingNote[] {
  return loadAllNotes()
    .filter((note) => note.bookId === bookId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveNotes(bookId: string, notes: ReadingNote[]): boolean {
  try {
    const otherBooks = loadAllNotes().filter((note) => note.bookId !== bookId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...otherBooks, ...notes]));
    return true;
  } catch {
    return false;
  }
}

export function deleteNotesForBook(bookId: string): void {
  try {
    const remaining = loadAllNotes().filter((note) => note.bookId !== bookId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // 删除书籍不应因清理笔记失败而中断。
  }
}
