import { ArrowDownUp, LayoutGrid, List } from "lucide-react";
import type { BookshelfPreferences, ShelfSort, ShelfStatus } from "./bookshelfPreferences";

interface ShelfToolbarProps {
  count: number;
  search: string;
  preferences: BookshelfPreferences;
  onPreferencesChange: (preferences: BookshelfPreferences) => void;
}

const STATUSES: { value: ShelfStatus; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "reading", label: "在读" },
  { value: "unread", label: "未读" },
  { value: "finished", label: "已读完" },
];

export function ShelfToolbar({ count, search, preferences, onPreferencesChange }: ShelfToolbarProps) {
  return (
    <div className="shelf-toolbar shelf-toolbar--expanded">
      <h2>{search.trim() ? "搜索结果" : "全部书籍"}<span>{count}</span></h2>
      <div className="shelf-status-filter" role="group" aria-label="阅读状态筛选">
        {STATUSES.map(({ value, label }) => (
          <button key={value} aria-pressed={preferences.status === value} onClick={() => onPreferencesChange({ ...preferences, status: value })}>{label}</button>
        ))}
      </div>
      <label className="shelf-status-select">
        <span className="sr-only">阅读状态</span>
        <select aria-label="阅读状态" value={preferences.status} onChange={(event) => onPreferencesChange({ ...preferences, status: event.target.value as ShelfStatus })}>
          {STATUSES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
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
    </div>
  );
}
