const FONT_SIZE_KEY = "readtaylor.fontSizes.v1";

function loadFontSizes(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FONT_SIZE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function loadBookFontSize(bookId: string, fallback: number): number {
  const value = loadFontSizes()[bookId];
  return Number.isFinite(value) ? Math.min(28, Math.max(14, value)) : fallback;
}

export function saveBookFontSize(bookId: string, fontSize: number): void {
  try {
    const sizes = loadFontSizes();
    sizes[bookId] = Math.min(28, Math.max(14, fontSize));
    localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(sizes));
  } catch {
    // 偏好保存失败不应影响正常阅读。
  }
}

export function deleteBookPreferences(bookId: string): void {
  try {
    const sizes = loadFontSizes();
    delete sizes[bookId];
    localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(sizes));
  } catch {
    // 删除书籍不应因清理偏好失败而中断。
  }
}
