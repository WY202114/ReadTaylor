import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PdfMetadata, PdfReadingMode } from "./types";

export const pdfSourceFileKey = (bookId: string, sha256: string) => `pdf-source:${bookId}:${sha256}`;
export const pdfAssetUrl = (folder: string) => new URL(`./pdfjs/${folder}/`, document.baseURI).href;

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentLoadingTask> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  return pdfjs.getDocument({
    data, cMapUrl: pdfAssetUrl("cmaps"), cMapPacked: true,
    standardFontDataUrl: pdfAssetUrl("standard_fonts"),
    isEvalSupported: false, disableAutoFetch: true,
  });
}

export async function inspectPdf(
  file: File,
  bookId: string,
  readingMode: PdfReadingMode,
  onProgress?: (page: number, total: number) => void,
): Promise<{ metadata: PdfMetadata; title?: string; author?: string }> {
  const data = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const task = await loadPdf(data);
  // Password support needs its own UI. Fail clearly rather than leave import waiting forever.
  task.onPassword = () => { void task.destroy(); };
  try {
    const pdf = await task.promise;
    const pagesWithText: boolean[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      pagesWithText.push(text.items.some((item) => "str" in item && Boolean(item.str.trim())));
      page.cleanup();
      onProgress?.(pageNumber, pdf.numPages);
      // Import examines every page, but never renders page images or retains text bodies.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    const { info } = await pdf.getMetadata().catch(() => ({ info: undefined }));
    const properties = info as { Title?: string; Author?: string } | undefined;
    return {
      metadata: { version: 1, sha256, sourceFileKey: pdfSourceFileKey(bookId, sha256), pageCount: pdf.numPages, pagesWithText, readingMode },
      title: properties?.Title?.trim(), author: properties?.Author?.trim(),
    };
  } finally { await task.destroy(); }
}
