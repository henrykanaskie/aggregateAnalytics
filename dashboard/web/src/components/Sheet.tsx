import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** A panel that rises from the bottom of a phone screen. It follows a finger
 *  dragged down on its handle and lets go past a third of its height or on a
 *  quick flick, the way a native sheet does; the veil, Escape and the close
 *  button dismiss it too. It stays mounted through its exit so it slides out
 *  rather than vanishing. */
export default function Sheet({ open, onClose, title, tall = false, children, className = "" }: {
  open: boolean; onClose: () => void; title?: React.ReactNode; tall?: boolean; children: React.ReactNode; className?: string;
}) {
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; t: number } | null>(null);

  useEffect(() => {
    if (open) { setShown(true); setLeaving(false); setDrag(0); return; }
    if (!shown) return;
    setLeaving(true);
    const t = window.setTimeout(() => { setShown(false); setLeaving(false); setDrag(0); }, 240);
    return () => window.clearTimeout(t);
  }, [open]);

  // The page underneath holds still while a sheet is up.
  useEffect(() => {
    if (!shown) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [shown]);

  if (!shown) return null;

  const onStart = (e: React.TouchEvent) => { start.current = { y: e.touches[0].clientY, t: performance.now() }; };
  const onMove = (e: React.TouchEvent) => {
    if (!start.current) return;
    setDrag(Math.max(0, e.touches[0].clientY - start.current.y));
  };
  const onEnd = () => {
    if (!start.current) return;
    const h = panel.current?.offsetHeight ?? 400;
    const v = drag / Math.max(1, performance.now() - start.current.t);
    start.current = null;
    if (drag > h / 3 || (drag > 40 && v > 0.6)) onClose();
    else setDrag(0);
  };
  const grab = { onTouchStart: onStart, onTouchMove: onMove, onTouchEnd: onEnd, onTouchCancel: onEnd };

  return createPortal(
    <div className={`sheet-root ${leaving ? "leaving" : ""}`}>
      <div className="sheet-veil" onClick={onClose} style={drag ? { opacity: Math.max(0.2, 1 - drag / 500) } : undefined} />
      <div ref={panel} role="dialog" aria-modal="true" className={`sheet ${tall ? "tall" : ""} ${drag ? "dragging" : ""} ${className}`}
        style={drag ? { transform: `translateY(${drag}px)`, ["--from" as string]: `${drag}px` } : undefined}>
        <div className="sheet-grab" {...grab}><span /></div>
        {title && <div className="sheet-head" {...grab}>{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
