import { useEffect, useRef, useState } from "react";
import { api, PlayerLite } from "../api";
import { Headshot } from "./common";
import { useSticky } from "../lib/sticky";

/** `inline` is the phone's search sheet: the list sits under the box instead of
 *  dropping over the page, the rows are big enough for a thumb, and before
 *  anything is typed it offers the players looked up most recently. */
export default function PlayerSearch({ onSelect, placeholder = "Search any player…", autoFocus = false, inline = false }: { onSelect: (p: PlayerLite) => void; placeholder?: string; autoFocus?: boolean; inline?: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PlayerLite[]>([]);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [all, setAll] = useState(false);   // false = current players only
  const [recent, setRecent] = useSticky<PlayerLite[]>("search.recent", []);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!q.trim()) { setRows([]); return; }
    const t = setTimeout(() => api.search(q, { limit: 12, active: !all }).then((r) => { setRows(r); setI(0); setOpen(true); }).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [q, all]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  // A sheet slides in, and focusing mid-slide makes iOS scroll the page to
  // chase the caret; waiting for the slide to finish keeps it still.
  useEffect(() => {
    if (!inline || !autoFocus) return;
    const t = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 260);
    return () => window.clearTimeout(t);
  }, [inline, autoFocus]);
  const pick = (p: PlayerLite) => {
    setRecent((r) => [p, ...r.filter((x) => x.player_id !== p.player_id)].slice(0, 6));
    onSelect(p); setQ(""); setOpen(false);
  };
  const row = (p: PlayerLite, k: number) => (
    <div key={p.player_id} className={`row ${k === i ? "active" : ""}`} style={inline ? { animationDelay: `${Math.min(k, 10) * 22}ms` } : undefined}
      onMouseEnter={() => setI(k)} onMouseDown={inline ? undefined : () => pick(p)} onClick={inline ? () => pick(p) : undefined}>
      <Headshot src={p.headshot} size={inline ? 48 : 36} />
      <div style={{ minWidth: 0 }}>
        <div className="row-name">{p.name} <span className="muted">{p.position}</span></div>
        <div className="meta">{p.team ?? "FA"} · {p.first_season}–{p.last_season} · {p.games} games</div>
      </div>
    </div>
  );
  const showList = inline ? !!q.trim() : open && (rows.length > 0 || !!q.trim());
  return (
    <div className={`search ${inline ? "inline" : ""}`} ref={box}>
      <input ref={input} className="input" value={q} placeholder={placeholder} autoFocus={autoFocus && !inline}
        type="search" enterKeyHint="go" autoComplete="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => setQ(e.target.value)} onFocus={() => rows.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { setI((x) => Math.min(rows.length - 1, x + 1)); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setI((x) => Math.max(0, x - 1)); e.preventDefault(); }
          else if (e.key === "Enter" && rows[i]) pick(rows[i]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {inline && !q.trim() && recent.length > 0 && (
        <div className="results">
          <div className="results-label">Recent</div>
          {recent.map(row)}
        </div>
      )}
      {inline && !q.trim() && recent.length === 0 && <div className="search-empty">Anyone who has played since 1999. Start typing a name.</div>}
      {showList && (
        <div className="results">
          {rows.length === 0 && <div className="row muted small">No {all ? "" : "current "}player matches.</div>}
          {rows.map(row)}
          <div className="row small" style={{ borderTop: "1px solid var(--border)", justifyContent: "space-between" }}
            onMouseDown={inline ? undefined : (e) => { e.preventDefault(); setAll(!all); }} onClick={inline ? () => setAll(!all) : undefined}>
            <span className="muted">{all ? "Searching everyone since 1999" : "Current players only"}</span>
            <span style={{ color: "var(--accent)" }}>{all ? "current only" : "include retired"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
