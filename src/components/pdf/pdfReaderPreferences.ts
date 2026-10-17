interface PdfReaderPreferences {
  pinned: boolean;
  hintSeen: boolean;
}

const KEY = "readtaylor.pdfToolbar.v1";

export function loadPdfReaderPreferences(): PdfReaderPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { pinned: value?.pinned === true, hintSeen: value?.hintSeen === true };
  } catch {
    return { pinned: false, hintSeen: false };
  }
}

export function savePdfReaderPreferences(value: PdfReaderPreferences) {
  try {
    // UI preferences only: never change a book or its PDF reading position.
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // A blocked/full local store must not prevent toolbar access in this session.
  }
}
