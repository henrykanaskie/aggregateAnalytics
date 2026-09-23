import type { FantasyPlayer, FantasyWeek, PlayerLite } from "../api";
import type { Scoring } from "../lib/profile";

// Your roster, and the lineup it makes this week: the shared helpers behind the
// home page's lineup card and the Fantasy page's My team view (MyTeam.tsx).
//
// Each fixed slot takes the best projected players at its position; the flex
// slots (RB/WR, WR/TE, FLEX, superflex) are then filled exactly, not greedily.
// Greedy was right while each flex accepted everything the one before it did,
// but two narrow flexes overlap: with a WR 10, an RB 9 and a TE 1 left for an
// RB/WR and a WR/TE slot, greedy puts the WR in RB/WR and the TE in WR/TE
// (11) where RB + WR is 19. See assignFlex.

export interface RosterEntry { player_id: string; name: string; position: string; team: string | null }
export interface Slots { QB: number; RB: number; WR: number; TE: number; RBWR: number; WRTE: number; FLEX: number; SFLEX: number; K: number; DST: number }
export const DEFAULT_SLOTS: Slots = { QB: 1, RB: 2, WR: 2, TE: 1, RBWR: 0, WRTE: 0, FLEX: 1, SFLEX: 0, K: 1, DST: 1 };
/** Slots saved before a slot existed (kickers and defenses came later) get its default. */
export const withDefaults = (s: Partial<Slots> | null | undefined): Slots => ({ ...DEFAULT_SLOTS, ...(s ?? {}) });

const OUT = ["Out", "Doubtful", "IR", "Suspended", "Not playing"];
const SLOT_LABEL: Record<keyof Slots, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", RBWR: "RB/WR", WRTE: "WR/TE", FLEX: "FLEX", SFLEX: "SUPERFLEX", K: "K", DST: "D/ST" };
/** The order slots are shown and edited in, narrowest flex first. */
export const SLOT_ORDER: (keyof Slots)[] = ["QB", "RB", "WR", "TE", "RBWR", "WRTE", "FLEX", "SFLEX", "K", "DST"];
/** Which positions each flex slot takes. Fixed slots take their own. */
const FLEX_TAKES: Partial<Record<keyof Slots, string[]>> = {
  RBWR: ["RB", "WR"], WRTE: ["WR", "TE"], FLEX: ["RB", "WR", "TE"], SFLEX: ["QB", "RB", "WR", "TE"],
};
const FLEX_SLOTS = ["RBWR", "WRTE", "FLEX", "SFLEX"] as const;
const FIXED_SLOTS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

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
  const byId = new Map(rows.map((r) => [r.entry.player_id, r]));
  const { filled } = placeLineup(rows.filter((r) => !r.why).map((r) => r.entry.player_id), saved,
    (id) => byId.get(id)!.entry.position, (id) => byId.get(id)!.proj ?? 0);
  const used = new Set(filled.map((f) => f.id));
  const lineup = filled.map((f) => ({ slot: f.slot, row: f.id ? byId.get(f.id)! : null }));
  const bench = rows.filter((r) => !used.has(r.entry.player_id)).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
  return { lineup, bench };
}
export { SLOT_LABEL };

/** Kicker and defense match only their own slot; no flex takes them. */
export const fitsSlot = (slot: keyof Slots, pos: string) => slot === pos || !!FLEX_TAKES[slot]?.includes(pos);

/** Put a set of players into the slots, as well as the slots allow: as many
 *  of them as fit, and among those ways the highest total. With every
 *  available player that is the best lineup; with a hand-picked set it is
 *  where each of them goes. Anyone who fits nowhere comes back in `extra`
 *  rather than being dropped. */
export function placeLineup(ids: string[], saved: Slots, posOf: (id: string) => string, score: (id: string) => number): { filled: { slot: keyof Slots; id: string | null }[]; extra: string[] } {
  const slots = withDefaults(saved);
  // Placing someone always beats leaving him out, then the projection decides:
  // a starter who cannot play still keeps his slot in a hand-set lineup.
  const w = (id: string) => 1000 + score(id);
  const byPos = new Map<string, string[]>();
  for (const id of ids) { const p = posOf(id); byPos.set(p, [...(byPos.get(p) ?? []), id]); }
  for (const list of byPos.values()) list.sort((a, b) => w(b) - w(a));
  // Fixed slots: the best at each position. Any lineup can be rearranged so
  // they hold them, since every flex that takes a player takes his position.
  const fixed = new Map<keyof Slots, string[]>();
  for (const s of FIXED_SLOTS) { const list = byPos.get(s) ?? []; fixed.set(s, list.slice(0, slots[s])); byPos.set(s, list.slice(slots[s])); }
  const flex = assignFlex(byPos, slots, w);
  const filled: { slot: keyof Slots; id: string | null }[] = [];
  for (const s of SLOT_ORDER) {
    const got = (FLEX_TAKES[s] ? flex.get(s) : fixed.get(s)) ?? [];
    for (let i = 0; i < slots[s]; i++) filled.push({ slot: s, id: got[i] ?? null });
  }
  const used = new Set(filled.map((f) => f.id));
  return { filled, extra: ids.filter((id) => !used.has(id)) };
}

/** The flex slots, exactly. How many of each position to use is searched
 *  (the best k at a position are always the ones to use), each choice kept
 *  only if the slots can hold it: Hall's condition, for every set of
 *  positions, that they are no more than the slots taking any of them. Then
 *  the chosen players are matched to slots. A league has a handful of flex
 *  slots, so the search is a few hundred cases at most. */
function assignFlex(byPos: Map<string, string[]>, slots: Slots, w: (id: string) => number): Map<keyof Slots, string[]> {
  const POS = ["QB", "RB", "WR", "TE"];
  const total = FLEX_SLOTS.reduce((a, s) => a + slots[s], 0);
  const out = new Map<keyof Slots, string[]>(FLEX_SLOTS.map((s) => [s, []]));
  if (!total) return out;
  const avail = POS.map((p) => byPos.get(p) ?? []);
  const cap = (mask: number) => FLEX_SLOTS.reduce((a, s) => a + (POS.some((p, i) => mask & (1 << i) && FLEX_TAKES[s]!.includes(p)) ? slots[s] : 0), 0);
  const caps = Array.from({ length: 16 }, (_, m) => cap(m));
  const prefix = avail.map((list) => { const out = [0]; for (const id of list) out.push(out[out.length - 1] + w(id)); return out; });
  let best = { v: -1, k: [0, 0, 0, 0] };
  const k = [0, 0, 0, 0];
  const go = (i: number, used: number) => {
    if (i === 4) {
      for (let m = 1; m < 16; m++) { let n = 0; for (let j = 0; j < 4; j++) if (m & (1 << j)) n += k[j]; if (n > caps[m]) return; }
      const v = k.reduce((a, kk, j) => a + prefix[j][kk], 0);
      if (v > best.v) best = { v, k: [...k] };
      return;
    }
    for (let n = 0; n <= Math.min(avail[i].length, total - used, caps[1 << i]); n++) { k[i] = n; go(i + 1, used + n); }
    k[i] = 0;
  };
  go(0, 0);
  // Match the chosen players to slot instances (augmenting paths; a perfect
  // matching exists because the counts passed Hall's condition).
  const inst: (keyof Slots)[] = FLEX_SLOTS.flatMap((s) => Array(slots[s]).fill(s));
  const owner: (string | null)[] = inst.map(() => null);
  const posOfId = new Map<string, string>();
  const chosen = POS.flatMap((p, j) => avail[j].slice(0, best.k[j]).map((id) => { posOfId.set(id, p); return id; }));
  const tryPlace = (id: string, seen: Set<number>): boolean => {
    for (let t = 0; t < inst.length; t++) {
      if (seen.has(t) || !FLEX_TAKES[inst[t]]!.includes(posOfId.get(id)!)) continue;
      seen.add(t);
      if (owner[t] === null || tryPlace(owner[t]!, seen)) { owner[t] = id; return true; }
    }
    return false;
  };
  // Best first, so a tie on who sits where favours the projection order.
  for (const id of chosen.sort((a, b) => w(b) - w(a))) tryPlace(id, new Set());
  inst.forEach((s, t) => { if (owner[t]) out.get(s)!.push(owner[t]!); });
  return out;
}

/** The lineup someone set by hand on the Fantasy page (fantasy.lineup), or the
 *  best one when they have not. A starter who cannot play this week stays in
 *  his slot, as he would in a league's app, with `why` saying so. */
export function myLineup(rows: Row[], slots: Slots, chosen: string[] | null): { lineup: LineupSlot[]; bench: Row[]; auto: boolean } {
  if (!chosen) return { ...bestLineup(rows, slots), auto: true };
  const byId = new Map(rows.map((r) => [r.entry.player_id, r]));
  const { filled } = placeLineup(chosen.filter((id) => byId.has(id)), slots, (id) => byId.get(id)!.entry.position,
    (id) => { const r = byId.get(id)!; return r.why ? 0 : r.proj ?? 0; });
  const used = new Set(filled.map((f) => f.id));
  const lineup = filled.map((f) => ({ slot: f.slot, row: f.id ? byId.get(f.id)! : null }));
  const bench = rows.filter((r) => !used.has(r.entry.player_id)).sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
  return { lineup, bench, auto: false };
}

/** What a lineup projects: nothing from anyone who cannot play. */
export const lineupTotal = (lineup: LineupSlot[]) => lineup.reduce((a, l) => a + (l.row && !l.row.why ? l.row.proj ?? 0 : 0), 0);

export function toEntry(p: PlayerLite | FantasyPlayer): RosterEntry {
  return { player_id: p.player_id, name: p.name, position: p.position, team: p.team ?? null };
}
