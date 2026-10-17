import type { PdfPosition } from "./types";

const KEY = "readtaylor.pdf-positions.v1";

function read(): Record<string, PdfPosition> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function loadPdfPosition(bookId: string, sha256?: string): PdfPosition | undefined {
  const value = read()[bookId];
  if (!value || value.version !== 1 || (sha256 && value.sha256 !== sha256)
    || !Number.isInteger(value.pageNumber) || value.pageNumber < 1
    || !Number.isFinite(value.left) || !Number.isFinite(value.top)
    || ![0, 90, 180, 270].includes(value.rotation)
    || !(value.zoom === "page-width" || value.zoom === "page-fit"
      || (typeof value.zoom === "number" && value.zoom >= 0.25 && value.zoom <= 5))
    || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100
    || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return undefined;
  return value;
}

export function savePdfPosition(bookId: string, position: PdfPosition): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [bookId]: position }));
    return true;
  } catch { return false; }
}

export function deletePdfPosition(bookId: string): void {
  try {
    const positions = read();
    delete positions[bookId];
    localStorage.setItem(KEY, JSON.stringify(positions));
  } catch { /* Deletion must not prevent opening other books. */ }
}
