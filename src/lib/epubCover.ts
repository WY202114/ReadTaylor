import type JSZip from "jszip";
import { delFile, getFile, putFile } from "./filestore";

export interface EpubCover {
  blob: Blob;
  imagePath: string;
  documentPath?: string;
}

interface ManifestItem {
  id: string;
  href: string;
  path: string;
  mediaType: string;
  properties: string[];
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function resolvePath(baseDir: string, relativePath: string): string {
  let cleaned = relativePath.split("#")[0].split("?")[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // EPUB 内偶尔包含不完整的转义路径，保留原路径继续尝试。
  }
  const parts = (baseDir ? baseDir.split("/") : []).concat(cleaned.split("/"));
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function localTags(root: Element | Document, localName: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((element) => element.localName === localName);
}

function isImage(item: ManifestItem | undefined): item is ManifestItem {
  return Boolean(item?.mediaType.startsWith("image/"));
}

function inferImageType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/jpeg";
}

async function imageFromDocument(
  zip: JSZip,
  documentPath: string
): Promise<{ imagePath: string; textLength: number } | null> {
  const html = await zip.file(documentPath)?.async("text");
  if (!html) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const visual = document.querySelector("img[src],svg image[href],svg image[xlink\\:href]");
  const source = visual?.getAttribute("src")
    || visual?.getAttribute("href")
    || visual?.getAttribute("xlink:href")
    || "";
  if (!source || /^(data:|https?:|\/\/)/i.test(source)) return null;
  return {
    imagePath: resolvePath(dirOf(documentPath), source),
    textLength: (document.body?.textContent || "").replace(/\s+/g, "").length,
  };
}

export async function findEpubCover(
  zip: JSZip,
  opf: Document,
  opfPath: string
): Promise<EpubCover | null> {
  const opfDir = dirOf(opfPath);
  const manifest = localTags(opf, "item").map((item): ManifestItem => ({
    id: item.getAttribute("id") || "",
    href: item.getAttribute("href") || "",
    path: resolvePath(opfDir, item.getAttribute("href") || ""),
    mediaType: item.getAttribute("media-type") || "",
    properties: (item.getAttribute("properties") || "").split(/\s+/).filter(Boolean),
  }));
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const byPath = new Map(manifest.map((item) => [item.path, item]));

  const legacyCoverId = localTags(opf, "meta").find((meta) => (
    meta.getAttribute("name")?.toLowerCase() === "cover"
  ))?.getAttribute("content") || "";
  const guideCoverHref = localTags(opf, "reference").find((reference) => (
    (reference.getAttribute("type") || "").toLowerCase().split(/\s+/).includes("cover")
  ))?.getAttribute("href") || "";
  const guideCoverPath = guideCoverHref ? resolvePath(opfDir, guideCoverHref) : "";

  let imageItem = manifest.find((item) => item.properties.includes("cover-image"));
  if (!isImage(imageItem) && legacyCoverId) imageItem = byId.get(legacyCoverId);
  if (!isImage(imageItem) && guideCoverPath && isImage(byPath.get(guideCoverPath))) {
    imageItem = byPath.get(guideCoverPath);
  }
  if (!isImage(imageItem)) {
    imageItem = manifest.find((item) => (
      isImage(item) && /(^|[/_.-])cover([/_.-]|$)/i.test(`${item.id} ${item.href}`)
    ));
  }

  let documentPath = guideCoverPath && !isImage(byPath.get(guideCoverPath)) ? guideCoverPath : undefined;
  let imagePath = isImage(imageItem) ? imageItem.path : "";

  if (documentPath) {
    const documentImage = await imageFromDocument(zip, documentPath);
    if (documentImage) imagePath = documentImage.imagePath;
  }

  const spinePaths = localTags(opf, "itemref")
    .map((itemref) => byId.get(itemref.getAttribute("idref") || ""))
    .filter((item): item is ManifestItem => Boolean(item))
    .map((item) => item.path);
  for (const path of spinePaths.slice(0, 3)) {
    const documentImage = await imageFromDocument(zip, path);
    if (!documentImage) continue;
    if (imagePath && documentImage.imagePath === imagePath) {
      documentPath = path;
      break;
    }
    if (!imagePath && path === spinePaths[0] && documentImage.textLength < 60) {
      imagePath = documentImage.imagePath;
      documentPath = path;
      break;
    }
  }

  if (!imagePath) return null;
  const entry = zip.file(imagePath);
  if (!entry) return null;
  const original = await entry.async("blob");
  const mediaType = byPath.get(imagePath)?.mediaType || inferImageType(imagePath);
  return {
    blob: original.slice(0, original.size, mediaType),
    imagePath,
    documentPath,
  };
}

export function coverFileKey(bookId: string): string {
  return `cover:${bookId}`;
}

export async function storeBookCover(bookId: string, cover: Blob | null): Promise<void> {
  if (cover) await putFile(coverFileKey(bookId), cover);
  else await delFile(coverFileKey(bookId));
}

const pendingCoverLoads = new Map<string, Promise<Blob | null>>();

async function loadBookCoverOnce(bookId: string): Promise<Blob | null> {
  const stored = await getFile(coverFileKey(bookId));
  if (stored) return stored;

  const epub = await getFile(bookId);
  if (!epub) return null;
  try {
    const JSZipModule = (await import("jszip")).default;
    const zip = await JSZipModule.loadAsync(epub);
    const containerText = await zip.file("META-INF/container.xml")?.async("text");
    if (!containerText) return null;
    const parser = new DOMParser();
    const container = parser.parseFromString(containerText, "application/xml");
    const opfPath = container.querySelector("rootfile")?.getAttribute("full-path") || "";
    const opfText = opfPath ? await zip.file(opfPath)?.async("text") : "";
    if (!opfPath || !opfText) return null;
    const cover = await findEpubCover(zip, parser.parseFromString(opfText, "application/xml"), opfPath);
    if (!cover) return null;
    await storeBookCover(bookId, cover.blob);
    return cover.blob;
  } catch {
    return null;
  }
}

export function loadBookCover(bookId: string): Promise<Blob | null> {
  const existing = pendingCoverLoads.get(bookId);
  if (existing) return existing;
  const pending = loadBookCoverOnce(bookId);
  pendingCoverLoads.set(bookId, pending);
  void pending.finally(() => {
    if (pendingCoverLoads.get(bookId) === pending) pendingCoverLoads.delete(bookId);
  });
  return pending;
}
