// EPUB 原版渲染：从 IndexedDB 取出原始文件，解包后把某一章的 XHTML
// 连同它的 CSS / 图片 / 字体改写为本地 blob 链接，产出可直接塞进 iframe 的自包含 HTML。
import type JSZip from "jszip";
import type { Book } from "./books";
import { getFile } from "./filestore";

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function resolvePath(baseDir: string, rel: string): string {
  const cleaned = decodeURIComponent(rel.split("#")[0].split("?")[0]);
  const parts = (baseDir ? baseDir.split("/") : []).concat(cleaned.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function isExternal(url: string): boolean {
  return /^(https?:|data:|blob:|mailto:|tel:|#)/i.test(url);
}

function isRemote(url: string): boolean {
  return /^(https?:|\/\/)/i.test(url.trim());
}

interface Loaded {
  id: string;
  zip: JSZip;
  urls: string[]; // 已创建的 blob URL，切书时统一回收
  cache: Map<string, string>; // 资源路径 → blob URL
}

let loaded: Loaded | null = null;

export function cleanup(): void {
  if (loaded) {
    loaded.urls.forEach((u) => URL.revokeObjectURL(u));
    loaded = null;
  }
}

async function ensure(book: Book): Promise<Loaded> {
  if (loaded?.id === book.id) return loaded;
  cleanup();
  const blob = await getFile(book.id);
  if (!blob) throw new Error("原始 EPUB 文件丢失（可能换了浏览器或清了数据），请重新上传。");
  const JSZipMod = (await import("jszip")).default;
  const zip = await JSZipMod.loadAsync(blob);
  loaded = { id: book.id, zip, urls: [], cache: new Map() };
  return loaded;
}

async function blobUrl(L: Loaded, path: string): Promise<string | null> {
  if (L.cache.has(path)) return L.cache.get(path)!;
  const entry = L.zip.file(path);
  if (!entry) return null;
  const b = await entry.async("blob");
  const url = URL.createObjectURL(b);
  L.urls.push(url);
  L.cache.set(path, url);
  return url;
}

// 改写 CSS 文本里的 url(...)（字体、背景图）为 blob 链接
async function inlineCssUrls(L: Loaded, css: string, cssDir: string): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const tasks: Array<{ match: string; url: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (!/^(data:|blob:|#)/i.test(m[2])) tasks.push({ match: m[0], url: m[2] });
  }
  for (const t of tasks) {
    if (isRemote(t.url)) {
      css = css.split(t.match).join('url("")');
      continue;
    }
    const u = await blobUrl(L, resolvePath(cssDir, t.url));
    if (u) css = css.split(t.match).join(`url("${u}")`);
  }
  return css.replace(/@import\s+(?:url\()?\s*["']?https?:[^;]+;?/gi, "");
}

const BASE_STYLE = `
  html { background: #faf6ef; }
  html, body { margin: 0; }
  body { padding: 18px 20px 72px; -webkit-text-size-adjust: 100%; word-wrap: break-word; overflow-wrap: break-word; }
  img, svg, image { max-width: 100% !important; height: auto !important; }
`;

export async function renderChapter(book: Book, index: number): Promise<string> {
  const L = await ensure(book);
  const path = book.chapters[index]?.href;
  if (!path) throw new Error("章节路径缺失。");
  const chapterDir = dirOf(path);
  const html = (await L.zip.file(path)?.async("text")) ?? "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 书籍内容是不可信输入：移除可执行/嵌入元素和事件属性，并阻止远程资源。
  doc.querySelectorAll("script,iframe,object,embed,form,video,audio,base,meta[http-equiv='refresh']")
    .forEach((element) => element.remove());
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    }
  }

  // 图片
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src") || "";
    img.removeAttribute("srcset");
    if (isRemote(src)) {
      img.removeAttribute("src");
      continue;
    }
    if (isExternal(src)) continue;
    const u = await blobUrl(L, resolvePath(chapterDir, src));
    if (u) img.setAttribute("src", u);
  }
  // SVG <image>（用 href 或 xlink:href）
  for (const im of Array.from(doc.querySelectorAll("image"))) {
    const src = im.getAttribute("href") || im.getAttribute("xlink:href") || "";
    if (!src) continue;
    if (isRemote(src)) {
      im.removeAttribute("href");
      im.removeAttribute("xlink:href");
      continue;
    }
    if (isExternal(src)) continue;
    const u = await blobUrl(L, resolvePath(chapterDir, src));
    if (u) {
      im.setAttribute("href", u);
      im.removeAttribute("xlink:href");
    }
  }
  for (const use of Array.from(doc.querySelectorAll("use"))) {
    const src = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
    if (isRemote(src)) use.remove();
  }
  // 外链 <link rel=stylesheet> → 内联 <style>
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute("href") || "";
    const cssPath = resolvePath(chapterDir, href);
    const css = await L.zip.file(cssPath)?.async("text");
    if (css) {
      const style = doc.createElement("style");
      style.textContent = await inlineCssUrls(L, css, dirOf(cssPath));
      link.replaceWith(style);
    } else {
      link.remove();
    }
  }
  // 内联 <style> 里的 url()
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (style.textContent && style.textContent.includes("url(")) {
      style.textContent = await inlineCssUrls(L, style.textContent, chapterDir);
    }
  }

  // 注入阅读基础样式（放在 head 最前，让书自己的样式仍能覆盖大部分）
  const base = doc.createElement("style");
  base.textContent = BASE_STYLE;
  const meta = doc.createElement("meta");
  meta.setAttribute("name", "viewport");
  meta.setAttribute("content", "width=device-width, initial-scale=1");
  const security = doc.createElement("meta");
  security.setAttribute("http-equiv", "Content-Security-Policy");
  security.setAttribute(
    "content",
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' blob:; font-src data: blob:;"
  );
  const head = doc.head || doc.documentElement;
  head.insertBefore(base, head.firstChild);
  head.insertBefore(meta, head.firstChild);
  head.insertBefore(security, head.firstChild);

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

// 点击书内链接时，把 href 映射到目标章节序号；外链或未知返回 null
export function resolveInternalIndex(book: Book, fromIndex: number, href: string): number | null {
  if (isExternal(href)) return null;
  const fromPath = book.chapters[fromIndex]?.href;
  if (!fromPath) return null;
  const target = resolvePath(dirOf(fromPath), href);
  const i = book.chapters.findIndex((c) => c.href === target);
  return i >= 0 ? i : null;
}
