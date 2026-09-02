export interface TranslationResult {
  text: string;
  detectedLanguage?: string;
  targetLanguage: string;
}

interface CachedTranslation extends TranslationResult {
  bookId: string;
  chapterId: string;
  pageKey: string;
  sourceHash: string;
  updatedAt: number;
}

export const TRANSLATION_LANGUAGES = [
  { code: "zh-Hans", label: "简体中文" },
  { code: "zh-Hant", label: "繁体中文" },
  { code: "en", label: "英语" },
  { code: "ja", label: "日语" },
  { code: "ko", label: "韩语" },
  { code: "fr", label: "法语" },
  { code: "de", label: "德语" },
  { code: "es", label: "西班牙语" },
] as const;

const CACHE_KEY = "readtaylor.translations.v1";
const MAX_CACHE_ENTRIES = 80;

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function loadCache(): CachedTranslation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed as CachedTranslation[] : [];
  } catch {
    return [];
  }
}

export function loadCachedTranslation(
  bookId: string,
  chapterId: string,
  pageKey: string,
  sourceText: string,
  targetLanguage: string
): TranslationResult | null {
  const sourceHash = hashText(sourceText);
  const entry = loadCache().find((item) => (
    item.bookId === bookId
    && item.chapterId === chapterId
    && item.pageKey === pageKey
    && item.sourceHash === sourceHash
    && item.targetLanguage === targetLanguage
  ));
  return entry ? {
    text: entry.text,
    detectedLanguage: entry.detectedLanguage,
    targetLanguage: entry.targetLanguage,
  } : null;
}

export function saveCachedTranslation(
  bookId: string,
  chapterId: string,
  pageKey: string,
  sourceText: string,
  result: TranslationResult
): void {
  try {
    const sourceHash = hashText(sourceText);
    const remaining = loadCache().filter((item) => !(
      item.bookId === bookId
      && item.chapterId === chapterId
      && item.pageKey === pageKey
      && item.sourceHash === sourceHash
      && item.targetLanguage === result.targetLanguage
    ));
    const next: CachedTranslation = {
      ...result,
      bookId,
      chapterId,
      pageKey,
      sourceHash,
      updatedAt: Date.now(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify([next, ...remaining].slice(0, MAX_CACHE_ENTRIES)));
  } catch {
    // 翻译缓存失败只会导致下次重新请求，不影响阅读。
  }
}

export async function requestTranslation(
  text: string,
  targetLanguage: string,
  signal?: AbortSignal
): Promise<TranslationResult> {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, targetLanguage }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as {
    text?: string;
    detectedLanguage?: string;
    targetLanguage?: string;
    error?: string;
  };
  if (!response.ok || !payload.text) {
    throw new Error(payload.error || "翻译失败，请稍后重试");
  }
  return {
    text: payload.text,
    detectedLanguage: payload.detectedLanguage,
    targetLanguage: payload.targetLanguage || targetLanguage,
  };
}
