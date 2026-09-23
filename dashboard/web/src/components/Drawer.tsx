import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMobile } from "../lib/useMobile";
import Sheet from "./Sheet";

/** A detail panel that slides in from the right over the page, for opening
 *  one row of a table without leaving it. On a phone it is a tall bottom
 *  sheet instead. The veil, Escape and the close button dismiss it. */
export default function Drawer({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode;
}) {
  const mobile = useMobile();
  useEffect(() => {
    if (!open || mobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open, mobile]);

  if (mobile) return <Sheet open={open} onClose={onClose} tall title={<div className="drawer-title">{title}</div>}>{children}</Sheet>;
  if (!open) return null;
  return createPortal(
    <div className="drawer-root">
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="drawer-title">{title}</div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
