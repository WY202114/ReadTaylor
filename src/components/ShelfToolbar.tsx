import { ArrowDownUp, LayoutGrid, List, Search } from "lucide-react";
import type { BookshelfPreferences, ShelfSort, ShelfStatus } from "./bookshelfPreferences";

interface ShelfToolbarProps {
  count: number;
  search: string;
  preferences: BookshelfPreferences;
  onSearch: (query: string) => void;
  onPreferencesChange: (preferences: BookshelfPreferences) => void;
}

const STATUSES: { value: ShelfStatus; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "reading", label: "在读" },
  { value: "unread", label: "未读" },
  { value: "finished", label: "已读完" },
];

export function ShelfToolbar({ count, search, preferences, onSearch, onPreferencesChange }: ShelfToolbarProps) {
  return (
    <div className="shelf-toolbar shelf-toolbar--expanded">
      <h2>{search.trim() ? "搜索结果" : "全部书籍"}<span>{count}</span></h2>
      <div className="shelf-status-filter" role="group" aria-label="阅读状态筛选">
        {STATUSES.map(({ value, label }) => (
          <button key={value} aria-pressed={preferences.status === value} onClick={() => onPreferencesChange({ ...preferences, status: value })}>{label}</button>
        ))}
      </div>
      <label className="shelf-sort">
        <ArrowDownUp size={15} aria-hidden="true" />
        <select aria-label="书籍排序" value={preferences.sort} onChange={(event) => onPreferencesChange({ ...preferences, sort: event.target.value as ShelfSort })}>
          <option value="recent">最近阅读</option>
          <option value="added">添加时间</option>
          <option value="title">书名</option>
        </select>
      </label>
      <div className="shelf-view-toggle" role="group" aria-label="书架视图">
        <button aria-label="网格视图" title="网格视图" aria-pressed={preferences.view === "grid"} onClick={() => onPreferencesChange({ ...preferences, view: "grid" })}><LayoutGrid size={17} aria-hidden="true" /></button>
        <button aria-label="列表视图" title="列表视图" aria-pressed={preferences.view === "list"} onClick={() => onPreferencesChange({ ...preferences, view: "list" })}><List size={18} aria-hidden="true" /></button>
      </div>
      <label className="shelf-search">
        <Search size={16} aria-hidden="true" />
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索书名或作者" aria-label="搜索书名或作者" />
      </label>
    </div>
  );
}
