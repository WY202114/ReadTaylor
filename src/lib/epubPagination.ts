export interface FramePagination {
  pageCount: number;
  pageWidth: number;
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

export async function paginateFrame(
  frame: HTMLIFrameElement,
  fixedLayout: boolean,
  fontSize = 16,
  coverCandidate = false
): Promise<FramePagination> {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return { pageCount: 1, pageWidth: Math.max(1, frame.clientWidth) };

  let style = doc.getElementById("readtaylor-pagination") as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = "readtaylor-pagination";
    doc.head.appendChild(style);
  }

  const bodyText = (doc.body?.innerText || "").replace(/\s+/g, "");
  const hasCoverVisual = Boolean(doc.body?.querySelector("img,svg"));
  const explicitCover = /(^|[\s_-])(cover|封面)([\s_-]|$)/i.test([
    doc.title,
    doc.body?.id,
    doc.body?.className,
  ].filter(Boolean).join(" "));
  const singlePageLayout = fixedLayout || (
    coverCandidate && hasCoverVisual && (explicitCover || bodyText.length < 60)
  );

  if (singlePageLayout) {
    style.textContent = `
      html, body {
        box-sizing: border-box !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
      }
      body {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      body > * {
        max-width: 100% !important;
        max-height: 100% !important;
        margin: auto !important;
      }
      img, svg, image {
        width: auto !important;
        height: auto !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        object-fit: contain !important;
        break-inside: avoid !important;
      }
    `;
  } else {
    const compactLayout = frame.clientWidth < 480;
    const sidePadding = compactLayout
      ? Math.max(16, Math.round(frame.clientWidth * 0.05))
      : Math.min(52, Math.max(24, Math.round(frame.clientWidth * 0.04)));
    const topPadding = compactLayout ? 20 : 28;
    const bottomPadding = compactLayout ? 24 : 34;
    const columnGap = sidePadding * 2;
    style.textContent = `
      html {
        width: 100% !important;
        height: 100% !important;
        font-size: ${fontSize}px !important;
        overflow: hidden !important;
        scroll-behavior: auto !important;
      }
      body {
        box-sizing: border-box !important;
        width: 100% !important;
        min-width: 100% !important;
        max-width: none !important;
        height: 100vh !important;
        min-height: 0 !important;
        max-height: 100vh !important;
        margin: 0 !important;
        font-size: ${fontSize}px !important;
        padding: ${topPadding}px ${sidePadding}px ${bottomPadding}px !important;
        overflow: visible !important;
        column-width: calc(100vw - ${columnGap}px) !important;
        column-gap: ${columnGap}px !important;
        column-fill: auto !important;
      }
      img, svg, image, figure, table, pre, blockquote {
        max-width: 100% !important;
        break-inside: avoid;
      }
    `;
  }

  if (doc.fonts?.ready) await doc.fonts.ready.catch(() => undefined);
  await nextFrame(win);
  await nextFrame(win);

  const pageWidth = Math.max(1, frame.clientWidth);
  if (singlePageLayout) return { pageCount: 1, pageWidth };
  const scrollWidth = Math.max(
    doc.documentElement.scrollWidth,
    doc.body?.scrollWidth || 0,
    pageWidth
  );
  const pageCount = Math.max(1, Math.ceil((scrollWidth - 1) / pageWidth));
  return { pageCount, pageWidth };
}

export function scrollFrameToPage(frame: HTMLIFrameElement | null, pageIndex: number): void {
  const win = frame?.contentWindow;
  if (!frame || !win) return;
  win.scrollTo({ left: Math.max(0, pageIndex) * Math.max(1, frame.clientWidth), top: 0, behavior: "auto" });
}
