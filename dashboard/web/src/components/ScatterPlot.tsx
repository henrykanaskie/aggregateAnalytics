import { useMemo, useState } from "react";
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { chartTheme } from "../lib/theme";

export interface Dot { id: string; label: string; x: number | null; y: number | null; image?: string | null; sub?: string; highlight?: boolean; muted?: boolean; extra?: Record<string, string | number | null>; }
interface Props {
  dots: Dot[]; xLabel: string; yLabel: string; xFmt?: (v: number) => string; yFmt?: (v: number) => string;
  height?: number; imageSize?: number; showLabels?: "all" | "highlight" | "none"; quadrants?: [string, string, string, string]; // TL, TR, BL, BR
  // The crosshairs are the mean of what is plotted unless the caller knows
  // better. A chart showing a trimmed field has to pass the full population's
  // average, or the line reads as the league when it is only the top of it.
  xAvg?: number | null; yAvg?: number | null;
  xGoodHigh?: boolean | null; yGoodHigh?: boolean | null; onPick?: (id: string) => void; title?: string;
}

/** Teams or players as dots (logos / headshots) on two metrics, with league
 *  averages as crosshairs. Highlighted dots draw larger and labelled. */
export default function ScatterPlot({ dots, xLabel, yLabel, xFmt = (v) => String(v), yFmt = (v) => String(v), height = 380, imageSize = 22, showLabels = "highlight", quadrants, onPick, xAvg, yAvg }: Props) {
  const T = chartTheme();
  const [hover, setHover] = useState<string | null>(null);
  const data = useMemo(() => dots.filter((d) => d.x !== null && d.y !== null && !Number.isNaN(d.x) && !Number.isNaN(d.y)), [dots]);
  const mean = (pick: (d: Dot) => number) => (data.length ? data.reduce((a, d) => a + pick(d), 0) / data.length : 0);
  const mx = xAvg ?? mean((d) => d.x as number);
  const my = yAvg ?? mean((d) => d.y as number);
  const xs = data.map((d) => d.x as number), ys = data.map((d) => d.y as number);
  // A supplied average belongs inside the domain. When the field is trimmed to
  // its top the average sits below everything plotted, and an axis fitted to
  // the dots alone would put the crosshair off-chart, silently.
  const pad = (arr: number[], keep?: number | null) => {
    const all = keep === null || keep === undefined ? arr : [...arr, keep];
    if (!all.length) return [0, 1];
    const lo = Math.min(...all), hi = Math.max(...all); const p = (hi - lo || 1) * 0.12;
    return [lo - p, hi + p];
  };
  const [x0, x1] = pad(xs, xAvg), [y0, y1] = pad(ys, yAvg);
  const shape = (props: any) => {
    const { cx, cy, payload } = props as { cx: number; cy: number; payload: Dot };
    const hl = payload.highlight || hover === payload.id;
    const size = hl ? imageSize * 1.5 : imageSize;
    const dim = payload.muted && !hl ? 0.55 : 1;
    const label = showLabels === "all" || (showLabels === "highlight" && hl);
    return (
      <g style={{ cursor: onPick ? "pointer" : "default" }} opacity={dim} onClick={() => onPick?.(payload.id)} onMouseEnter={() => setHover(payload.id)} onMouseLeave={() => setHover(null)}>
        {hl && <circle cx={cx} cy={cy} r={size / 2 + 4} fill="none" stroke={T.accent} strokeWidth={2} />}
        {payload.image ? (
          <>
            <clipPath id={`clip-${payload.id}`}><circle cx={cx} cy={cy} r={size / 2} /></clipPath>
            <circle cx={cx} cy={cy} r={size / 2} fill={T.tooltip.background as string} stroke={T.axis} />
            <image href={payload.image} x={cx - size / 2} y={cy - size / 2} width={size} height={size} clipPath={`url(#clip-${payload.id})`} preserveAspectRatio="xMidYMid slice" />
          </>
        ) : (
          <circle cx={cx} cy={cy} r={hl ? 7 : 5} fill={hl ? T.accent : T.muted} stroke={T.tooltip.background as string} strokeWidth={1.5} />
        )}
        {label && <text x={cx} y={cy - size / 2 - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill={T.text}>{payload.label}</text>}
      </g>
    );
  };
  return (
    <div style={{ position: "relative" }}>
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 22, right: 24, bottom: 34, left: 8 }}>
          <CartesianGrid stroke={T.grid} strokeDasharray="2 4" />
          <XAxis type="number" dataKey="x" domain={[x0, x1]} tick={{ fill: T.tick, fontSize: 11 }} tickFormatter={xFmt} tickLine={false} axisLine={{ stroke: T.axis }} label={{ value: xLabel, position: "insideBottom", offset: -18, fill: T.text, fontSize: 12.5, fontWeight: 600 }} />
          <YAxis type="number" dataKey="y" domain={[y0, y1]} tick={{ fill: T.tick, fontSize: 11 }} tickFormatter={yFmt} tickLine={false} axisLine={false} width={56} label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 12, fill: T.text, fontSize: 12.5, fontWeight: 600, style: { textAnchor: "middle" } }} />
          <ZAxis range={[60, 60]} />
          <ReferenceLine x={mx} stroke={T.muted} strokeDasharray="4 4" label={{ value: `avg ${xFmt(mx)}`, position: "top", fill: T.muted, fontSize: 10 }} />
          <ReferenceLine y={my} stroke={T.muted} strokeDasharray="4 4" label={{ value: `avg ${yFmt(my)}`, position: "right", fill: T.muted, fontSize: 10 }} />
          <Tooltip cursor={false} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as Dot;
            return (
              <div className="tooltip"><div className="t">{d.label}{d.sub ? <span className="muted"> · {d.sub}</span> : null}</div>
                <div className="r"><span>{xLabel}</span><b className="num">{xFmt(d.x as number)}</b></div>
                <div className="r"><span>{yLabel}</span><b className="num">{yFmt(d.y as number)}</b></div>
                {d.extra && Object.entries(d.extra).map(([k, v]) => <div className="r" key={k}><span>{k}</span><span className="num">{v ?? "–"}</span></div>)}
              </div>
            );
          }} />
          <Scatter data={data} shape={shape} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
      {quadrants && (
        <>
          <div className="faint tiny" style={{ position: "absolute", left: 70, top: 26 }}>{quadrants[0]}</div>
          <div className="faint tiny" style={{ position: "absolute", right: 30, top: 26 }}>{quadrants[1]}</div>
          <div className="faint tiny" style={{ position: "absolute", left: 70, bottom: 44 }}>{quadrants[2]}</div>
          <div className="faint tiny" style={{ position: "absolute", right: 30, bottom: 44 }}>{quadrants[3]}</div>
        </>
      )}
    </div>
  );
}
