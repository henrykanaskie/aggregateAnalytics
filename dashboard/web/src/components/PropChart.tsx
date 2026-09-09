import { chartTheme } from "../lib/theme";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GameRow, StatDef } from "../api";
import { fmtStat, gameLabel } from "../lib/format";
import { rolling, val } from "../lib/stats";

interface Props { rows: GameRow[]; statKey: string; stat?: StatDef; line: number | null; height?: number; showRolling?: boolean; rollingWindow?: number; showAvg?: boolean; onPick?: (game_id: string) => void; picked?: string | null; compact?: boolean; }

export default function PropChart({ rows, statKey, stat, line, height = 300, showRolling = true, rollingWindow = 5, showAvg = true, onPick, picked, compact = false }: Props) {
  const T = chartTheme();
  const roll = rolling(rows, statKey, rollingWindow);
  const vals = rows.map((r) => val(r, statKey));
  const present = vals.filter((v): v is number => v !== null);
  const avg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
  const data = rows.map((r, i) => ({ label: gameLabel(r), value: vals[i], roll: roll[i], row: r }));
  const color = (v: number | null) => (v === null ? "var(--faint)" : line === null ? "var(--accent)" : v > line ? "var(--over)" : v < line ? "var(--under)" : "var(--push)");
  const fmt = (v: number | null) => fmtStat(v, stat?.fmt);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 12, left: compact ? -14 : -6, bottom: 0 }} barCategoryGap={compact ? "20%" : "28%"}>
        <CartesianGrid stroke={T.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: T.tick, fontSize: compact ? 9 : 10.5 }} interval={compact ? "preserveStartEnd" : 0} angle={compact ? 0 : -35} textAnchor={compact ? "middle" : "end"} height={compact ? 20 : 52} tickLine={false} axisLine={{ stroke: T.axis }} />
        <YAxis tick={{ fill: T.tick, fontSize: 10.5 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(v)} domain={[0, (max: number) => Math.max(max, line ?? 0) * 1.08]} />
        <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const d = payload[0].payload as (typeof data)[number];
          const r = d.row;
          return (
            <div className="tooltip">
              <div className="t">{r.season} {r.season_type === "POST" ? "playoffs" : `week ${r.week}`} · {r.home ? "vs" : "@"} {r.opponent} {r.result ? `(${r.result} ${r.team_score}-${r.opp_score})` : ""}</div>
              <div className="r"><span>{stat?.label ?? statKey}</span><b className="num" style={{ color: color(d.value) }}>{fmt(d.value)}</b></div>
              {line !== null && <div className="r"><span>line</span><span className="num">{line}</span></div>}
              {d.roll !== null && <div className="r"><span>L{rollingWindow} avg</span><span className="num">{fmt(d.roll)}</span></div>}
              {typeof r.snap_offense_pct === "number" && <div className="r"><span>snap %</span><span className="num">{Math.round((r.snap_offense_pct as number) * 100)}%</span></div>}
              {r.team_spread !== null && <div className="r"><span>spread / total</span><span className="num">{r.team_spread! > 0 ? "+" : ""}{r.team_spread} / {r.total_line}</span></div>}
            </div>
          );
        }} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false} onClick={(d: any) => onPick?.(d?.row?.game_id)} cursor={onPick ? "pointer" : undefined}>
          {data.map((d, i) => <Cell key={i} fill={color(d.value)} opacity={picked && picked !== d.row.game_id ? 0.45 : 1} />)}
        </Bar>
        {line !== null && <ReferenceLine y={line} stroke={T.push} strokeDasharray="5 4" strokeWidth={1.5} label={compact ? undefined : { value: `line ${line}`, position: "insideTopRight", fill: T.push, fontSize: 11 }} />}
        {showAvg && avg !== null && <ReferenceLine y={avg} stroke={T.tick} strokeDasharray="2 4" label={compact ? undefined : { value: `avg ${fmt(avg)}`, position: "insideBottomRight", fill: T.tick, fontSize: 11 }} />}
        {showRolling && <Line type="monotone" dataKey="roll" stroke={T.accent} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
