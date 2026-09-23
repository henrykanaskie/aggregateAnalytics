import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, api2, CoachSummary, PlayerLite } from "../api";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import { Headshot } from "./common";

// One box for everything with a page: players (from the API, as you type),
// teams and head coaches (matched here, from lists the app already has).

type Hit =
  | { kind: "player"; key: string; label: string; sub: string; to: string; p: PlayerLite }
  | { kind: "team" | "coach"; key: string; label: string; sub: string; to: string };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "");

export default function OmniSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const { meta } = useMeta();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [players, setPlayers] = useState<PlayerLite[]>([]);
  const [i, setI] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data: coaches } = useQuery<CoachSummary[]>(api2.coaches.url("HC"));

  useEffect(() => {
    if (q.trim().length < 2) { setPlayers([]); return; }
    const t = setTimeout(() => api.search(q, { limit: 6, active: true }).then(setPlayers).catch(() => setPlayers([])), 120);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const hits: Hit[] = useMemo(() => {
    const s = norm(q.trim());
    if (!s) return [];
    const teams = (meta?.teams ?? []).filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr))
      .filter((t) => norm(t.team_name).includes(s) || norm(t.team_abbr) === s || norm(t.team_nick ?? "").startsWith(s)).slice(0, 3)
      .map((t) => ({ kind: "team" as const, key: `t:${t.team_abbr}`, label: t.team_name, sub: "team tendencies, usage, who gets the ball", to: `/teams?team=${t.team_abbr}` }));
    // Current head coaches first, then anyone who has held the job since 1999.
    const current = new Set(Object.values(meta?.current_coaches ?? {}));
    const cs = (coaches ?? []).filter((c) => norm(c.coach).split(" ").some((w) => w.startsWith(s)) || norm(c.coach).includes(s))
      .sort((a, b) => Number(current.has(b.coach)) - Number(current.has(a.coach)) || b.last_season - a.last_season).slice(0, 3)
      .map((c) => ({ kind: "coach" as const, key: `c:${c.coach}`, label: c.coach, sub: `head coach${c.current_team ? `, ${c.current_team}` : ""} · ${c.first_season}-${c.last_season}`, to: `/coaches?coach=${encodeURIComponent(c.coach)}&role=HC` }));
    const ps = players.map((p) => ({ kind: "player" as const, key: `p:${p.player_id}`, label: p.name, sub: `${p.position} · ${p.team}`, to: `/research?player=${p.player_id}`, p }));
    return [...ps, ...teams, ...cs];
  }, [q, players, meta, coaches]);
  useEffect(() => setI(0), [hits.length]);

  const go = (h: Hit) => { setQ(""); setOpen(false); nav(h.to); };
  const groups: [Hit["kind"], string][] = [["player", "Players"], ["team", "Teams"], ["coach", "Coaches"]];
  return (
    <div className="omni" ref={box}>
      <input className="input omni-input" value={q} autoFocus={autoFocus} placeholder="Search a player, a team or a coach…" aria-label="Search players, teams and coaches"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { setI((x) => Math.min(hits.length - 1, x + 1)); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setI((x) => Math.max(0, x - 1)); e.preventDefault(); }
          else if (e.key === "Enter" && hits[i]) go(hits[i]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && hits.length > 0 && (
        <div className="omni-results" role="listbox">
          {groups.map(([kind, title]) => {
            const g = hits.filter((h) => h.kind === kind);
            if (!g.length) return null;
            return (
              <div key={kind}>
                <div className="omni-group">{title}</div>
                {g.map((h) => { const idx = hits.indexOf(h); return (
                  <button key={h.key} role="option" aria-selected={idx === i} className={`omni-hit ${idx === i ? "on" : ""}`} onMouseEnter={() => setI(idx)} onClick={() => go(h)}>
                    {h.kind === "player" ? <Headshot src={h.p.headshot} size={28} /> : <span className={`omni-icon ${h.kind}`}>{h.kind === "team" ? "T" : "C"}</span>}
                    <span><b>{h.label}</b><span className="muted small"> {h.sub}</span></span>
                  </button>
                ); })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
