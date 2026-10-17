import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

interface ShelfSearchProps {
  search: string;
  onSearch: (query: string) => void;
}

export function ShelfSearch({ search, onSearch }: ShelfSearchProps) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
      const commandK = event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey;
      if (!slash && !commandK) return;
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select"));
      // Let typing and modal navigation keep their normal keyboard behavior.
      if ((editing && (slash || target !== input.current)) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <div className="shelf-search shelf-search--top" role="search" aria-label="书架搜索">
      <Search size={19} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="搜索书名或作者"
        aria-label="搜索书名或作者"
        aria-keyshortcuts="/ Control+k Meta+k"
        autoComplete="off"
        spellCheck={false}
      />
      {search && <button type="button" className="shelf-search-clear" aria-label="清除搜索" title="清除搜索" onClick={() => { onSearch(""); input.current?.focus(); }}><X size={17} aria-hidden="true" /></button>}
      <span className="shelf-search-shortcuts" aria-hidden="true"><kbd>/</kbd><span>或</span><kbd>Ctrl K</kbd></span>
    </div>
  );
}
