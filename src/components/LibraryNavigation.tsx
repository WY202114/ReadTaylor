import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Menu, Moon, Settings, ShieldCheck, Sun, X } from "lucide-react";

interface LibraryNavigationProps {
  activeTab: "library" | "profile";
  onNavigate: (tab: "library" | "profile") => void;
  bookCount: number;
  isDark: boolean;
  onToggleDark: () => void;
  version: string;
}

export function LibraryNavigation(props: LibraryNavigationProps) {
  const { activeTab, onNavigate, bookCount, isDark, onToggleDark, version } = props;
  const drawer = useRef<HTMLDialogElement>(null);
  const drawerId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const closeDrawer = () => drawer.current?.close();
  const navigate = (tab: "library" | "profile") => {
    onNavigate(tab);
    closeDrawer();
  };

  useEffect(() => {
    // A modal drawer must stop trapping focus when the desktop sidebar returns.
    const desktop = window.matchMedia("(min-width: 851px)");
    const closeOnDesktop = () => {
      if (desktop.matches) drawer.current?.close();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const navigation = (mobile: boolean) => (
    <aside className={`library-navigation ${mobile ? "library-drawer-content" : "library-desktop-navigation"}`}>
      <a className="library-brand" href="#" onClick={(event) => { event.preventDefault(); navigate("library"); }} aria-label="ReadTaylor 书架">
        <span className="brand-mark"><BookOpen size={23} aria-hidden="true" /></span>
        <span>ReadTaylor<small>让阅读，慢下来。</small></span>
      </a>
      <span className="navigation-caption">我的阅读空间</span>
      <nav aria-label="主导航">
        {([
          { id: "library" as const, icon: BookOpen, label: "我的书架" },
          { id: "profile" as const, icon: Settings, label: "设置" },
        ]).map(({ id, icon: Icon, label }) => (
          <button key={id} className={`navigation-item${activeTab === id ? " is-active" : ""}`} onClick={() => navigate(id)} aria-current={activeTab === id ? "page" : undefined}>
            <Icon size={19} aria-hidden="true" /><span>{label}</span>{id === "library" && <small>{bookCount}</small>}
          </button>
        ))}
      </nav>
      <div className="navigation-bottom">
        <div className="local-note"><ShieldCheck size={19} aria-hidden="true" /><div>属于你的私人书房<p>书籍与笔记，保存在本机。</p></div></div>
        <button className="theme-button" onClick={onToggleDark} aria-label={isDark ? "切换日间模式" : "切换夜间模式"}>
          {isDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}<span>{isDark ? "日间模式" : "夜间模式"}</span>
        </button>
        <small className="app-version">READTAYLOR / {version}</small>
      </div>
    </aside>
  );

  return <>
    {navigation(false)}
    <header className="library-mobile-bar">
      <button className="library-menu-toggle" aria-label="展开导航" aria-expanded={isOpen} aria-controls={drawerId} onClick={() => { drawer.current?.showModal(); setIsOpen(true); }}>
        <Menu size={21} aria-hidden="true" /><span>导航</span>
      </button>
      <span>ReadTaylor</span>
    </header>
    {/* Native dialog supplies focus containment, Escape and focus restoration. */}
    <dialog ref={drawer} id={drawerId} className="library-navigation-drawer" aria-label="导航菜单" onClose={() => setIsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
      <button className="library-menu-close" aria-label="收起导航" onClick={closeDrawer}><X size={21} aria-hidden="true" /></button>
      {navigation(true)}
    </dialog>
  </>;
}
