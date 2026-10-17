import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ReaderView } from "./components/ReaderView";
import { BookCover } from "./components/BookCover";
import { ShelfBookCard } from "./components/ShelfBookCard";
import { ShelfToolbar } from "./components/ShelfToolbar";
import { LibraryNavigation } from "./components/LibraryNavigation";
import { loadBookshelfPreferences, saveBookshelfPreferences } from "./components/bookshelfPreferences";
import {
  BookOpen,
  Clock,
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
import {
  desktopJobId,
  isDesktopApp,
  pickDesktopBooks,
  prepareDesktopBook,
} from "./lib/desktop";
import {
  archiveToFixedLayoutEPUB,
  pdfToFixedLayoutEPUB,
} from "./lib/fixedLayoutEpub";

const APP_VERSION = "3.0.2";

type Tab = "library" | "profile";

function lastReadTimeLabel(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now()) return "";
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  const date = new Date(timestamp);
  return date.toLocaleDateString("zh-CN", {
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    month: "long",
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
  const continueChapterTitle = continueReadingBook?.chapters[continueReadingBook.lastChapter]?.title?.trim();
  const continueTimeLabel = lastReadTimeLabel(continueReadingBook?.lastReadAt);
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
    booksRef.current = next;
    setBooks(next);
    return true;
  };

  const importBrowserFiles = async (files: File[]) => {
    const imported: Book[] = [];
    const errors: string[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const sourceKey = `browser:${file.name}:${file.size}:${file.lastModified}`;
      const existing = booksRef.current.find((book) => book.sourceKey === sourceKey);
      stick(`正在解析 ${file.name}${files.length > 1 ? `（${index + 1}/${files.length}）` : ""}…`);
      const { book, error } = await bookFromFile(file, { sourceKey, id: existing?.id });
      if (book) {
        if (existing) {
          book.progress = existing.progress;
          book.lastChapter = Math.min(existing.lastChapter, book.chapters.length - 1);
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
  };

  const importDesktopReferences = async (references: DesktopBookReference[]) => {
    if (!references.length) return;
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
        if (prepared.sourceExtension === "pdf") {
          readableFile = await pdfToFixedLayoutEPUB(prepared.file, (update) => stick(update.message));
          convertedLocally = true;
        } else if (prepared.sourceExtension === "cbz" || prepared.sourceExtension === "zip") {
          readableFile = await archiveToFixedLayoutEPUB(prepared.file, (update) => stick(update.message));
          convertedLocally = true;
        }
        const existing = booksRef.current.find((book) => book.sourceKey === reference.sourceKey);
        const { book, error } = await bookFromFile(readableFile, {
          sourceKey: reference.sourceKey,
          id: existing?.id,
        });
        if (error || !book) throw new Error(error || "无法读取转换后的 EPUB。");
        if (existing) {
          book.progress = existing.progress;
          book.lastChapter = Math.min(existing.lastChapter, book.chapters.length - 1);
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
    setBooks((prev) => prev.filter((b) => b.id !== id));
    delFile(id); // 清掉 IndexedDB 里的原始文件（EPUB 原版渲染用）
    delFile(coverFileKey(id));
    deleteNotesForBook(id);
    deletePaginationCacheForBook(id);
    deleteBookPreferences(id);
    deleteReadingPosition(id);
  };

  const openBook = (book: Book) => setReadingBook({ ...book, lastReadAt: Date.now() });

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
          <ReaderView
            book={readingBook}
            onBack={closeReader}
            onPositionChange={persistReadingPosition}
            isDark={isDark}
            onToggleDark={() => setIsDark((d) => !d)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`library-shell${isDark ? " dark" : ""}`}>
      <input ref={fileInputRef} type="file" accept=".txt,.md,.epub,.pdf,.cbz,.zip,text/plain" multiple hidden onChange={onFileChange} />
      <LibraryNavigation activeTab={activeTab} onNavigate={setActiveTab} bookCount={books.length} isDark={isDark} onToggleDark={() => setIsDark((value) => !value)} version={APP_VERSION} />
      <main className={`library-main${activeTab === "library" ? " library-main--shelf" : ""}`}>
        <AnimatePresence mode="wait">
          {activeTab === "library" ? (
            <motion.div key="library" className="library-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <header className="library-heading">
                <div><p className="eyebrow">THE READING ROOM</p><h1>我的书架<span>。</span></h1><p className="heading-description">把时间留给好书，把想法留在这里。</p></div>
                <button className="primary-button" onClick={pickFile}><Plus size={18} />导入书籍</button>
              </header>
              <section className="reading-overview" aria-label="阅读概览">
                <div className={`reading-feature${continueReadingBook ? " reading-feature--continue" : ""}`}>
                  {continueReadingBook ? <>
                    <div className="feature-copy">
                      <p className="eyebrow"><Clock size={14} />继续上次的阅读</p>
                      <h2>{continueReadingBook.title}</h2>
                      <p className="feature-author">{continueReadingBook.author}</p>
                      <div className="feature-progress">
                        <div className="feature-progress-details">
                          <span className="feature-progress-value">已读 {continueReadingBook.progress}%</span>
                          {(continueChapterTitle || continueTimeLabel) && (
                            <div className="feature-reading-context">
                              {continueChapterTitle && <span className="feature-chapter" title={continueChapterTitle}>{continueChapterTitle}</span>}
                              {continueChapterTitle && continueTimeLabel && <span aria-hidden="true">·</span>}
                              {continueTimeLabel && <time dateTime={new Date(continueReadingBook.lastReadAt!).toISOString()} title={new Date(continueReadingBook.lastReadAt!).toLocaleString("zh-CN")}>{continueTimeLabel}</time>}
                            </div>
                          )}
                        </div>
                        <div className="progress-track" role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={continueReadingBook.progress}>
                          <span style={{ width: `${continueReadingBook.progress}%` }} />
                        </div>
                      </div>
                      <button className="primary-button feature-continue-button" onClick={() => openBook(continueReadingBook)}>继续阅读<ArrowUpRight size={18} aria-hidden="true" /></button>
                    </div>
                    <button className="feature-cover" aria-label={`继续阅读 ${continueReadingBook.title}`} onClick={() => openBook(continueReadingBook)}><BookCover book={continueReadingBook} style={{ width: "100%", height: "100%", borderRadius: "3px 9px 9px 3px" }} /></button>
                  </> : <>
                    <div className="feature-copy"><p className="eyebrow">A LITTLE TIME, A GOOD BOOK</p><h2>翻开一页，<br />走进另一个世界。</h2><p className="feature-author">{books.length ? "从下方挑一本书，开始今天的阅读。" : "从一本喜欢的书开始，慢慢装满你的书架。"}</p><button className="text-button" onClick={pickFile}>导入你的书<ArrowUpRight size={18} /></button></div>
                    <div className="book-still-life" aria-hidden="true"><div className="decor-book decor-book-back">READ</div><div className="decor-book decor-book-front"><span>THE JOY OF</span><strong>Reading</strong><BookOpen size={32} /><small>ONE PAGE AT A TIME</small></div></div>
                  </>}
                </div>
                <div className="reading-summary reading-footprint">
                  <p className="eyebrow">阅读足迹</p>
                  <dl className="reading-footprint-stats">
                    {[
                      { label: "今日阅读时长", value: todayReadingMinutes, unit: "分钟" },
                      { label: "连续阅读天数", value: consecutiveReadingDays, unit: "天" },
                      { label: "笔记数量", value: noteCount, unit: "条" },
                    ].map(({ label, value, unit }) => <div key={label}><dt>{label}</dt><dd><strong>{value}</strong><span>{unit}</span></dd></div>)}
                  </dl>
                </div>
              </section>
              <section className="shelf-section" aria-label="全部书籍">
                <ShelfToolbar count={filteredBooks.length} search={searchQuery} preferences={shelfPreferences} onSearch={setSearchQuery} onPreferencesChange={setShelfPreferences} />
                {books.length === 0 ? <div className="shelf-empty"><span className="empty-icon"><BookOpen size={27} /></span><h3>好故事，等你放上书架</h3><p>导入你的电子书，随时阅读、翻译和记录想法。</p><button className="primary-button" onClick={pickFile}><Upload size={16} />导入第一本书</button><small>支持 {supportedFormatLabel}</small></div> : <>
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
              <p className="profile-privacy"><ShieldCheck size={19} />ReadTaylor 不提供书籍内容。所有文件仅在本机读取、转换与保存，不会上传到服务器。</p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <AnimatePresence>{toast && <motion.div role="status" className="app-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} >{toast}</motion.div>}</AnimatePresence>
    </div>
  );
}
