import type { BoardRow, BookLine } from "../api";
import { fmtDelta, fmtLine, fmtOdds, fmtPct } from "../lib/format";

/** All books for one market row, with the outlier highlighting. */
export default function BookLines({ row, selected, onSelect }: { row: BoardRow; selected?: string | null; onSelect?: (b: BookLine) => void }) {
  const yesno = row.kind === "yesno";
  const priced = row.books.some((b) => b.over !== null || b.under !== null);
  return (
    <div className="tbl-wrap">
      <table className="tbl compact">
        <thead>
          <tr>
            <th className="left">Book</th>
            {yesno ? (<><th>Yes</th><th>No</th><th>Implied</th><th>vs cons.</th></>) : (<><th>Line</th>{priced && <><th>Over</th><th>Under</th></>}<th>Open</th><th>Move</th><th>vs cons.</th>{priced && <th>No-vig O</th>}</>)}
          </tr>
        </thead>
        <tbody>
          {row.books.map((b) => (
            <tr key={b.book} className={`${onSelect ? "clickable" : ""} ${selected === b.book ? "hl" : ""}`} onClick={() => onSelect?.(b)} title={b.last_update ? `updated ${b.last_update}` : undefined}>
              <td className="left">{b.title}{b.source === "sample" && <span className="pill warn" style={{ marginLeft: 6 }}>sample</span>}</td>
              {yesno ? (
                <>
                  <td className="num">{fmtOdds(b.yes)}</td>
                  <td className="num">{fmtOdds(b.no)}</td>
                  <td className="num">{fmtPct(b.implied, 1)}</td>
                  <td className={`num ${b.flag ? `cell-${b.flag}` : ""}`}>{b.delta === null ? "" : fmtDelta(b.delta * 100, 1) + " pts"}</td>
                </>
              ) : (
                <>
                  <td className={`num ${b.flag ? `cell-${b.flag}` : ""}`}>{fmtLine(b.line)}</td>
                  {priced && <td className={`num ${row.best_over?.book === b.book ? "cell-best" : ""}`}>{fmtOdds(b.over)}</td>}
                  {priced && <td className={`num ${row.best_under?.book === b.book ? "cell-best" : ""}`}>{fmtOdds(b.under)}</td>}
                  <td className="num muted">{fmtLine(b.open_line)}</td>
                  <td className={`num ${b.moved ? (b.moved > 0 ? "over" : "under") : "muted"}`}>{b.moved ? fmtDelta(b.moved) : "–"}</td>
                  <td className={`num ${b.flag ? `cell-${b.flag}` : ""}`}>{b.delta === null || b.delta === 0 ? <span className="muted">–</span> : fmtDelta(b.delta)}</td>
                  {priced && <td className="num muted">{fmtPct(b.novig_over, 1)}</td>}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!yesno && (
        <div className="hint" style={{ marginTop: 6 }}>
          Consensus = median line across {row.n_books} book{row.n_books === 1 ? "" : "s"}: <b className="num">{row.consensus}</b>.
          Cells are highlighted when a book sits ≥ {row.threshold} from it (green = lower line, red = higher). Boxed prices are the best available over / under.
        </div>
      )}
    </div>
  );
}
