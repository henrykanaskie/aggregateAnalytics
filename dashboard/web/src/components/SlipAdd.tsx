import type { BoardRow } from "../api";
import { legFromRow, legKey, useSlip } from "../lib/slip";
import type { Side } from "../lib/slipStore";

/** The two buttons on a Board row that put a side of it on the slip, lit
 *  when that side is already there. A click here never opens the row. */
export default function SlipAdd({ row, season, week, book }: { row: BoardRow; season: number; week: number; book: string | null }) {
  const slip = useSlip();
  if (!row.game_id || !row.player_id) return null;
  const sides: [Side, string][] = row.kind === "yesno" ? [["yes", "Yes"]] : [["over", "O"], ["under", "U"]];
  return (
    <span className="slip-add" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {sides.map(([side, label]) => {
        const on = slip.has(legKey({ game_id: row.game_id, player_id: row.player_id, market: row.market, side }));
        return (
          <button key={side} className={`slip-add-btn ${side} ${on ? "on" : ""}`} aria-pressed={on}
            title={on ? "On your slip. Click to take it off" : `Add ${side} to your slip`}
            onClick={() => { const leg = legFromRow(row, side, season, week, book); if (leg) slip.toggle(leg); }}>
            {on ? "✓" : "+"}{label}
          </button>
        );
      })}
    </span>
  );
}
