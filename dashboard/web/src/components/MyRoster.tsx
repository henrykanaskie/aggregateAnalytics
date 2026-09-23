import type { FantasyPlayer, FantasyWeek, PlayerLite } from "../api";
import type { Scoring } from "../lib/profile";

// Your roster, and the lineup it makes this week: the shared helpers behind the
// home page's lineup card and the Fantasy page's My team view (MyTeam.tsx).
//
// The lineup is filled greedily: each fixed slot takes the best projected
// players at its position, then FLEX takes the best remaining RB/WR/TE, then
// superflex the best remaining of anyone. Because each later slot accepts
// everything the earlier ones did and more, filling in that order is the best
// lineup the projections allow; no swap can raise the total.

export interface RosterEntry { player_id: string; name: string; position: string; team: string | null }
export interface Slots { QB: number; RB: number; WR: number; TE: number; FLEX: number; SFLEX: number; K: number; DST: number }
export const DEFAULT_SLOTS: Slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SFLEX: 0, K: 1, DST: 1 };
/** Slots saved before a slot existed (kickers and defenses came later) get its default. */
export const withDefaults = (s: Partial<Slots> | null | undefined): Slots => ({ ...DEFAULT_SLOTS, ...(s ?? {}) });

const OUT = ["Out", "Doubtful", "IR"];
const FLEX_POS = ["RB", "WR", "TE"];
const SLOT_LABEL: Record<keyof Slots, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "FLEX", SFLEX: "SUPERFLEX", K: "K", DST: "D/ST" };
/** The order slots are shown and edited in. */
export const SLOT_ORDER: (keyof Slots)[] = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "K", "DST"];

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
export function bestLineup(rows: Row[], saved: Slots): { lineup: LineupSlot[]; bench: Row[] } {
  const slots = withDefaults(saved);
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
  // Kicker and defense are their own slots and never flex.
  for (const s of ["K", "DST"] as const) for (let i = 0; i < slots[s]; i++) take(s, (pos) => pos === s);
  const bench = rows.filter((r) => !used.has(r.entry.player_id)).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
  return { lineup, bench };
}
export { SLOT_LABEL };

export function toEntry(p: PlayerLite | FantasyPlayer): RosterEntry {
  return { player_id: p.player_id, name: p.name, position: p.position, team: p.team ?? null };
}
