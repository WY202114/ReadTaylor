export type PdfReadingMode = "original" | "reflow";
export type PdfZoom = "page-width" | "page-fit" | number;

export interface PdfMetadata {
  version: 1;
  sha256: string;
  sourceFileKey: string;
  pageCount: number;
  /** Physical pages, indexed from zero. False means no non-whitespace text. Not OCR. */
  pagesWithText: boolean[];
  readingMode: PdfReadingMode;
}

export interface PdfPosition {
  version: 1;
  sha256: string;
  pageNumber: number;
  /** PDF user-space coordinates, independent of CSS zoom and device pixels. */
  left: number;
  top: number;
  zoom: PdfZoom;
  rotation: number;
  progress: number;
  updatedAt: number;
}

/** Coordinate contract for future highlights. Client coordinates use the browser viewport. */
export interface PdfPageGeometry {
  pageNumber: number;
  element: HTMLDivElement;
  width: number;
  height: number;
  rotation: number;
  pdfBounds: number[];
  pdfToClient(x: number, y: number): [number, number];
  clientToPdf(x: number, y: number): [number, number];
  pdfRectToClient(rect: [number, number, number, number]): DOMRect;
}

export interface PdfPageAccess {
  getPageGeometry(pageNumber: number): Promise<PdfPageGeometry | null>;
  goToPage(pageNumber: number, point?: { x: number; y: number }): Promise<void>;
}
