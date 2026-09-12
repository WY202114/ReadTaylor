import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ReaderView } from "./components/ReaderView";
import { BookCover } from "./components/BookCover";
import {
  BookOpen,
  Search,
  User,
  Clock,
  ArrowUpRight,
  Sun,
  Moon,
  ShieldCheck,
  Upload,
  Plus,
  Trash2,
  FileText,
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
import { deleteNotesForBook } from "./lib/notes";
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

export default function App() {
  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("library");
  const [books, setBooks] = useState<Book[]>(() => loadBooks());
  const [readingBook, setReadingBook] = useState<Book | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
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

  const filteredBooks = books.filter(
    (b) => b.title.includes(searchQuery) || b.author.includes(searchQuery)
  );
  const readingBooks = books.filter((b) => b.progress > 0 && b.progress < 100);
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

  const openBook = (book: Book) => setReadingBook(book);

  const persistReadingPosition = useCallback((lastChapterIndex: number, lastScroll: number, lastPage?: Book["lastPage"]) => {
    if (!readingBook) return;
    saveReadingPosition(
      readingBook.id,
      lastChapterIndex,
      lastScroll,
      readingBook.chapters.length,
      lastPage
    );
  }, [readingBook]);

  const closeReader = (lastChapterIndex: number, lastScroll: number, lastPage?: Book["lastPage"]) => {
    if (readingBook) {
      const total = readingBook.chapters.length;
      const progress = Math.round(((lastChapterIndex + 1) / total) * 100);
      setBooks((prev) =>
        prev.map((b) =>
          b.id === readingBook.id
            ? { ...b, lastChapter: lastChapterIndex, lastScroll, lastPage, progress }
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
      <aside className="library-navigation">
        <a className="library-brand" href="#" onClick={(event) => { event.preventDefault(); setActiveTab("library"); }} aria-label="ReadTaylor 书架">
          <span className="brand-mark"><BookOpen size={23} /></span>
          <span>ReadTaylor<small>让阅读，慢下来。</small></span>
        </a>
        <span className="navigation-caption">我的阅读空间</span>
        <nav aria-label="主导航">
          {([{ id: "library" as Tab, icon: BookOpen, label: "我的书架" }, { id: "profile" as Tab, icon: User, label: "我的" }]).map(({ id, icon: Icon, label }) => (
            <button key={id} className={`navigation-item${activeTab === id ? " is-active" : ""}`} onClick={() => setActiveTab(id)} aria-current={activeTab === id ? "page" : undefined}>
              <Icon size={19} /><span>{label}</span>{id === "library" && <small>{books.length}</small>}
            </button>
          ))}
        </nav>
        <div className="navigation-bottom">
          <div className="local-note"><ShieldCheck size={19} /><div>属于你的私人书房<p>书籍与笔记，保存在本机。</p></div></div>
          <button className="theme-button" onClick={() => setIsDark((value) => !value)} aria-label={isDark ? "切换日间模式" : "切换夜间模式"}>{isDark ? <Sun size={17} /> : <Moon size={17} />}<span>{isDark ? "日间模式" : "夜间模式"}</span></button>
          <small className="app-version">READTAYLOR / {APP_VERSION}</small>
        </div>
      </aside>
      <main className="library-main">
        <AnimatePresence mode="wait">
          {activeTab === "library" ? (
            <motion.div key="library" className="library-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <header className="library-heading">
                <div><p className="eyebrow">THE READING ROOM</p><h1>我的书架<span>。</span></h1><p className="heading-description">把时间留给好书，把想法留在这里。</p></div>
                <button className="primary-button" onClick={pickFile}><Plus size={18} />导入书籍</button>
              </header>
              <section className="reading-overview" aria-label="阅读概览">
                <div className="reading-feature">
                  {readingBooks.length > 0 ? <>
                    <div className="feature-copy"><p className="eyebrow"><Clock size={14} />继续上次的阅读</p><h2>{readingBooks[0].title}</h2><p className="feature-author">{readingBooks[0].author}</p><div className="feature-progress"><span>已读 {readingBooks[0].progress}%</span><div className="progress-track"><span style={{ width: `${readingBooks[0].progress}%` }} /></div></div><button className="text-button" onClick={() => openBook(readingBooks[0])}>继续阅读<ArrowUpRight size={18} /></button></div>
                    <button className="feature-cover" aria-label={`继续阅读 ${readingBooks[0].title}`} onClick={() => openBook(readingBooks[0])}><BookCover book={readingBooks[0]} style={{ width: "100%", height: "100%", borderRadius: "3px 9px 9px 3px" }} /></button>
                  </> : <>
                    <div className="feature-copy"><p className="eyebrow">A LITTLE TIME, A GOOD BOOK</p><h2>翻开一页，<br />走进另一个世界。</h2><p className="feature-author">{books.length ? "从下方挑一本书，开始今天的阅读。" : "从一本喜欢的书开始，慢慢装满你的书架。"}</p><button className="text-button" onClick={pickFile}>导入你的书<ArrowUpRight size={18} /></button></div>
                    <div className="book-still-life" aria-hidden="true"><div className="decor-book decor-book-back">READ</div><div className="decor-book decor-book-front"><span>THE JOY OF</span><strong>Reading</strong><BookOpen size={32} /><small>ONE PAGE AT A TIME</small></div></div>
                  </>}
                </div>
                <div className="reading-summary"><p className="eyebrow">阅读足迹</p><div className="summary-total"><strong>{books.length.toString().padStart(2, "0")}</strong><span>本藏书</span></div><div className="summary-details"><div><strong>{readingBooks.length}</strong><span>正在阅读</span></div><div><strong>{finishedBooks.length}</strong><span>已经读完</span></div></div></div>
              </section>
              <section className="shelf-section" aria-label="全部书籍">
                <div className="shelf-toolbar"><h2>{searchQuery ? "搜索结果" : "全部书籍"}<span>{filteredBooks.length}</span></h2><label className="shelf-search"><Search size={17} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索书名或作者" aria-label="搜索书名或作者" /></label></div>
                {books.length === 0 ? <div className="shelf-empty"><span className="empty-icon"><BookOpen size={27} /></span><h3>好故事，等你放上书架</h3><p>导入你的电子书，随时阅读、翻译和记录想法。</p><button className="primary-button" onClick={pickFile}><Upload size={16} />导入第一本书</button><small>支持 {supportedFormatLabel}</small></div> : <>
                  <div className="library-book-grid">{filteredBooks.map((book) => <article className="shelf-book" key={book.id}>
                    <button className="book-open" onClick={() => openBook(book)}>
                      <div className="book-display"><BookCover book={book} style={{ width: "100%", aspectRatio: "3/4", borderRadius: "3px 8px 8px 3px" }} /><span className="book-format">{book.fileType}</span></div>
                      <h3>{book.title}</h3><p>{book.author}</p><div className="book-metadata"><span><FileText size={12} />{book.chapters.length} 章</span><span>{book.progress >= 100 ? "已读完" : book.progress > 0 ? `已读 ${book.progress}%` : "未开始"}</span></div>
                      <div className="progress-track book-progress"><span style={{ width: `${book.progress}%` }} /></div>
                    </button>
                    <button className="book-remove" onClick={(event) => { event.stopPropagation(); deleteBook(book.id, book.title); }} aria-label={`移除 ${book.title}`}><Trash2 size={14} /></button>
                  </article>)}</div>
                  {filteredBooks.length === 0 && <div className="shelf-empty"><Search size={26} /><h3>没有找到匹配的书籍</h3><p>试试其他书名或作者。</p><button className="text-button" onClick={() => setSearchQuery("")}>清空搜索</button></div>}
                </>}
              </section>
              <footer className="library-footer"><span>每一页，都算数。</span><span>你的书房，只属于你。</span></footer>
            </motion.div>
          ) : (
            <motion.div key="profile" className="profile-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <header className="library-heading"><div><p className="eyebrow">YOUR PERSONAL SPACE</p><h1>我的<span>。</span></h1><p className="heading-description">照顾你的阅读习惯，也照顾你的眼睛。</p></div></header>
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
