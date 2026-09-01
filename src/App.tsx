import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ReaderView } from "./components/ReaderView";
import { BookCover } from "./components/BookCover";
import {
  BookOpen,
  Search,
  User,
  Sun,
  Moon,
  Clock,
  TrendingUp,
  Upload,
  Plus,
  Trash2,
  FileText,
} from "lucide-react";
import { bookFromFile, loadBooks, saveBooks, type Book } from "./lib/books";
import { delFile } from "./lib/filestore";
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

const APP_VERSION = "3.0.0";

type Tab = "library" | "profile";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜读愉快";
  if (h < 11) return "早上好";
  if (h < 14) return "午安";
  if (h < 18) return "下午好";
  return "晚上好";
}

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
  };

  const openBook = (book: Book) => setReadingBook(book);

  const closeReader = (lastChapterIndex: number, lastScroll: number) => {
    if (readingBook) {
      const total = readingBook.chapters.length;
      const progress = Math.round(((lastChapterIndex + 1) / total) * 100);
      setBooks((prev) =>
        prev.map((b) =>
          b.id === readingBook.id
            ? { ...b, lastChapter: lastChapterIndex, lastScroll, progress }
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
            isDark={isDark}
            onToggleDark={() => setIsDark((d) => !d)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={isDark ? "dark" : ""}
      style={{
        width: "100%",
        height: "100dvh",
        background: "var(--background)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.epub,.pdf,.cbz,.zip,text/plain"
        multiple
        style={{ display: "none" }}
        onChange={onFileChange}
      />

      <div style={{ height: "max(env(safe-area-inset-top), 12px)" }} />

      {/* Content */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <AnimatePresence mode="wait">
            {activeTab === "library" && (
              <motion.div
                key="library"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
              >
                {/* Header */}
                <div style={{ padding: "8px 24px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
                    <div>
                      <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--muted-foreground)", margin: 0 }}>
                        {greeting()}
                      </p>
                      <h1 style={{ fontFamily: "Lora, serif", fontSize: "24px", fontWeight: 600, color: "var(--foreground)", margin: 0 }}>
                        我的书架
                      </h1>
                    </div>
                    <button
                      onClick={() => setIsDark((d) => !d)}
                      style={{ width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "var(--secondary)", border: "none", cursor: "pointer" }}
                    >
                      {isDark ? <Sun size={18} style={{ color: "var(--accent)" }} /> : <Moon size={18} style={{ color: "var(--muted-foreground)" }} />}
                    </button>
                  </div>

                  {/* Search */}
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", borderRadius: "12px", background: "var(--secondary)" }}>
                    <Search size={16} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索我上传的书…"
                      style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontFamily: "Inter, sans-serif", fontSize: "14px", color: "var(--foreground)" }}
                    />
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 16px", scrollbarWidth: "none" }}>
                  {books.length === 0 ? (
                    /* Empty state — 应用不提供书籍，引导上传 */
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "40px 12px" }}>
                      <div style={{ width: "72px", height: "72px", borderRadius: "50%", background: "var(--secondary)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "20px" }}>
                        <BookOpen size={30} style={{ color: "var(--accent)" }} />
                      </div>
                      <h2 style={{ fontFamily: "Lora, serif", fontSize: "19px", fontWeight: 600, color: "var(--foreground)", margin: "0 0 8px" }}>
                        书架还是空的
                      </h2>
                      <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", lineHeight: 1.7, color: "var(--muted-foreground)", margin: "0 0 24px", maxWidth: "260px" }}>
                        ReadTaylor 不提供任何书籍内容。选择你自己的电子书，文件只在本机读取和转换。
                      </p>
                      <button
                        onClick={pickFile}
                        style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 24px", borderRadius: "12px", background: "var(--accent)", border: "none", cursor: "pointer", color: "var(--accent-foreground)", fontFamily: "Inter, sans-serif", fontSize: "15px", fontWeight: 600 }}
                      >
                        <Upload size={17} /> 上传文件
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Continue reading */}
                      {readingBooks.length > 0 && !searchQuery && (
                        <div style={{ marginBottom: "24px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                            <Clock size={14} style={{ color: "var(--accent)" }} />
                            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", fontWeight: 500, color: "var(--muted-foreground)" }}>继续阅读</span>
                          </div>
                          <button
                            onClick={() => openBook(readingBooks[0])}
                            style={{ width: "100%", display: "flex", gap: "16px", padding: "16px", borderRadius: "16px", background: "var(--card)", border: "1px solid var(--border)", textAlign: "left", cursor: "pointer" }}
                          >
                            <BookCover book={readingBooks[0]} style={{ width: "64px", height: "96px", borderRadius: "12px", flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ fontFamily: "Lora, serif", fontSize: "16px", fontWeight: 500, color: "var(--foreground)", margin: 0 }}>{readingBooks[0].title}</p>
                              <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--muted-foreground)", margin: "4px 0 0" }}>{readingBooks[0].author}</p>
                              <div style={{ marginTop: "12px" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                                  <span style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)" }}>阅读进度</span>
                                  <span style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--accent)" }}>{readingBooks[0].progress}%</span>
                                </div>
                                <div style={{ height: "4px", borderRadius: "2px", background: "var(--secondary)" }}>
                                  <div style={{ width: `${readingBooks[0].progress}%`, height: "100%", borderRadius: "2px", background: "var(--accent)" }} />
                                </div>
                              </div>
                            </div>
                          </button>
                        </div>
                      )}

                      {/* Section header + upload button */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <TrendingUp size={14} style={{ color: "var(--accent)" }} />
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", fontWeight: 500, color: "var(--muted-foreground)" }}>
                            {searchQuery ? "搜索结果" : "全部书籍"}
                          </span>
                        </div>
                        {!searchQuery && (
                          <button
                            onClick={pickFile}
                            style={{ display: "flex", alignItems: "center", gap: "4px", padding: "5px 10px", borderRadius: "20px", background: "var(--secondary)", border: "none", cursor: "pointer", color: "var(--foreground)", fontFamily: "Inter, sans-serif", fontSize: "12px", fontWeight: 500 }}
                          >
                            <Plus size={13} /> 上传
                          </button>
                        )}
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                        {filteredBooks.map((book) => (
                          <div key={book.id} style={{ position: "relative" }}>
                            <button
                              onClick={() => openBook(book)}
                              style={{ textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%" }}
                            >
                              <div style={{ position: "relative", marginBottom: "8px" }}>
                                <BookCover book={book} style={{ width: "100%", aspectRatio: "3/4", borderRadius: "16px" }} />
                                {book.progress >= 100 && (
                                  <div style={{ position: "absolute", top: "8px", right: "8px", padding: "2px 8px", borderRadius: "20px", background: "var(--accent)", opacity: 0.92 }}>
                                    <span style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--accent-foreground)", fontWeight: 600 }}>已读完</span>
                                  </div>
                                )}
                                {book.progress > 0 && book.progress < 100 && (
                                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "4px", borderRadius: "0 0 16px 16px", overflow: "hidden", background: "rgba(0,0,0,0.2)" }}>
                                    <div style={{ width: `${book.progress}%`, height: "100%", background: "var(--accent)" }} />
                                  </div>
                                )}
                              </div>
                              <p style={{ fontFamily: "Lora, serif", fontSize: "14px", fontWeight: 500, color: "var(--foreground)", lineHeight: 1.3, margin: 0 }}>{book.title}</p>
                              <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--muted-foreground)", margin: "2px 0 0" }}>{book.author}</p>
                              <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px" }}>
                                <FileText size={11} style={{ color: "var(--muted-foreground)" }} />
                                <span style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)" }}>{book.chapters.length} 章</span>
                              </div>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteBook(book.id, book.title);
                              }}
                              aria-label="移除"
                              style={{ position: "absolute", top: "8px", left: "8px", width: "26px", height: "26px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "rgba(0,0,0,0.4)", border: "none", cursor: "pointer", backdropFilter: "blur(4px)" }}
                            >
                              <Trash2 size={13} style={{ color: "#fff" }} />
                            </button>
                          </div>
                        ))}
                      </div>

                      {filteredBooks.length === 0 && (
                        <div style={{ textAlign: "center", padding: "48px 0" }}>
                          <p style={{ fontFamily: "Lora, serif", fontSize: "16px", color: "var(--muted-foreground)" }}>没有匹配的书籍</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === "profile" && (
              <motion.div
                key="profile"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                style={{ flex: 1, overflowY: "auto", padding: "16px 24px", scrollbarWidth: "none" }}
              >
                <h1 style={{ fontFamily: "Lora, serif", fontSize: "24px", fontWeight: 600, color: "var(--foreground)", marginBottom: "24px" }}>我的</h1>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "32px" }}>
                  {[
                    { label: "书架藏书", value: books.length },
                    { label: "阅读中", value: readingBooks.length },
                    { label: "已读完", value: finishedBooks.length },
                  ].map((stat) => (
                    <div key={stat.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "16px 8px", borderRadius: "16px", background: "var(--card)", border: "1px solid var(--border)" }}>
                      <span style={{ fontFamily: "Lora, serif", fontSize: "24px", fontWeight: 600, color: "var(--foreground)" }}>{stat.value}</span>
                      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--muted-foreground)", marginTop: "2px", textAlign: "center" }}>{stat.label}</span>
                    </div>
                  ))}
                </div>

                <div style={{ borderRadius: "16px", overflow: "hidden", border: "1px solid var(--border)" }}>
                  {[
                    { label: "上传新书", value: supportedFormatLabel, action: pickFile },
                    ...(desktopMode
                      ? [
                          {
                            label: "本地格式转换",
                            value: toolchain?.available
                              ? "可用"
                              : toolchain
                                ? "等待加入转换引擎"
                                : "检测中…",
                            action: toolchain && !toolchain.available
                              ? () => void window.readTaylorDesktop?.openCalibreHelp()
                              : undefined,
                          },
                        ]
                      : []),
                    { label: "夜间模式", value: isDark ? "已开启" : "已关闭", action: () => setIsDark((d) => !d) },
                    { label: "关于应用", value: `v${APP_VERSION}`, action: undefined },
                  ].map((item, i) => (
                    <button
                      key={item.label}
                      onClick={item.action}
                      style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px", textAlign: "left", background: "var(--card)", border: "none", borderTop: i > 0 ? "1px solid var(--border)" : "none", cursor: item.action ? "pointer" : "default" }}
                    >
                      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "15px", color: "var(--foreground)" }}>{item.label}</span>
                      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", color: "var(--muted-foreground)" }}>{item.value}</span>
                    </button>
                  ))}
                </div>

                <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", lineHeight: 1.7, color: "var(--muted-foreground)", marginTop: "20px", textAlign: "center" }}>
                  ReadTaylor 不提供书籍内容。所有文件仅在本机读取、转换与保存，不会上传到服务器。
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", padding: "12px 24px 20px", borderTop: "1px solid var(--border)", background: "var(--card)" }}>
          {([
            { id: "library" as Tab, icon: BookOpen, label: "书架" },
            { id: "profile" as Tab, icon: User, label: "我的" },
          ]).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", background: "none", border: "none", cursor: "pointer", padding: "4px 16px" }}
            >
              <Icon
                size={22}
                style={{
                  color: activeTab === id ? "var(--accent)" : "var(--muted-foreground)",
                  fill: activeTab === id ? "var(--accent)" : "none",
                  strokeWidth: activeTab === id ? 2 : 1.5,
                  transition: "all 0.2s",
                }}
              />
              <span style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: activeTab === id ? "var(--accent)" : "var(--muted-foreground)", transition: "color 0.2s" }}>
                {label}
              </span>
            </button>
          ))}
        </div>

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              style={{ position: "absolute", left: "24px", right: "24px", bottom: "92px", padding: "12px 16px", borderRadius: "12px", background: "var(--foreground)", color: "var(--background)", fontFamily: "Inter, sans-serif", fontSize: "13px", lineHeight: 1.5, textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.2)" }}
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
  );
}
