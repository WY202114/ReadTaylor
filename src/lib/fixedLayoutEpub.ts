export interface FixedLayoutProgress {
  percent: number;
  message: string;
}

export type FixedLayoutProgressHandler = (update: FixedLayoutProgress) => void;

interface PageImage {
  fileName: string;
  blob: Blob;
  mediaType: string;
  width: number;
  height: number;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function extensionOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function escapeXML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function naturalCompare(first: string, second: string): number {
  return first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" });
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      // Some Chromium builds reject tiny or unusual images in createImageBitmap;
      // the normal image decoder below is more tolerant.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      reject(new Error("漫画中包含无法读取的图片。"));
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

function pageDocument(page: PageImage, index: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Page ${index + 1}</title>
    <meta name="viewport" content="width=${page.width},height=${page.height}"/>
    <style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}svg{display:block;width:100%;height:100%}</style>
  </head>
  <body>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" preserveAspectRatio="xMidYMid meet">
      <image href="../images/${escapeXML(page.fileName)}" width="${page.width}" height="${page.height}"/>
    </svg>
  </body>
</html>`;
}

async function buildFixedLayoutEPUB(
  title: string,
  pages: PageImage[],
  onProgress?: FixedLayoutProgressHandler
): Promise<File> {
  if (!pages.length) throw new Error("没有找到可以制作 EPUB 的图片页面。");
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  zip.file(
    "META-INF/com.apple.ibooks.display-options.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<display_options><platform name="*"><option name="fixed-layout">true</option><option name="open-to-spread">false</option></platform></display_options>`
  );

  const imageManifest: string[] = [];
  const pageManifest: string[] = [];
  const spine: string[] = [];
  const nav: string[] = [];
  pages.forEach((page, index) => {
    const id = `page-${String(index + 1).padStart(5, "0")}`;
    const cover = index === 0 ? ' properties="cover-image"' : "";
    zip.file(`OEBPS/images/${page.fileName}`, page.blob);
    zip.file(`OEBPS/pages/${id}.xhtml`, pageDocument(page, index));
    imageManifest.push(
      `    <item id="${id}-image" href="images/${escapeXML(page.fileName)}" media-type="${page.mediaType}"${cover}/>`
    );
    pageManifest.push(
      `    <item id="${id}" href="pages/${id}.xhtml" media-type="application/xhtml+xml" properties="svg"/>`
    );
    spine.push(`    <itemref idref="${id}" properties="rendition:layout-pre-paginated"/>`);
    nav.push(`      <li><a href="pages/${id}.xhtml">第 ${index + 1} 页</a></li>`);
  });

  const identifier = globalThis.crypto?.randomUUID?.() || `readtaylor-${Date.now()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${escapeXML(identifier)}</dc:identifier>
    <dc:title>${escapeXML(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">none</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${pageManifest.join("\n")}
${imageManifest.join("\n")}
  </manifest>
  <spine page-progression-direction="ltr">
${spine.join("\n")}
  </spine>
</package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXML(title)}</title></head>
  <body><nav epub:type="toc" id="toc"><h1>${escapeXML(title)}</h1><ol>
${nav.join("\n")}
  </ol></nav></body>
</html>`
  );

  const blob = await zip.generateAsync(
    {
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      onProgress?.({
        percent: 86 + Math.round(metadata.percent * 0.14),
        message: `正在封装 EPUB… ${Math.round(metadata.percent)}%`,
      });
    }
  );
  onProgress?.({ percent: 100, message: "EPUB 已生成" });
  return new File([blob], `${title}.epub`, { type: "application/epub+zip" });
}

export async function archiveToFixedLayoutEPUB(
  file: File,
  onProgress?: FixedLayoutProgressHandler
): Promise<File> {
  onProgress?.({ percent: 3, message: "正在读取漫画压缩包…" });
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files)
    .filter((entry) => {
      const normalized = entry.name.replace(/\\/g, "/");
      return !entry.dir
        && !normalized.startsWith("__MACOSX/")
        && !normalized.includes("/.__")
        && Boolean(IMAGE_TYPES[extensionOf(normalized)]);
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!entries.length) throw new Error("压缩包中没有找到 JPG、PNG、GIF 或 WebP 图片。");

  const pages: PageImage[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const extension = extensionOf(entry.name);
    const mediaType = IMAGE_TYPES[extension];
    const bytes = await entry.async("uint8array");
    const blob = new Blob([bytes], { type: mediaType });
    const dimensions = await imageDimensions(blob);
    pages.push({
      fileName: `page-${String(index + 1).padStart(5, "0")}.${extension === "jpeg" ? "jpg" : extension}`,
      blob,
      mediaType,
      ...dimensions,
    });
    onProgress?.({
      percent: 8 + Math.round(((index + 1) / entries.length) * 74),
      message: `正在整理漫画页面 ${index + 1}/${entries.length}`,
    });
  }
  const title = file.name.replace(/\.[^.]+$/, "") || "未命名漫画";
  return buildFixedLayoutEPUB(title, pages, onProgress);
}

function canvasToJPEG(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PDF 页面无法保存为图片。"))),
      "image/jpeg",
      0.88
    );
  });
}

export async function pdfToFixedLayoutEPUB(
  file: File,
  onProgress?: FixedLayoutProgressHandler
): Promise<File> {
  onProgress?.({ percent: 2, message: "正在读取 PDF 页面…" });
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (!document.numPages) throw new Error("PDF 中没有可以读取的页面。");

  const pages: PageImage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 1800 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: Math.max(1, scale) });
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("浏览器无法创建 PDF 绘图画布。");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvasToJPEG(canvas);
      pages.push({
        fileName: `page-${String(pageNumber).padStart(5, "0")}.jpg`,
        blob,
        mediaType: "image/jpeg",
        width: canvas.width,
        height: canvas.height,
      });
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
      onProgress?.({
        percent: 6 + Math.round((pageNumber / document.numPages) * 76),
        message: `正在转换 PDF 页面 ${pageNumber}/${document.numPages}`,
      });
    }
  } finally {
    await document.destroy();
  }
  const title = file.name.replace(/\.[^.]+$/, "") || "未命名 PDF";
  return buildFixedLayoutEPUB(title, pages, onProgress);
}
