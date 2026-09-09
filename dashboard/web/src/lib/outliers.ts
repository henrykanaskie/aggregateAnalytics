import { Alert, Board, BookLine, BoardRow } from "../api";

// Outlier sensitivity is a display choice, not a different question to ask the
// server. The board already carries every book's distance from consensus and
// the market's base threshold, so re-flagging at another sensitivity is
// arithmetic on rows the browser is holding. It used to be a query parameter,
// which meant refetching a megabyte of board, rebuilding every projection on
// the host and waiting on a spinner to paint the same numbers in a different
// colour.
//
// This assumes the board was fetched at the default scale, so `threshold` on a
// row is the market's base gap. Board.tsx no longer sends one.

const PROB_THRESHOLD = 0.04;   // mirrors PROB_THRESHOLD in dashboard/odds/analysis.py

export interface Scaled { rows: BoardRow[]; alerts: Alert[]; }

/** Board rows re-flagged at `scale`, with the alerts that depend on it rebuilt.
 *  Injuries are nothing to do with the threshold, so those are kept as sent. */
export function applyScale(board: Board | null, scale: number): Scaled {
  if (!board) return { rows: [], alerts: [] };
  const rows: BoardRow[] = [];
  const alerts: Alert[] = (board.alerts ?? []).filter((a) => a.kind === "injury");
  for (const r of board.rows) {
    // A yes/no market is priced, not lined: its books are compared on implied
    // probability against one league-wide gap, the way the server does it.
    const move = r.threshold * scale;
    const thr = (r.kind === "ou" ? r.threshold : PROB_THRESHOLD) * scale;
    const books = r.books.map((b) => {
      const d = b.delta;
      const flag: BookLine["flag"] = d !== null && d !== undefined && thr > 0 && Math.abs(d) >= thr ? (d < 0 ? "low" : "high") : null;
      return b.flag === flag ? b : { ...b, flag };
    });
    rows.push({ ...r, books, threshold: move, outliers: books.filter((b) => b.flag).map((b) => b.book) });

    const of = { player_id: r.player_id, player: r.player_name, team: r.team, market: r.market, market_label: r.market_label, game_id: r.game_id };
    for (const b of books) {
      const mv = b.moved;
      if (mv === null || mv === undefined || move <= 0 || Math.abs(mv) < move) continue;
      alerts.push({ ...of, kind: "move", severity: Math.abs(mv) >= 2 * move ? 2 : 1,
        title: `${r.player_name} ${r.market_label} moved ${mv > 0 ? "+" : ""}${mv} at ${b.title}`,
        detail: `opened ${b.open_line}, now ${b.line}` });
    }
    for (const b of books) {
      if (!b.flag) continue;
      alerts.push({ ...of, kind: "outlier", severity: 1,
        title: `${b.title} is ${(b.delta ?? 0) > 0 ? "+" : ""}${b.delta} off consensus on ${r.player_name} ${r.market_label}`,
        detail: `${b.line} vs consensus ${r.consensus} across ${r.n_books} books` });
    }
  }
  // Same order the API sends: loudest first, then by kind, then by player.
  alerts.sort((a, b) => b.severity - a.severity || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.player.localeCompare(b.player));
  return { rows, alerts };
}
