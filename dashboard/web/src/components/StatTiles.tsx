import type { GameRow, StatDef } from "../api";
import { fmtPct, fmtStat } from "../lib/format";
import { summarize } from "../lib/stats";

export default function StatTiles({ rows, allRows, statKey, stat, line }: { rows: GameRow[]; allRows: GameRow[]; statKey: string; stat?: StatDef; line: number | null }) {
  const s = summarize(rows, statKey, line);
  const l5 = summarize(allRows.slice(-5), statKey, line);
  const l10 = summarize(allRows.slice(-10), statKey, line);
  const lastSeason = allRows.length ? allRows[allRows.length - 1].season : null;
  const season = summarize(allRows.filter((r) => r.season === lastSeason), statKey, line);
  const f = (v: number | null) => fmtStat(v, stat?.fmt);
  const Rate = ({ k, x, sub }: { k: string; x: typeof s; sub?: string }) => (
    <div className="tile">
      <div className="k">{k}</div>
      <div className="v" style={{ color: x.rate === null ? undefined : x.rate >= 0.6 ? "var(--over)" : x.rate <= 0.4 ? "var(--under)" : undefined }}>{fmtPct(x.rate)}</div>
      <div className="s">{line === null ? "set a line" : `${x.over}-${x.under}${x.push ? `-${x.push}` : ""} over · avg ${f(x.avg)}`}{sub ? ` · ${sub}` : ""}</div>
      <div className="bar"><div style={{ width: `${(x.rate ?? 0) * 100}%` }} /></div>
    </div>
  );
  return (
    <div className="tiles">
      <Rate k={`Filtered (${s.n})`} x={s} />
      <Rate k="Last 5" x={l5} />
      <Rate k="Last 10" x={l10} />
      <Rate k={`${lastSeason ?? "Season"}`} x={season} />
      <div className="tile"><div className="k">Average</div><div className="v">{f(s.avg)}</div><div className="s">median {f(s.median)}</div></div>
      <div className="tile"><div className="k">Range</div><div className="v">{f(s.min)}–{f(s.max)}</div><div className="s">sd {f(s.std)}</div></div>
      <div className="tile"><div className="k">Streak</div><div className="v" style={{ color: s.streak ? (s.streak.side === "over" ? "var(--over)" : "var(--under)") : undefined }}>{s.streak ? `${s.streak.n} ${s.streak.side}` : "–"}</div><div className="s">consecutive vs line</div></div>
      <div className="tile"><div className="k">Line vs avg</div><div className="v">{line !== null && s.avg !== null ? (s.avg - line > 0 ? "+" : "") + (s.avg - line).toFixed(1) : "–"}</div><div className="s">avg minus line</div></div>
    </div>
  );
}
