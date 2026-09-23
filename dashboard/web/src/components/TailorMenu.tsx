import { useEffect, useRef, useState } from "react";
import { useMeta } from "../state";
import Spark from "./Spark";

/** The Tailor button in the top bar. With no answers yet it opens the
 *  questions; once there are answers it opens a small menu: change them,
 *  switch between the tailored and the standard layout (answers kept either
 *  way), or clear them. */
export default function TailorMenu({ onTailor }: { onTailor: () => void }) {
  const { settings, setSettings } = useMeta();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const saved = !!settings.profile;
  const on = saved && settings.tailored !== false;
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const go = (f: () => void) => () => { setOpen(false); f(); };
  return (
    <div className="tailor-menu" ref={box}>
      <button className={`tailor-btn ${on ? "set" : ""} ${saved && !on ? "off" : ""}`} aria-haspopup={saved ? "menu" : undefined} aria-expanded={saved ? open : undefined}
        title={!saved ? "Answer a few questions and the pages rearrange around what you care about" : on ? "Your layout is tailored" : "Tailoring is off: you're seeing the standard layout"}
        onClick={() => (saved ? setOpen(!open) : onTailor())}>
        <Spark /><span className="label">{!saved ? "Tailor" : on ? "Tailored" : "Standard"}</span>
      </button>
      {open && (
        <div className="tailor-pop" role="menu">
          <button role="menuitem" onClick={go(() => setSettings({ tailored: !on }))}>
            <b>{on ? "Switch to the standard layout" : "Switch back to tailored"}</b>
            <span>{on ? "Every page as it is for everyone. Your answers are kept." : "Your layout, your colours, your home page."}</span>
          </button>
          <button role="menuitem" onClick={go(onTailor)}><b>Change answers</b><span>Run the questions again, starting from your current answers.</span></button>
          <button role="menuitem" className="danger" onClick={go(() => { if (window.confirm("Clear your tailoring answers? The site goes back to its standard layout.")) setSettings({ profile: null, tailored: true }); })}>
            <b>Clear answers</b><span>Forget them. The roster on the Fantasy page stays.</span>
          </button>
        </div>
      )}
    </div>
  );
}
