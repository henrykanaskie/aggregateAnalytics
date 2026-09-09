import { chartTheme } from "../lib/theme";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryRow } from "../api";
import { useMeta } from "../state";

const EXTRA = ["#ef5f5f", "#b28dff", "#4dd0e1", "#ff9f6e", "#c6d36f"];

/** Line movement per book across snapshots for one market. */
export default function LineHistory({ history, market }: { history: HistoryRow[]; market: string }) {
  const { meta } = useMeta();
  const T = chartTheme();
  const COLORS = [T.accent, T.over, T.push, ...EXTRA];
  const rows = history.filter((h) => h.market === market && h.side === "Over" && h.line !== null);
  if (rows.length < 2) return <div className="hint">Line history appears once there are two or more snapshots. Every pull adds one.</div>;
  const times = [...new Set(rows.map((r) => r.pulled_at))].sort();
  const books = [...new Set(rows.map((r) => r.book))];
  const data = times.map((t) => {
    const d: Record<string, any> = { t, label: new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }) };
    for (const b of books) { const r = rows.find((x) => x.pulled_at === t && x.book === b); if (r) d[b] = r.line; }
    return d;
  });
  // Also show the opening line as the first point when only one snapshot per book exists.
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 10, left: -14, bottom: 0 }}>
        <CartesianGrid stroke={T.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={{ stroke: T.axis }} />
        <YAxis tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
        <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
          <div className="tooltip"><div className="t">{label}</div>{payload.map((p) => <div className="r" key={String(p.dataKey)}><span>{meta?.books[String(p.dataKey)] ?? p.dataKey}</span><b className="num">{p.value as any}</b></div>)}</div>
        ) : null} />
        {books.map((b, i) => <Line key={b} type="stepAfter" dataKey={b} stroke={COLORS[i % COLORS.length]} strokeWidth={1.8} dot={{ r: 2.5 }} isAnimationActive={false} connectNulls />)}
      </LineChart>
    </ResponsiveContainer>
  );
}
