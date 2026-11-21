import React, { createContext, useContext, useMemo, useState } from "react";
import type { BoardRow } from "../api";
import { EMPTY, Leg, loadSlip, Parlay, saveSlip, Side, SlipState } from "./slipStore";

// The slip as app state: the draft being built on the Board and the parlays
// already saved. Persistence is lib/slipStore.ts; this only holds the state
// for the open tab and hands every change to saveSlip.

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Same player, market and side in the same game is the same pick, whatever line. */
export const legKey = (l: { game_id: string | null; player_id: string | null; market: string; side: Side }) => `${l.game_id}|${l.player_id}|${l.market}|${l.side}`;

/** A Board row turned into a leg at the line shown: the chosen book's, else the consensus. */
export function legFromRow(r: BoardRow, side: Side, season: number, week: number, book: string | null): Leg | null {
  if (!r.game_id || !r.player_id) return null;
  const b = book ? r.books.find((x) => x.book === book) : undefined;
  const line = r.kind === "yesno" ? null : (b?.line ?? r.consensus);
  return {
    id: newId(), season, week, game_id: r.game_id, player_id: r.player_id, player_name: r.player_name, team: r.team, position: r.position,
    matchup: `${r.away_team}@${r.home_team}`, market: r.market, market_label: r.market_label, stat: r.stat, kind: r.kind, side, line,
    book: b ? b.book : null, added_at: new Date().toISOString(),
  };
}

interface Ctx extends SlipState {
  has: (key: string) => boolean;
  /** Adds the leg, or removes it when the same pick is already in the draft. */
  toggle: (leg: Leg) => void;
  remove: (id: string) => void;
  clearDraft: () => void;
  /** Saves the draft as one parlay and empties it. */
  saveDraft: (name: string) => void;
  importParlay: (p: Parlay) => void;
  deleteParlay: (id: string) => void;
}
const C = createContext<Ctx>(null as any);

export function SlipProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<SlipState>(() => { try { return loadSlip(); } catch { return EMPTY; } });
  const update = (fn: (s: SlipState) => SlipState) => setS((prev) => { const n = fn(prev); try { saveSlip(n); } catch {} return n; });
  const keys = useMemo(() => new Set(s.draft.map(legKey)), [s.draft]);
  const ctx: Ctx = {
    ...s,
    has: (k) => keys.has(k),
    toggle: (leg) => update((p) => {
      const k = legKey(leg);
      // The other side of the same prop replaces it: over and under together is not a pick.
      const opposite = (l: Leg) => l.game_id === leg.game_id && l.player_id === leg.player_id && l.market === leg.market;
      return p.draft.some((l) => legKey(l) === k) ? { ...p, draft: p.draft.filter((l) => legKey(l) !== k) } : { ...p, draft: [...p.draft.filter((l) => !opposite(l)), leg] };
    }),
    remove: (id) => update((p) => ({ ...p, draft: p.draft.filter((l) => l.id !== id) })),
    clearDraft: () => update((p) => ({ ...p, draft: [] })),
    saveDraft: (name) => update((p) => p.draft.length ? { draft: [], parlays: [{ id: newId(), name: name.trim() || defaultName(p.draft), legs: p.draft, created_at: new Date().toISOString() }, ...p.parlays] } : p),
    importParlay: (parlay) => update((p) => p.parlays.some((x) => x.id === parlay.id) ? p : { ...p, parlays: [parlay, ...p.parlays] }),
    deleteParlay: (id) => update((p) => ({ ...p, parlays: p.parlays.filter((x) => x.id !== id) })),
  };
  return <C.Provider value={ctx}>{children}</C.Provider>;
}
export const useSlip = () => useContext(C);

function defaultName(legs: Leg[]): string {
  if (legs.length === 1) return `${legs[0].player_name} ${legs[0].market_label}`;
  const weeks = [...new Set(legs.map((l) => l.week))];
  return `${legs.length}-leg parlay · wk ${weeks.join("/")}`;
}

export const sideLabel = (l: Pick<Leg, "side" | "line" | "kind">) =>
  l.kind === "yesno" ? (l.side === "yes" ? "Yes" : "No") : `${l.side === "over" ? "Over" : "Under"} ${l.line}`;
