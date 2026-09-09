import { chartTheme } from "../lib/theme";
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GameRow, StatDef } from "../api";
import { val } from "../lib/stats";

export default function Histogram({ rows, statKey, stat, line, height = 160 }: { rows: GameRow[]; statKey: string; stat?: StatDef; line: number | null; height?: number }) {
  const T = chartTheme();
  const vals = rows.map((r) => val(r, statKey)).filter((v): v is number => v !== null);
  if (vals.length < 3) return <div className="empty">Not enough games.</div>;
  const min = Math.min(...vals), max = Math.max(...vals);
  const isInt = stat?.fmt === "int" || stat === undefined;
  const nb = Math.min(14, Math.max(5, Math.round(Math.sqrt(vals.length) * 1.5)));
  let width = (max - min) / nb || 1;
  if (isInt && max - min <= nb) width = 1;
  const bins: { x0: number; x1: number; n: number; label: string }[] = [];
  for (let i = 0; i < nb; i++) {
    const x0 = min + i * width, x1 = x0 + width;
    if (x0 > max) break;
    bins.push({ x0, x1, n: 0, label: isInt && width === 1 ? String(Math.round(x0)) : `${fmt(x0)}–${fmt(x1)}` });
  }
  for (const v of vals) { let i = Math.min(bins.length - 1, Math.floor((v - min) / width)); bins[i].n++; }
  const lineBin = line === null ? -1 : bins.findIndex((b) => line >= b.x0 && line < b.x1);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={bins} margin={{ top: 6, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey="label" tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={{ stroke: T.axis }} interval={0} />
        <YAxis tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={({ active, payload }) => active && payload?.length ? <div className="tooltip"><div className="t">{(payload[0].payload as any).label}</div><div>{payload[0].value} games</div></div> : null} />
        <Bar dataKey="n" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {bins.map((b, i) => <Cell key={i} fill={line === null ? "var(--accent)" : b.x0 + width / 2 > line ? "var(--over)" : "var(--under)"} opacity={i === lineBin ? 1 : 0.8} />)}
        </Bar>
        {lineBin >= 0 && <ReferenceLine x={bins[lineBin].label} stroke={T.push} strokeDasharray="4 3" />}
      </BarChart>
    </ResponsiveContainer>
  );
}
const fmt = (v: number) => String(Math.round(v));
