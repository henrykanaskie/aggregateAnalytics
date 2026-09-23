import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { FantasyPlayer, FantasyWeek, PlayerLite } from "../api";
import type { Scoring } from "../lib/profile";
import { rankTint } from "../lib/rank";
import PlayerSearch from "./PlayerSearch";

// Your roster, and the lineup it makes this week.
//
// The lineup is filled greedily: each fixed slot takes the best projected
// players at its position, then FLEX takes the best remaining RB/WR/TE, then
// superflex the best remaining of anyone. Because each later slot accepts
// everything the earlier ones did and more, filling in that order is the best
// lineup the projections allow; no swap can raise the total.

export interface RosterEntry { player_id: string; name: string; position: string; team: string | null }
export interface Slots { QB: number; RB: number; WR: number; TE: number; FLEX: number; SFLEX: number }
export const DEFAULT_SLOTS: Slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SFLEX: 0 };

const OUT = ["Out", "Doubtful", "IR"];
const FLEX_POS = ["RB", "WR", "TE"];
const SLOT_LABEL: Record<keyof Slots, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "FLEX", SFLEX: "SUPERFLEX" };
/** Within this many points, a bench player is worth a second look. */
const CLOSE = 1.5;

export type Row = { entry: RosterEntry; p: FantasyPlayer | null; proj: number | null; why: string | null };
export type LineupSlot = { slot: keyof Slots; row: Row | null };

/** Each roster player against this week: projection, and why not, if they can't start. */
export function rosterRows(roster: RosterEntry[], data: FantasyWeek, scoring: Scoring, byId?: Map<string, FantasyPlayer>): Row[] {
  const idx = byId ?? new Map(data.players.map((p) => [p.player_id, p]));
  return roster.map((entry) => {
    const p = idx.get(entry.player_id) ?? null;
    const proj = p?.proj[scoring]?.value ?? null;
    const why = p ? (p.status && OUT.includes(p.status) ? p.status : proj === null ? "too few games to project" : null)
      : entry.team && data.byes.includes(entry.team) ? "bye" : "not on a depth chart this week";
    return { entry, p, proj, why };
  });
}

/** The best lineup the projections allow (see the note at the top). */
export function bestLineup(rows: Row[], slots: Slots): { lineup: LineupSlot[]; bench: Row[] } {
  const pool = rows.filter((r) => !r.why).sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));
  const used = new Set<string>();
  const lineup: LineupSlot[] = [];
  const take = (slot: keyof Slots, ok: (pos: string) => boolean) => {
    const r = pool.find((x) => !used.has(x.entry.player_id) && ok(x.entry.position));
    if (r) used.add(r.entry.player_id);
    lineup.push({ slot, row: r ?? null });
  };
  for (const s of ["QB", "RB", "WR", "TE"] as const) for (let i = 0; i < slots[s]; i++) take(s, (pos) => pos === s);
  for (let i = 0; i < slots.FLEX; i++) take("FLEX", (pos) => FLEX_POS.includes(pos));
  for (let i = 0; i < slots.SFLEX; i++) take("SFLEX", (pos) => pos === "QB" || FLEX_POS.includes(pos));
  const bench = rows.filter((r) => !used.has(r.entry.player_id)).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
  return { lineup, bench };
}
export { SLOT_LABEL };

export function toEntry(p: PlayerLite | FantasyPlayer): RosterEntry {
  return { player_id: p.player_id, name: p.name, position: p.position, team: p.team ?? null };
}

export default function MyRoster({ data, scoring, roster, setRoster, slots, setSlots, onCompare }: {
  data: FantasyWeek; scoring: Scoring; roster: RosterEntry[]; setRoster: (r: RosterEntry[]) => void;
  slots: Slots; setSlots: (s: Slots) => void; onCompare: (ids: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const byId = useMemo(() => new Map(data.players.map((p) => [p.player_id, p])), [data]);

  const { lineup, bench } = useMemo(() => bestLineup(rosterRows(roster, data, scoring, byId), slots), [roster, data, scoring, slots, byId]);

  const eligible = (slot: keyof Slots, pos: string) =>
    slot === pos || (slot === "FLEX" && FLEX_POS.includes(pos)) || (slot === "SFLEX" && (pos === "QB" || FLEX_POS.includes(pos)));
  // The weakest starter a bench player could replace, if the gap is small.
  const closeCall = (b: Row) => {
    if (b.why || b.proj === null) return null;
    const rivals = lineup.filter((l) => l.row && eligible(l.slot, b.entry.position)).map((l) => l.row!);
    const weakest = rivals.sort((x, y) => (x.proj ?? 0) - (y.proj ?? 0))[0];
    return weakest && (weakest.proj ?? 0) - b.proj <= CLOSE ? weakest : null;
  };

  const total = lineup.reduce((a, l) => a + (l.row?.proj ?? 0), 0);
  const empty = lineup.filter((l) => !l.row).length;
  const remove = (id: string) => setRoster(roster.filter((r) => r.player_id !== id));
  const add = (p: PlayerLite) => { if (!roster.some((r) => r.player_id === p.player_id)) setRoster([...roster, toEntry(p)]); };

  const Player = ({ r }: { r: Row }) => (
    <>
      <Link to={`/research?player=${r.entry.player_id}`}><b>{r.entry.name}</b></Link> <span className="muted">{r.entry.position} {r.entry.team ?? ""}</span>
      {r.p?.status && <span className={`pill ${OUT.includes(r.p.status) ? "under" : "warn"}`} title={r.p.injury ?? undefined}>{r.p.status}</span>}
    </>
  );
  const Game = ({ p }: { p: FantasyPlayer | null }) => p
    ? <span className="small">{p.home ? "vs" : "@"} {p.opponent} <span className="matchup-dot" style={{ background: rankTint(p.matchup_rank, p.matchup_n) }} title={p.matchup_rank ? `${p.opponent} gives up the #${p.matchup_rank} most to ${p.position}s` : undefined} /></span>
    : <span className="muted small">–</span>;

  return (
    <div className="panel roster" data-tour="my-roster">
      <div className="panel-head">
        <h3>My roster · week {data.week}</h3>
        <div className="actions">
          <span className="hint">{(Object.keys(slots) as (keyof Slots)[]).filter((k) => slots[k]).map((k) => `${slots[k]} ${SLOT_LABEL[k]}`).join(" · ")}</span>
          <button className="btn sm ghost" onClick={() => setEditing(!editing)}>{editing ? "done" : "lineup slots"}</button>
        </div>
      </div>
      {editing && (
        <div className="controls" style={{ marginBottom: 10 }}>
          {(Object.keys(slots) as (keyof Slots)[]).map((k) => (
            <label key={k} className="field"><span>{SLOT_LABEL[k]}</span>
              <select className="input" value={slots[k]} onChange={(e) => setSlots({ ...slots, [k]: Number(e.target.value) })}>{[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
          ))}
          <button className="btn sm" onClick={() => setSlots(DEFAULT_SLOTS)}>reset</button>
        </div>
      )}
      <div className="roster-add"><PlayerSearch onSelect={add} placeholder="Add a player to your roster…" /><span className="hint">or star ☆ anyone in the table below</span></div>

      {roster.length === 0 ? <div className="hint" style={{ marginTop: 8 }}>Add your players and this becomes your lineup for the week: who to start in each slot by projection, who is on bye or listed out, and which bench calls are close enough to look at twice.</div> : (
        <div className="grid grid-2" style={{ marginTop: 10, alignItems: "start" }}>
          <div>
            <div className="roster-sub"><b>Best lineup</b> <span className="num">{total.toFixed(1)} projected</span>{empty > 0 && <span className="pill warn">{empty} slot{empty === 1 ? "" : "s"} unfilled</span>}</div>
            <table className="tbl compact"><tbody>
              {lineup.map((l, i) => (
                <tr key={i}>
                  <td className="left slot">{SLOT_LABEL[l.slot]}</td>
                  <td className="left">{l.row ? <Player r={l.row} /> : <span className="muted">nobody available</span>}</td>
                  <td className="left">{l.row && <Game p={l.row.p} />}</td>
                  <td className="num"><b>{l.row?.proj?.toFixed(1) ?? "–"}</b></td>
                  <td className="num muted small" title="floor to ceiling, the middle half of outcomes">{l.row?.p?.proj[scoring] ? `${l.row.p.proj[scoring]!.low.toFixed(0)}-${l.row.p.proj[scoring]!.high.toFixed(0)}` : ""}</td>
                  <td className="num">{l.row && <button className="btn sm ghost" title="Remove from roster" onClick={() => remove(l.row!.entry.player_id)}>×</button>}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
          <div>
            <div className="roster-sub"><b>Bench</b> <span className="muted small">{bench.length}</span></div>
            <table className="tbl compact"><tbody>
              {bench.map((b) => { const rival = closeCall(b); return (
                <tr key={b.entry.player_id}>
                  <td className="left"><Player r={b} />{b.why && <span className="pill">{b.why}</span>}</td>
                  <td className="left"><Game p={b.p} /></td>
                  <td className="num">{b.proj?.toFixed(1) ?? "–"}</td>
                  <td className="num">
                    {rival && <button className="btn sm" title={`Within ${CLOSE} points of ${rival.entry.name}; compare them in start / sit`} onClick={() => onCompare([rival.entry.player_id, b.entry.player_id])}>vs {rival.entry.name.split(" ").slice(-1)[0]}?</button>}
                    <button className="btn sm ghost" title="Remove from roster" onClick={() => remove(b.entry.player_id)}>×</button>
                  </td>
                </tr>
              ); })}
              {bench.length === 0 && <tr><td className="left muted small">Everyone on the roster is starting.</td></tr>}
            </tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}
