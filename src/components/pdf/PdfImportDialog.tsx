import { useEffect, useRef, useState } from "react";
import type { PdfReadingMode } from "../../lib/pdf/types";

export function PdfImportDialog({ name, onChoose }: { name: string; onChoose: (mode: PdfReadingMode | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<PdfReadingMode>("original");
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} className="pdf-import-dialog" aria-labelledby="pdf-import-title" onCancel={(event) => { event.preventDefault(); onChoose(null); }}>
      <h2 id="pdf-import-title">如何阅读这份 PDF</h2>
      <p className="pdf-import-name">{name}</p>
      <fieldset>
        <legend className="pdf-sr-only">阅读方式</legend>
        <label><input type="radio" name="pdf-mode" value="original" checked={mode === "original"} onChange={() => setMode("original")} autoFocus /><span><strong>原版阅读 · 推荐论文使用</strong><small>保留原页面、双栏、公式和图表，支持文字选择与搜索。</small></span></label>
        <label><input type="radio" name="pdf-mode" value="reflow" checked={mode === "reflow"} onChange={() => setMode("reflow")} /><span><strong>重排阅读</strong><small>沿用文字阅读方式；无文字层时使用图片页面，复杂排版可能丢失。</small></span></label>
      </fieldset>
      <p>两种方式都会在本机保存原 PDF。无文字层的页面只记录标记，不进行 OCR。</p>
      <footer><button type="button" onClick={() => onChoose(null)}>取消</button><button type="button" className="pdf-primary" onClick={() => onChoose(mode)}>导入书籍</button></footer>
    </dialog>
  );
}
