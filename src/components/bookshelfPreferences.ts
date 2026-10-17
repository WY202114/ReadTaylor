export type ShelfStatus = "all" | "reading" | "unread" | "finished";
export type ShelfSort = "recent" | "added" | "title";
export type ShelfView = "grid" | "list";

export interface BookshelfPreferences {
  status: ShelfStatus;
  sort: ShelfSort;
  view: ShelfView;
}

const STORAGE_KEY = "readtaylor.bookshelfPreferences.v1";
const DEFAULTS: BookshelfPreferences = { status: "all", sort: "recent", view: "grid" };

export function loadBookshelfPreferences(): BookshelfPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object") return { ...DEFAULTS };
    return {
      status: ["all", "reading", "unread", "finished"].includes(saved.status) ? saved.status : DEFAULTS.status,
      sort: ["recent", "added", "title"].includes(saved.sort) ? saved.sort : DEFAULTS.sort,
      view: ["grid", "list"].includes(saved.view) ? saved.view : DEFAULTS.view,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveBookshelfPreferences(preferences: BookshelfPreferences): void {
  try {
    // 只保存页面偏好，不改写书籍、阅读进度或笔记。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 存储不可用时，当前页面仍可正常筛选和切换视图。
  }
}
