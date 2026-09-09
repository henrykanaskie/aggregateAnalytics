import { chartTheme } from "../lib/theme";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api2, SplitGames, Splits as SplitsT } from "../api";
import { fmtStat } from "../lib/format";
import { useMeta } from "../state";
import { Field, Seg, Spinner } from "./common";

const PRIMARY: Record<string, string> = { rush: "ypc", rec: "ypt", pass: "ypa" };
const EXTRA = ["#ef5f5f", "#b28dff", "#4dd0e1", "#ff9f6e", "#c6d36f", "#9a9a9a"];
const ROLE_LABEL: Record<string, string> = { rush: "Rushing", rec: "Receiving", pass: "Passing" };

/** Play-level splits: shotgun vs under center, red zone, play action, coverage... */
export default function Splits({ playerId, statKey, position, since }: { playerId: string; statKey: string; position: string | null; since: number }) {
  const { meta } = useMeta();
  const T = chartTheme();
  const COLORS = [T.accent, T.over, T.push, ...EXTRA];
  // The role a reader has picked by hand, or null to follow the charted stat:
  // a receiving-yards prop wants receiving splits, a rushing one rushing. It
  // used to be pinned by the first response, so a page opened on rushing
  // yards kept showing rushing splits after the reader moved to passing
  // yards, and that same write-back fired a second identical fetch on load.
  const [want, setWant] = useState<string | null>(null);
  const [data, setData] = useState<SplitsT | null>(null);
  const [dim, setDim] = useState("formation");
  const [metric, setMetric] = useState<string | null>(null);
  const [games, setGames] = useState<SplitGames | null>(null);
  const [from, setFrom] = useState(Math.max(since, 2016));
  const [loading, setLoading] = useState(false);
  const [seasonType, setSeasonType] = useState<"ALL" | "REG" | "POST">("ALL");

  useEffect(() => { setWant(null); }, [playerId, statKey]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api2.splits(playerId, { role: want ?? undefined, since: from, stat: want ? undefined : statKey, season_type: seasonType === "ALL" ? undefined : seasonType })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [playerId, want, from, seasonType, statKey]);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    const key = data.dims.find((d) => d.key === dim)?.key ?? data.dims[0]?.key;
    if (!key) { setGames(null); return; }
    api2.splitGames(playerId, data.role, key, from).then((g) => alive && setGames(g)).catch(() => alive && setGames(null));
    return () => { alive = false; };
  }, [playerId, data, dim, from]);

  const dims = useMemo(() => (meta?.split_dims ?? []).filter((d) => data && d.roles.includes(data.role)), [meta, data]);
  // A split picked for one role can be meaningless for the next (run gap has
  // no passing version), and a metric column likewise. Fall back to the first
  // split the role does have, and to the role's headline metric.
  const chosen = data?.dims.find((d) => d.key === dim) ?? data?.dims[0] ?? null;
  const dimKey = chosen?.key ?? dim;
  useEffect(() => { setMetric(null); }, [data?.role]);
  const mkey = (metric && data?.metrics.some((m) => m[0] === metric) ? metric : null) ?? (data ? PRIMARY[data.role] : "ypc");
  const metricDef = data?.metrics.find((m) => m[0] === mkey);
  const chartData = useMemo(() => (games?.games ?? []).slice(-20).map((g) => ({ label: `${g.season_type === "POST" ? "P" : "W"}${g.week} ${g.opponent}`, ...Object.fromEntries(Object.entries(g.levels).map(([lvl, v]) => [lvl, v[mkey]])) })), [games, mkey]);
  const levels = chosen?.levels.map((l) => l.level) ?? [];

  return (
    <div>
      <div className="panel-head">
        <div><h3>Situational splits · play by play</h3><div className="hint">Every play the player touched, grouped by situation. Charting-based splits are limited to the seasons the data covers.</div></div>
        <div className="actions">
          <Field label="Role"><Seg value={data?.role ?? "rush"} options={Object.entries(data?.roles ?? {}).filter(([, n]) => n > 0).map(([r, n]) => ({ v: r, l: `${ROLE_LABEL[r]} (${n})` }))} onChange={(v) => setWant(v)} /></Field>
          <Field label="Games"><Seg value={seasonType} options={[{ v: "ALL", l: "All" }, { v: "REG", l: "Reg" }, { v: "POST", l: "Post" }]} onChange={setSeasonType} /></Field>
          <Field label="Since"><input className="input num" type="number" min={1999} max={2026} value={from} onChange={(e) => setFrom(Number(e.target.value))} /></Field>
          {loading && <Spinner />}
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 10 }}>
        {dims.map((d) => { const has = data?.dims.some((x) => x.key === d.key); return <button key={d.key} className={`chip ${dimKey === d.key ? "on" : ""}`} disabled={!has} style={{ opacity: has ? 1 : 0.4 }} title={d.note || undefined} onClick={() => setDim(d.key)}>{d.label}{d.since > 1999 ? <span className="faint tiny"> {d.since}+</span> : null}</button>; })}
      </div>
      {chosen && data && (
        <div className="grid grid-2">
          <div className="tbl-wrap">
            <table className="tbl compact">
              <thead><tr><th className="left">{chosen.label}</th>{data.metrics.map(([k, l]) => <th key={k} className={k === mkey ? "over" : ""} onClick={() => setMetric(k)} style={{ cursor: "pointer" }}>{l}</th>)}</tr></thead>
              <tbody>
                {chosen.levels.map((l) => (
                  <tr key={l.level}><td className="left">{l.level}</td>{data.metrics.map(([k, , f]) => <td key={k} className={`num ${k === mkey ? "over" : ""}`}>{fmtStat(l[k] as number | null, f as any)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 6 }}>{chosen.n} plays{chosen.note ? ` · ${chosen.note}` : ""}. Click a column to chart it.</div>
          </div>
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}><b>{metricDef?.[1] ?? mkey}</b> by {chosen.label.toLowerCase()}, last {Math.min(20, chartData.length)} games</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={T.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: T.tick, fontSize: 9 }} tickLine={false} axisLine={{ stroke: T.axis }} interval="preserveStartEnd" />
                <YAxis tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtStat(v, metricDef?.[2] as any)} />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={T.tooltip} formatter={(v: any) => fmtStat(v, metricDef?.[2] as any)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {levels.slice(0, 9).map((l, i) => <Bar key={l} dataKey={l} fill={COLORS[i]} isAnimationActive={false} radius={[2, 2, 0, 0]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {data && data.n_plays === 0 && <div className="empty">No plays in this window.</div>}
    </div>
  );
}
