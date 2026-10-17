import { AnnotationMode, AnnotationEditorType, type PDFDocumentProxy, type PDFDocumentLoadingTask } from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFPageView } from "pdfjs-dist/types/web/pdf_page_view";
import { getFile } from "../filestore";
import { loadPdf, pdfAssetUrl } from "./document";
import { loadPdfPosition, savePdfPosition } from "./position";
import type { Book } from "../books";
import type { PdfPageAccess, PdfPageGeometry, PdfPosition, PdfZoom } from "./types";

export interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  url?: string;
  items: PdfOutlineItem[];
}

interface Location { pageNumber: number; left: number; top: number }
interface Callbacks {
  ready: (pages: number, outline: PdfOutlineItem[]) => void;
  view: (page: number, zoom: PdfZoom, scale: number, rotation: number) => void;
  matches: (current: number, total: number, state?: number) => void;
  error: (message: string) => void;
  storageError: () => void;
  position: (position: PdfPosition) => void;
}

/** App-owned lifecycle around the installed Apache-2.0 PDF.js viewer, not reader code. */
export class PdfSession implements PdfPageAccess {
  readonly bus = new EventBus();
  readonly links = new PDFLinkService({ eventBus: this.bus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer", ignoreDestinationZoom: true });
  readonly find = new PDFFindController({ eventBus: this.bus, linkService: this.links });
  readonly viewer: PDFViewer;
  private lifetime = new AbortController();
  private task?: PDFDocumentLoadingTask;
  private pdf?: PDFDocumentProxy;
  private latest?: PdfPosition;
  private saveTimer?: number;
  private pruneFrame?: number;
  private resizeTimer?: number;
  private observer: ResizeObserver;
  private restored = false;
  private storageFailed = false;

  constructor(private book: Book, private container: HTMLDivElement, element: HTMLDivElement, private callbacks: Callbacks) {
    // v4.10 supports abortSignal at runtime; its shipped viewer type omits it.
    const options = {
      container, viewer: element, eventBus: this.bus, linkService: this.links,
      findController: this.find, textLayerMode: 1, annotationMode: AnnotationMode.ENABLE,
      annotationEditorMode: AnnotationEditorType.DISABLE,
      imageResourcesPath: pdfAssetUrl("images"), maxCanvasPixels: 8 * 1024 * 1024,
      abortSignal: this.lifetime.signal,
    };
    this.viewer = new PDFViewer(options);
    this.links.setViewer(this.viewer);
    this.on("updateviewarea", ({ location }: { location: Location }) => {
      if (!this.restored || !this.pdf) return;
      const page = this.pageView(location.pageNumber);
      const viewportY = page?.viewport.convertToViewportPoint(location.left, location.top)[1] ?? 0;
      const fraction = Math.min(1, Math.max(0, viewportY / (page?.viewport.height || 1)));
      const atEnd = container.scrollHeight - container.clientHeight - container.scrollTop < 3;
      const progress = atEnd ? 100 : ((location.pageNumber - 1 + fraction) / this.pdf.numPages) * 100;
      this.latest = {
        version: 1, sha256: book.pdf!.sha256, pageNumber: location.pageNumber,
        left: location.left, top: location.top, zoom: this.zoom, rotation: this.viewer.pagesRotation,
        progress: Math.round(progress * 10) / 10, updatedAt: Date.now(),
      };
      this.callbacks.view(this.viewer.currentPageNumber, this.zoom, this.viewer.currentScale, this.viewer.pagesRotation);
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.flush(), 250);
      this.schedulePrune();
    });
    this.on("pagerendered", ({ error }: { error?: Error }) => {
      if (error) callbacks.error("此页渲染失败，请重新打开文件或尝试其他缩放比例。");
      this.schedulePrune();
    });
    this.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => callbacks.matches(matchesCount.current, matchesCount.total));
    this.on("updatefindcontrolstate", ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => callbacks.matches(matchesCount.current, matchesCount.total, state));
    window.addEventListener("pagehide", this.flush, { signal: this.lifetime.signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.flush(); }, { signal: this.lifetime.signal });
    this.observer = new ResizeObserver(() => {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.restored && typeof this.zoom === "string") this.viewer.currentScaleValue = this.zoom;
      }, 100);
    });
    this.observer.observe(container);
  }

  private on(name: string, handler: Function) { this.bus.on(name, handler, { signal: this.lifetime.signal }); }
  private pageView(pageNumber: number): PDFPageView | undefined { return this.viewer.getPageView(pageNumber - 1); }
  get pageNumber() { return this.viewer.currentPageNumber; }
  get pageCount() { return this.pdf?.numPages || 0; }
  get zoom(): PdfZoom {
    const value = this.viewer.currentScaleValue;
    return value === "page-fit" || value === "page-width" ? value : this.viewer.currentScale;
  }

  async open(): Promise<void> {
    const source = this.book.pdf;
    if (!source) throw new Error("请重新导入原文件以使用原版阅读。");
    const file = await getFile(source.sourceFileKey);
    if (!file) throw new Error("原 PDF 文件不可用，请重新导入原文件。浏览器清理数据也会删除本机文件。");
    if (this.lifetime.signal.aborted) return;
    const data = await file.arrayBuffer();
    if (this.lifetime.signal.aborted) return;
    const task = await loadPdf(data);
    this.task = task;
    if (this.lifetime.signal.aborted) { await task.destroy(); return; }
    task.onPassword = () => { this.callbacks.error("暂不支持加密 PDF，请先提供未加密的原文件。"); void task.destroy(); };
    const pdf = await task.promise;
    if (this.lifetime.signal.aborted) return;
    this.pdf = pdf;
    await pdf.getPage(1);
    if (this.lifetime.signal.aborted) return;
    this.links.setDocument(pdf);
    const initialized = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("PDF 页面初始化超时，请重新打开文件。")), 30000);
      const finish = () => { window.clearTimeout(timeout); resolve(); };
      this.bus.on("pagesinit", finish, { once: true, signal: this.lifetime.signal });
      this.lifetime.signal.addEventListener("abort", finish, { once: true });
    });
    this.viewer.setDocument(pdf);
    await initialized;
    if (this.lifetime.signal.aborted) return;
    const position = loadPdfPosition(this.book.id, source.sha256);
    this.viewer.pagesRotation = position?.rotation || 0;
    this.viewer.currentScaleValue = String(position?.zoom || "page-width");
    await this.goToPage(Math.min(position?.pageNumber || 1, pdf.numPages), position ? { x: position.left, y: position.top } : undefined);
    if (this.lifetime.signal.aborted) return;
    this.restored = true;
    this.viewer.update();
    this.callbacks.ready(pdf.numPages, []);
    void pdf.getOutline().then((outline) => {
      if (!this.lifetime.signal.aborted) this.callbacks.ready(pdf.numPages, (outline || []) as PdfOutlineItem[]);
    }).catch(() => { /* Missing/malformed outlines must not prevent reading. */ });
  }

  setZoom(value: PdfZoom) { this.viewer.currentScaleValue = String(typeof value === "number" ? Math.max(0.25, Math.min(5, value)) : value); }
  rotate() { this.viewer.pagesRotation = (this.viewer.pagesRotation + 90) % 360; }

  async goToPage(pageNumber: number, point?: { x: number; y: number }): Promise<void> {
    if (!this.pdf || !Number.isFinite(pageNumber)) return;
    const number = Math.max(1, Math.min(this.pdf.numPages, Math.trunc(pageNumber)));
    let pdfPage;
    try { pdfPage = await this.pdf.getPage(number); }
    catch { if (!this.lifetime.signal.aborted) this.callbacks.error("无法打开此页，请尝试其他页码或重新导入文件。"); return; }
    if (this.lifetime.signal.aborted) return;
    const page = this.pageView(number);
    if (page && !page.pdfPage) page.setPdfPage(pdfPage);
    if (point) this.viewer.scrollPageIntoView({ pageNumber: number, destArray: [null, { name: "XYZ" }, point.x, point.y, null], allowNegativeOffset: true, ignoreDestinationZoom: true });
    else this.viewer.currentPageNumber = number;
    this.viewer.update();
  }

  navigateOutline(item: PdfOutlineItem) {
    if (item.dest) void this.links.goToDestination(item.dest).catch(() => {
      if (!this.lifetime.signal.aborted) this.callbacks.error("这条目录的目标位置无效，可以改用物理页码跳转。");
    });
    else if (item.url && /^https?:\/\//i.test(item.url)) window.open(item.url, "_blank", "noopener,noreferrer");
  }

  search(query: string, again = false, previous = false) {
    if (!query) { this.bus.dispatch("findbarclose", { source: this }); this.callbacks.matches(0, 0); return; }
    this.bus.dispatch("find", { source: this, type: again ? "again" : "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }
  closeSearch() { this.search(""); }

  async getPageGeometry(pageNumber: number): Promise<PdfPageGeometry | null> {
    if (!this.pdf || pageNumber < 1 || pageNumber > this.pdf.numPages) return null;
    const pdfPage = await this.pdf.getPage(pageNumber);
    if (this.lifetime.signal.aborted) return null;
    const page = this.pageView(pageNumber);
    if (!page) return null;
    if (!page.pdfPage) page.setPdfPage(pdfPage);
    const pdfToClient = (x: number, y: number): [number, number] => {
      const [vx, vy] = page.viewport.convertToViewportPoint(x, y);
      const rect = page.div.getBoundingClientRect();
      return [rect.left + page.div.clientLeft + vx, rect.top + page.div.clientTop + vy];
    };
    return {
      pageNumber, element: page.div, width: page.viewport.width, height: page.viewport.height,
      rotation: page.viewport.rotation, pdfBounds: [...pdfPage.view], pdfToClient,
      clientToPdf(x, y) {
        const rect = page.div.getBoundingClientRect();
        return page.viewport.convertToPdfPoint(x - rect.left - page.div.clientLeft, y - rect.top - page.div.clientTop) as [number, number];
      },
      pdfRectToClient(rect) {
        const a = pdfToClient(rect[0], rect[1]);
        const b = pdfToClient(rect[2], rect[3]);
        return new DOMRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      },
    };
  }

  private schedulePrune() {
    if (this.pruneFrame !== undefined) return;
    this.pruneFrame = requestAnimationFrame(() => {
      this.pruneFrame = undefined;
      const area = this.container.getBoundingClientRect();
      // Keep visible pages and one viewport ahead/behind; reset distant canvases/text layers.
      for (const page of this.viewer.getCachedPageViews() as Set<PDFPageView>) {
        const rect = page.div.getBoundingClientRect();
        if (rect.bottom < area.top - area.height || rect.top > area.bottom + area.height) page.reset();
      }
    });
  }

  flush = () => {
    window.clearTimeout(this.saveTimer);
    if (!this.latest) return;
    const saved = savePdfPosition(this.book.id, this.latest);
    this.callbacks.position(this.latest);
    if (!saved && !this.storageFailed) { this.storageFailed = true; this.callbacks.storageError(); }
  };

  destroy() {
    this.flush();
    this.lifetime.abort();
    this.observer.disconnect();
    window.clearTimeout(this.resizeTimer);
    if (this.pruneFrame !== undefined) cancelAnimationFrame(this.pruneFrame);
    if (this.viewer.renderingQueue?.idleTimeout) clearTimeout(this.viewer.renderingQueue.idleTimeout);
    this.viewer.setDocument(null as unknown as PDFDocumentProxy);
    this.links.setDocument(null);
    void this.task?.destroy().catch(() => undefined);
  }
}
