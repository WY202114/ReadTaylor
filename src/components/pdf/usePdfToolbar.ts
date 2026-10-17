import { useEffect, useRef, useState, type PointerEvent } from "react";
import { loadPdfReaderPreferences, savePdfReaderPreferences } from "./pdfReaderPreferences";

/** Only explicit pin/hide actions persist; hovering never changes the next-open preference. */
export function usePdfToolbar() {
  const [preferences, setPreferences] = useState(loadPdfReaderPreferences);
  const [peeking, setPeeking] = useState(false);
  const [hint, setHint] = useState(false);
  const hoverTimer = useRef<number>();
  const leaveTimer = useRef<number>();
  const pinned = preferences.pinned;

  useEffect(() => { savePdfReaderPreferences(preferences); }, [preferences]);
  useEffect(() => {
    if (!pinned && !preferences.hintSeen) {
      setHint(true);
      setPreferences((previous) => ({ ...previous, hintSeen: true }));
    }
  }, [pinned, preferences.hintSeen]);
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(false), 3000);
    return () => window.clearTimeout(timer);
  }, [hint]);
  useEffect(() => () => {
    window.clearTimeout(hoverTimer.current);
    window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
  }, []);

  const pin = (value: boolean) => {
    window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined;
    window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
    setPeeking(false); setHint(false);
    setPreferences((previous) => ({ ...previous, pinned: value }));
  };
  const dismissPeek = () => {
    window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined;
    window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
    setPeeking(false);
  };
  const pointerMove = (event: PointerEvent<HTMLElement>, toolbarBottom: number) => {
    if (pinned || event.pointerType === "touch") return;
    const top = event.currentTarget.getBoundingClientRect().top;
    if (event.clientY <= top + 8) {
      window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
      if (!peeking && hoverTimer.current === undefined) {
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = undefined; setPeeking(true); setHint(false);
        }, 300);
      }
    } else {
      window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined;
      if (peeking && event.clientY > toolbarBottom && leaveTimer.current === undefined) {
        leaveTimer.current = window.setTimeout(() => {
          leaveTimer.current = undefined; setPeeking(false);
        }, 180);
      } else if (event.clientY <= toolbarBottom) {
        window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined;
      }
    }
  };
  return { pinned, peeking, hint, pin, pointerMove, dismissPeek };
}
