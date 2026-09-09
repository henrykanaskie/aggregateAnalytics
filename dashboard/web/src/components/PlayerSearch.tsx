import { useEffect, useRef, useState } from "react";
import { api, PlayerLite } from "../api";
import { Headshot } from "./common";

export default function PlayerSearch({ onSelect, placeholder = "Search any player…", autoFocus = false }: { onSelect: (p: PlayerLite) => void; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PlayerLite[]>([]);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [all, setAll] = useState(false);   // false = current players only
  const box = useRef<HTMLDivElement>(null);
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
  const pick = (p: PlayerLite) => { onSelect(p); setQ(""); setOpen(false); };
  return (
    <div className="search" ref={box}>
      <input className="input" value={q} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)} onFocus={() => rows.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { setI((x) => Math.min(rows.length - 1, x + 1)); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setI((x) => Math.max(0, x - 1)); e.preventDefault(); }
          else if (e.key === "Enter" && rows[i]) pick(rows[i]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && (rows.length > 0 || q.trim()) && (
        <div className="results">
          {rows.length === 0 && <div className="row muted small">No {all ? "" : "current "}player matches.</div>}
          {rows.map((p, k) => (
            <div key={p.player_id} className={`row ${k === i ? "active" : ""}`} onMouseEnter={() => setI(k)} onMouseDown={() => pick(p)}>
              <Headshot src={p.headshot} />
              <div>
                <div>{p.name} <span className="muted">{p.position}</span></div>
                <div className="meta">{p.team ?? "FA"} · {p.first_season}–{p.last_season} · {p.games} games</div>
              </div>
            </div>
          ))}
          <div className="row small" style={{ borderTop: "1px solid var(--border)", justifyContent: "space-between" }} onMouseDown={(e) => { e.preventDefault(); setAll(!all); }}>
            <span className="muted">{all ? "Searching everyone since 1999" : "Current players only"}</span>
            <span style={{ color: "var(--accent)" }}>{all ? "current only" : "include retired"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
