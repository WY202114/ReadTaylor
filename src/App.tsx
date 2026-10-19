import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ReaderView } from "./components/ReaderView";
import { ShelfBookCard } from "./components/ShelfBookCard";
import { ShelfHeader } from "./components/ShelfHeader";
import { LibraryNavigation } from "./components/LibraryNavigation";
import { TranslationSettings } from "./components/TranslationSettings";
import { loadBookshelfPreferences, saveBookshelfPreferences } from "./components/bookshelfPreferences";
import {
  BookOpen,
  ArrowUpRight,
  ShieldCheck,
  Upload,
  Plus,
} from "lucide-react";
import {
  bookFromFile,
  deleteReadingPosition,
  loadBooks,
  saveBooks,
  saveReadingPosition,
  type Book,
} from "./lib/books";
import { delFile } from "./lib/filestore";
import { deleteNotesForBook, loadNotes } from "./lib/notes";
import { deletePaginationCacheForBook } from "./lib/paginationCache";
import { deleteBookPreferences } from "./lib/readerPreferences";
import { coverFileKey } from "./lib/epubCover";
import { PdfImportDialog } from "./components/pdf/PdfImportDialog";
import { deletePdfPosition, loadPdfPosition } from "./lib/pdf/position";
import type { PdfPosition, PdfReadingMode } from "./lib/pdf/types";
import {
  desktopJobId,
  isDesktopApp,
  pickDesktopBooks,
  prepareDesktopBook,
} from "./lib/desktop";
import {
  archiveToFixedLayoutEPUB,
} from "./lib/fixedLayoutEpub";

const PdfReaderView = lazy(() => import("./components/pdf/PdfReaderView").then((module) => ({ default: module.PdfReaderView })));

const APP_VERSION = "3.0.2";

type Tab = "library" | "profile";

function lastReadDateLabel(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now()) return "";
  const date = new Date(timestamp);
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

export default function App() {
  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("library");
  const [books, setBooks] = useState<Book[]>(() => loadBooks());
  const [readingBook, setReadingBook] = useState<Book | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [shelfPreferences, setShelfPreferences] = useState(loadBookshelfPreferences);
  const [toast, setToast] = useState("");
  const [toolchain, setToolchain] = useState<DesktopToolchainStatus | null>(null);
  const booksRef = useRef(books);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const activeDesktopJob = useRef("");
  const [pdfImportName, setPdfImportName] = useState<string | null>(null);
  const pdfChoice = useRef<((mode: PdfReadingMode | null) => void) | null>(null);
  const importing = useRef(false);
  const pdfLivePosition = useRef<PdfPosition>();
  const desktopImportHandler = useRef<(refs: DesktopBookReference[]) => Promise<void>>(
    async () => undefined
  );

  useEffect(() => {
    booksRef.current = books;
    saveBooks(books);
  }, [books]);

  useEffect(() => {
    saveBookshelfPreferences(shelfPreferences);
  }, [shelfPreferences]);

  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  };

  // 不会自动消失的提示（用于「解析中…」这类需要等待的场景）
  const stick = (msg: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(msg);
  };

  useEffect(() => {
    const desktop = window.readTaylorDesktop;
    if (!desktop) return;
    void desktop.getToolchain().then(setToolchain);
    const stopProgress = desktop.onConversionProgress((update) => {
      if (update.jobId === activeDesktopJob.current) stick(update.message);
    });
    const stopOpenBooks = desktop.onOpenBooks((refs) => {
      void desktopImportHandler.current(refs);
    });
    return () => {
      stopProgress();
      stopOpenBooks();
    };
  }, []);

  const filteredBooks = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const selected = books.filter((book) => {
      const matchesSearch = book.title.toLocaleLowerCase().includes(query) || book.author.toLocaleLowerCase().includes(query);
      const matchesStatus = shelfPreferences.status === "all"
        || (shelfPreferences.status === "reading" && book.progress > 0 && book.progress < 100)
        || (shelfPreferences.status === "unread" && book.progress <= 0)
        || (shelfPreferences.status === "finished" && book.progress >= 100);
      return matchesSearch && matchesStatus;
    });
    const byTitle = (a: Book, b: Book) => a.title.localeCompare(b.title, "zh-CN", { numeric: true, sensitivity: "base" });
    // filter 返回新数组，排序不会改变原始书库或继续阅读的选择。
    return selected.sort((a, b) => {
      if (shelfPreferences.sort === "title") return byTitle(a, b) || b.addedAt - a.addedAt;
      if (shelfPreferences.sort === "recent") {
        const recent = (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0);
        if (recent) return recent;
      }
      return b.addedAt - a.addedAt || byTitle(a, b);
    });
  }, [books, searchQuery, shelfPreferences.status, shelfPreferences.sort]);
  // TODO: 阅读足迹将来放到个人中心（profile）页面；保留以下统计逻辑，书架页不再渲染。
  // TODO: 接入真实阅读会话统计后计算时长和连续天数；lastReadAt 不能推导这两项。
  const todayReadingMinutes = 0;
  const consecutiveReadingDays = 0;
  const noteCount = useMemo(() => books.reduce((total, book) => total + loadNotes(book.id).length, 0), [books]);
  const readingBooks = books.filter((b) => b.progress > 0 && b.progress < 100);
  const continueReadingBook = readingBooks.reduce<Book | undefined>((latest, book) => {
    if (!latest) return book;
    return (book.lastReadAt ?? 0) > (latest.lastReadAt ?? 0) ? book : latest;
  }, undefined);
  // TODO: 旧数据若缺少章节标题或 lastReadAt，等现有流程补齐后再展示；不以导入时间代替阅读时间。
  const continueChapterTitle = continueReadingBook?.mode === "pdf"
    ? `第 ${loadPdfPosition(continueReadingBook.id, continueReadingBook.pdf?.sha256)?.pageNumber || 1} 页`
    : continueReadingBook?.chapters[continueReadingBook.lastChapter]?.title?.trim();
  const continueDateLabel = lastReadDateLabel(continueReadingBook?.lastReadAt);
  const continueMetadata = [continueReadingBook?.author || "作者未知", continueChapterTitle, continueDateLabel].filter(Boolean).join(" · ");
  const finishedBooks = books.filter((b) => b.progress >= 100);
  const desktopMode = isDesktopApp();
  const supportedFormatLabel = desktopMode
    ? "EPUB / MOBI / AZW / AZW3 / CBZ / CBR / ZIP / PDF / TXT / MD"
    : "TXT / MD / PDF / EPUB / CBZ / ZIP";

  const addImportedBooks = (imported: Book[]): boolean => {
    if (!imported.length) return false;
    const importedSourceKeys = new Set(
      imported.map((book) => book.sourceKey).filter((key): key is string => Boolean(key))
    );
    const retained = booksRef.current.filter(
      (book) => !book.sourceKey || !importedSourceKeys.has(book.sourceKey)
    );
    const next = [...imported].reverse().concat(retained);
    if (!saveBooks(next)) return false;
    for (const replacement of imported) {
      const old = booksRef.current.find((book) => book.id === replacement.id);
      if (old?.pdf && old.pdf.sourceFileKey !== replacement.pdf?.sourceFileKey) void delFile(old.pdf.sourceFileKey);
    }
    booksRef.current = next;
    setBooks(next);
    return true;
  };

  const choosePdfMode = (name: string) => new Promise<PdfReadingMode | null>((resolve) => {
    pdfChoice.current = resolve;
    setPdfImportName(name);
  });
  const finishPdfChoice = (mode: PdfReadingMode | null) => {
    setPdfImportName(null);
    pdfChoice.current?.(mode);
    pdfChoice.current = null;
  };
  const importDialog = pdfImportName !== null && <PdfImportDialog name={pdfImportName} onChoose={finishPdfChoice} />;

  const importBrowserFiles = async (files: File[]) => {
    if (importing.current) return;
    importing.current = true;
    try {
      const pdfs = files.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
      const pdfMode = pdfs.length ? await choosePdfMode(pdfs.length === 1 ? pdfs[0].name : `${pdfs.length} 份 PDF 使用同一种阅读方式`) : undefined;
      if (pdfMode === null) return;
      const imported: Book[] = [];
      const errors: string[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const isPdf = ext === "pdf" || file.type === "application/pdf";
        // A different mode creates a separate book. Legacy books are never overwritten.
        const sourceKey = `browser:${file.name}:${file.size}:${file.lastModified}${isPdf ? `:pdf:${pdfMode}` : ""}`;
        const existing = booksRef.current.find((book) => book.sourceKey === sourceKey);
        stick(`正在解析 ${file.name}${files.length > 1 ? `（${index + 1}/${files.length}）` : ""}…`);
        const { book, error } = await bookFromFile(file, { sourceKey, id: existing?.id, pdfMode: pdfMode || undefined,
          onPdfProgress: (page, total) => stick(`正在检查文字层 ${page}/${total}：${file.name}`),
        });
        if (book) {
          if (existing && (!book.pdf || existing.pdf?.sha256 === book.pdf.sha256)) {
            book.progress = existing.progress;
            book.lastChapter = Math.min(existing.lastChapter, Math.max(0, book.chapters.length - 1));
            book.lastScroll = existing.lastScroll || 0;
            book.lastReadAt = existing.lastReadAt;
          }
          imported.push(book);
        }
        if (error) errors.push(`${file.name}：${error}`);
        if (ext === "pdf") await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (imported.length && !addImportedBooks(imported)) {
        flash("本地存储空间不足，未能把书籍加入书架。");
        return;
      }
      if (errors.length) {
        flash(imported.length ? `已导入 ${imported.length} 本，另有 ${errors.length} 本失败。` : errors[0]);
      } else if (imported.length) {
        flash(`已导入 ${imported.length} 本书，所有内容都保存在本机。`);
      }
    } finally { importing.current = false; }
  };

  const importDesktopReferences = async (references: DesktopBookReference[]) => {
    if (!references.length) return;
    if (importing.current) return;
    importing.current = true;
    try {
      const pdfs = references.filter((reference) => /\.pdf$/i.test(reference.name));
      const pdfMode = pdfs.length ? await choosePdfMode(pdfs.length === 1 ? pdfs[0].name : `${pdfs.length} 份 PDF 使用同一种阅读方式`) : undefined;
      if (pdfMode === null) return;
      const imported: Book[] = [];
      const errors: string[] = [];
      let convertedCount = 0;
      for (let index = 0; index < references.length; index++) {
        const reference = references[index];
        const jobId = desktopJobId();
        activeDesktopJob.current = jobId;
        stick(`正在处理 ${reference.name}${references.length > 1 ? `（${index + 1}/${references.length}）` : ""}…`);
        try {
          const prepared = await prepareDesktopBook(reference, jobId);
          let readableFile = prepared.file;
          let convertedLocally = prepared.converted;
          if (prepared.sourceExtension === "cbz" || prepared.sourceExtension === "zip") {
            readableFile = await archiveToFixedLayoutEPUB(prepared.file, (update) => stick(update.message));
            convertedLocally = true;
          }
          const sourceKey = `${reference.sourceKey}${prepared.sourceExtension === "pdf" ? `:pdf:${pdfMode}` : ""}`;
          const existing = booksRef.current.find((book) => book.sourceKey === sourceKey);
          const { book, error } = await bookFromFile(readableFile, {
            sourceKey,
            id: existing?.id,
            pdfMode: pdfMode || undefined,
            onPdfProgress: (page, total) => stick(`正在检查文字层 ${page}/${total}：${reference.name}`),
          });
          if (error || !book) throw new Error(error || "无法读取转换后的 EPUB。");
          if (existing && (!book.pdf || existing.pdf?.sha256 === book.pdf.sha256)) {
            book.progress = existing.progress;
            book.lastChapter = Math.min(existing.lastChapter, Math.max(0, book.chapters.length - 1));
            book.lastScroll = existing.lastScroll || 0;
            book.lastReadAt = existing.lastReadAt;
          }
          if (convertedLocally) {
            book.fileType = prepared.sourceExtension.toUpperCase();
            convertedCount += 1;
          }
          imported.push(book);
        } catch (error) {
          errors.push(`${reference.name}：${error instanceof Error ? error.message : "导入失败"}`);
        }
      }
      activeDesktopJob.current = "";
      if (imported.length && !addImportedBooks(imported)) {
        flash("本地存储空间不足，未能把转换后的书籍加入书架。");
        return;
      }
      if (errors.length) {
        console.error("部分桌面书籍导入失败", errors);
        flash(imported.length ? `已导入 ${imported.length} 本，另有 ${errors.length} 本失败。` : errors[0]);
      } else {
        flash(`已导入 ${imported.length} 本书。${convertedCount ? "转换已在本机完成。" : ""}`);
      }
      if (window.readTaylorDesktop) {
        void window.readTaylorDesktop.getToolchain().then(setToolchain);
      }
    } finally { importing.current = false; activeDesktopJob.current = ""; }
  };
  desktopImportHandler.current = importDesktopReferences;

  const pickFile = async () => {
    if (isDesktopApp()) {
      await importDesktopReferences(await pickDesktopBooks());
    } else {
      fileInputRef.current?.click();
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // 允许重复选同一文件
    if (files.length) await importBrowserFiles(files);
  };

  const deleteBook = (id: string, title: string) => {
    if (!window.confirm(`从书架移除《${title}》？文件本就只在本地，移除后需重新上传。`)) return;
    const book = booksRef.current.find((item) => item.id === id);
    if (book?.pdf) void delFile(book.pdf.sourceFileKey);
    deletePdfPosition(id);
    setBooks((prev) => prev.filter((b) => b.id !== id));
    delFile(id); // 清掉 IndexedDB 里的原始文件（EPUB 原版渲染用）
    delFile(coverFileKey(id));
    deleteNotesForBook(id);
    deletePaginationCacheForBook(id);
    deleteBookPreferences(id);
    deleteReadingPosition(id);
  };

  const openBook = (book: Book) => { pdfLivePosition.current = undefined; setReadingBook({ ...book, lastReadAt: Date.now() }); };

  const persistReadingPosition = useCallback((lastChapterIndex: number, lastScroll: number, lastPage: Book["lastPage"] | undefined, overallProgress: number) => {
    if (!readingBook) return;
    saveReadingPosition(
      readingBook.id,
      lastChapterIndex,
      lastScroll,
      readingBook.chapters.length,
      lastPage,
      overallProgress
    );
  }, [readingBook]);

  const closeReader = (lastChapterIndex: number, lastScroll: number, lastPage: Book["lastPage"] | undefined, overallProgress: number) => {
    if (readingBook) {
      const progress = Math.round(Math.min(1, Math.max(0, overallProgress)) * 1000) / 10;
      setBooks((prev) =>
        prev.map((b) =>
          b.id === readingBook.id
            ? { ...b, lastChapter: lastChapterIndex, lastScroll, lastPage, progress, lastReadAt: Date.now() }
            : b
        )
      );
    }
    setReadingBook(null);
  };

  if (readingBook) {
    return (
      <div className={isDark ? "dark" : ""} style={{ background: "var(--background)" }}>
        <div style={{ width: "100%", height: "100dvh", overflow: "hidden", position: "relative" }}>
          {readingBook.mode === "pdf" ? <Suspense fallback={<p className="pdf-notice">正在打开 PDF 阅读器…</p>}>
            <PdfReaderView book={readingBook} isDark={isDark} onToggleDark={() => setIsDark((d) => !d)}
              onPositionChange={(position) => { pdfLivePosition.current = position; }}
              onBack={() => {
                const position = pdfLivePosition.current;
                setBooks((previous) => previous.map((book) => book.id === readingBook.id
                  ? { ...book, progress: position?.progress ?? book.progress, lastReadAt: position?.updatedAt ?? Date.now() } : book));
                setReadingBook(null);
              }} />
          </Suspense> : <ReaderView
            book={readingBook}
            onBack={closeReader}
            onPositionChange={persistReadingPosition}
            isDark={isDark}
            onToggleDark={() => setIsDark((d) => !d)}
          />}
          {importDialog}
        </div>
      </div>
    );
  }

  return (
    <div className={`library-shell${isDark ? " dark" : ""}`}>
      {importDialog}
      <input ref={fileInputRef} type="file" accept=".txt,.md,.epub,.pdf,.cbz,.zip,text/plain" multiple hidden onChange={onFileChange} />
      <LibraryNavigation activeTab={activeTab} onNavigate={setActiveTab} bookCount={books.length} isDark={isDark} onToggleDark={() => setIsDark((value) => !value)} version={APP_VERSION} />
      <main className={`library-main${activeTab === "library" ? " library-main--shelf" : ""}`}>
        <AnimatePresence mode="wait">
          {activeTab === "library" ? (
            <motion.div key="library" className="library-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <h1 className="sr-only">我的书架</h1>
              <ShelfHeader search={searchQuery} onSearch={setSearchQuery} count={filteredBooks.length}
                preferences={shelfPreferences} onPreferencesChange={setShelfPreferences}
                resumeBook={continueReadingBook} resumeMetadata={continueMetadata} chapterTitle={continueChapterTitle}
                dateLabel={continueDateLabel} onOpen={openBook} />
              <section className="shelf-section" aria-label="全部书籍">
                {books.length === 0 && !searchQuery.trim() ? <div className="shelf-empty"><span className="empty-icon"><BookOpen size={27} /></span><h3>好故事，等你放上书架</h3><p>导入你的电子书，随时阅读、翻译和记录想法。</p><button className="primary-button" onClick={pickFile}><Upload size={16} />导入第一本书</button><small>支持 {supportedFormatLabel}</small></div> : <>
                  {filteredBooks.length > 0 ? <div className={shelfPreferences.view === "grid" ? "library-book-grid" : "library-book-list"}>{filteredBooks.map((book) => (
                    <ShelfBookCard key={book.id} book={book} view={shelfPreferences.view} onOpen={() => openBook(book)} onRemove={() => deleteBook(book.id, book.title)} />
                  ))}
                    <button className="shelf-import-card" onClick={pickFile}>
                      <Plus size={28} strokeWidth={1.5} aria-hidden="true" />
                      <span>导入书籍</span>
                    </button>
                  </div> : <p className="shelf-filter-empty" role="status">暂时没有符合条件的书籍，换个筛选或关键词试试。</p>}
                </>}
              </section>
              <footer className="library-footer"><span>每一页，都算数。</span><span>你的书房，只属于你。</span></footer>
            </motion.div>
          ) : (
            <motion.div key="profile" className="profile-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <header className="library-heading"><div><p className="eyebrow">YOUR READING PREFERENCES</p><h1>设置<span>。</span></h1><p className="heading-description">照顾你的阅读习惯，也照顾你的眼睛。</p></div></header>
              <div className="profile-stats">{[{ label: "书架藏书", value: books.length }, { label: "阅读中", value: readingBooks.length }, { label: "已读完", value: finishedBooks.length }].map((stat) => <div key={stat.label}><strong>{stat.value}</strong><span>{stat.label}</span></div>)}</div>
              <h2 className="settings-title">阅读偏好</h2>
              <div className="settings-list">{[
                { label: "上传新书", value: supportedFormatLabel, action: pickFile },
                ...(desktopMode ? [{ label: "本地格式转换", value: toolchain?.available ? "可用" : toolchain ? "等待加入转换引擎" : "检测中…", action: toolchain && !toolchain.available ? () => void window.readTaylorDesktop?.openCalibreHelp() : undefined }] : []),
                { label: "夜间模式", value: isDark ? "已开启" : "已关闭", action: () => setIsDark((value) => !value) },
                { label: "关于应用", value: `v${APP_VERSION}`, action: undefined },
              ].map((item) => <button key={item.label} onClick={item.action} disabled={!item.action}><span>{item.label}</span><span>{item.value}{item.action && <ArrowUpRight size={16} />}</span></button>)}</div>
              <TranslationSettings />
              <p className="profile-privacy"><ShieldCheck size={19} />ReadTaylor 不提供书籍内容。文件在本机读取、转换与保存；主动使用翻译时，所选文本会发送到相应的翻译服务。</p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <AnimatePresence>{toast && <motion.div role="status" className="app-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} >{toast}</motion.div>}</AnimatePresence>
    </div>
  );
}
