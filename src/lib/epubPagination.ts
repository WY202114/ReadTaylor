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
  fontSize = 16
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

  if (fixedLayout) {
    style.textContent = `
      html, body {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        overflow: hidden !important;
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
  if (fixedLayout) return { pageCount: 1, pageWidth };
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
