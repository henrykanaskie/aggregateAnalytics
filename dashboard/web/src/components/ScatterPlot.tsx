import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { chartTheme } from "../lib/theme";

export interface Dot { id: string; label: string; x: number | null; y: number | null; image?: string | null; sub?: string; highlight?: boolean; muted?: boolean; labelled?: boolean; extra?: Record<string, string | number | null>; }
interface Props {
  dots: Dot[]; xLabel: string; yLabel: string; xFmt?: (v: number) => string; yFmt?: (v: number) => string;
  height?: number; imageSize?: number; showLabels?: "all" | "some" | "highlight" | "none"; quadrants?: [string, string, string, string]; // TL, TR, BL, BR
  // The crosshairs are the mean of what is plotted unless the caller knows
  // better. A chart showing a trimmed field has to pass the full population's
  // average, or the line reads as the league when it is only the top of it.
  xAvg?: number | null; yAvg?: number | null;
  xGoodHigh?: boolean | null; yGoodHigh?: boolean | null; onPick?: (id: string) => void; title?: string;
}

// --- label placement ---------------------------------------------------------
// Recharts renders each point through `shape` on its own, so nothing in the
// chart knows where the other labels went and every one of them lands above
// its dot. On a crowded field that is names written over names. The fix is a
// layout pass: record where each dot actually landed while rendering, then
// decide the placements and render again with them.

type Side = "top" | "bottom" | "right" | "left";
const SIDES: Side[] = ["top", "bottom", "right", "left"];
const FONT = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
const LINE = 11;   // cap height plus a little, for the box a label occupies

/** Text width in pixels, measured rather than guessed from the character
 *  count: "J. Smith-Njigba" and "C. Lamb" are both labels and are not close
 *  to the same width, and guessing wrong here means placements that still
 *  collide or dodge collisions that were never there. */
const measure = (() => {
  let ctx: CanvasRenderingContext2D | null | undefined;
  return (text: string): number => {
    if (ctx === undefined) {
      ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
      if (ctx) ctx.font = FONT;
    }
    return ctx ? ctx.measureText(text).width : text.length * 6;
  };
})();

interface Box { x: number; y: number; w: number; h: number }

/** Where a label sits for a given side, as both the SVG text anchor and the
 *  box it covers, so placement and rendering can never disagree. */
function labelAt(side: Side, cx: number, cy: number, r: number, w: number): { x: number; y: number; anchor: "middle" | "start" | "end"; box: Box } {
  const gap = 5;
  const at = (x: number, y: number, a: "middle" | "start" | "end"): { x: number; y: number; anchor: "middle" | "start" | "end"; box: Box } => ({
    x, y, anchor: a,
    // The y passed to <text> is the baseline, so the box runs from just above
    // it to just below.
    box: { x: a === "middle" ? x - w / 2 : a === "start" ? x : x - w, y: y - LINE + 2, w, h: LINE },
  });
  switch (side) {
    case "bottom": return at(cx, cy + r + gap + LINE - 2, "middle");
    case "right": return at(cx + r + gap, cy + 4, "start");
    case "left": return at(cx - r - gap, cy + 4, "end");
    default: return at(cx, cy - r - gap, "middle");
  }
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy placement: each label takes the first side that is still clear, and
 * whatever it takes is off the table for the rest. Highlighted dots go first
 * so the one the reader came for is never the one pushed somewhere odd, and
 * the rest follow the caller's order, which is the order they matter in.
 *
 * Four sides is enough for the crowding a scatter actually produces, and when
 * it is not, the label goes above anyway: a name in the wrong place still
 * reads, a missing one is just gone.
 */
function placeLabels(dots: Dot[], pos: Map<string, { cx: number; cy: number; r: number }>, wanted: (d: Dot) => boolean): Record<string, Side> {
  const order = dots.filter(wanted).sort((a, b) => Number(!!b.highlight) - Number(!!a.highlight));
  const taken: Box[] = [];
  const out: Record<string, Side> = {};
  for (const d of order) {
    const p = pos.get(d.id);
    if (!p) continue;
    const w = measure(d.label);
    const free = SIDES.find((side) => !taken.some((t) => overlaps(t, labelAt(side, p.cx, p.cy, p.r, w).box)));
    out[d.id] = free ?? "top";
    taken.push(labelAt(out[d.id], p.cx, p.cy, p.r, w).box);
  }
  return out;
}

const sameSides = (a: Record<string, Side>, b: Record<string, Side>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** Teams or players as dots (logos / headshots) on two metrics, with league
 *  averages as crosshairs. Highlighted dots draw larger and labelled. */
export default function ScatterPlot({ dots, xLabel, yLabel, xFmt = (v) => String(v), yFmt = (v) => String(v), height = 380, imageSize = 22, showLabels = "highlight", quadrants, onPick, xAvg, yAvg }: Props) {
  const T = chartTheme();
  const [hover, setHover] = useState<string | null>(null);
  // Filled while rendering, read after: `shape` below is the only place the
  // pixel position of a dot is known, and it is known one dot at a time.
  const pos = useRef(new Map<string, { cx: number; cy: number; r: number }>());
  const [sides, setSides] = useState<Record<string, Side>>({});
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
  // The labels that are always on the chart. The hover one is deliberately not
  // among them: it comes and goes under the pointer, and re-running the layout
  // for it would shuffle every other name each time the mouse moved.
  const persistent = (d: Dot) => showLabels === "all"
    || (showLabels === "some" && (!!d.labelled || !!d.highlight))
    || (showLabels === "highlight" && !!d.highlight);

  // After every render, because a resize moves every dot and recharts reports
  // that only by calling `shape` again. Bailing out when the placements are
  // unchanged is what stops this looping on its own state update.
  useEffect(() => {
    const next = placeLabels(data, pos.current, persistent);
    setSides((prev) => (sameSides(prev, next) ? prev : next));
  });

  const shape = (props: any) => {
    const { cx, cy, payload } = props as { cx: number; cy: number; payload: Dot };
    const hl = payload.highlight || hover === payload.id;
    const size = hl ? imageSize * 1.5 : imageSize;
    // The dot's own radius, so a label clears the headshot it belongs to
    // rather than a nominal one. Recorded at its resting size: hover inflates
    // the dot, and a layout that moved with the pointer would be worse than
    // the overlap it fixed.
    pos.current.set(payload.id, { cx, cy, r: (payload.highlight ? imageSize * 1.5 : imageSize) / 2 });
    const dim = payload.muted && !hl ? 0.55 : 1;
    // "some" lets the caller name the dots worth naming and leave the rest to
    // hover, which is the only readable option once a crowded field is plotted
    // whole: fifty labels at this size overlap forty of each other.
    const label = showLabels === "all" || (showLabels === "highlight" && hl)
      || (showLabels === "some" && (hl || !!payload.labelled));
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
        {label && (() => {
          const at = labelAt(sides[payload.id] ?? "top", cx, cy, size / 2, measure(payload.label));
          return <text x={at.x} y={at.y} textAnchor={at.anchor} fontSize={11} fontWeight={600} fill={T.text}>{payload.label}</text>;
        })()}
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
        // What each corner means, in words. Faint and behind the pointer so
        // the dots stay the chart; the axis titles still say what is measured.
        <>
          <div className="quad" style={{ left: 70, top: 26 }}>{quadrants[0]}</div>
          <div className="quad" style={{ right: 30, top: 26, textAlign: "right" }}>{quadrants[1]}</div>
          <div className="quad" style={{ left: 70, bottom: 44 }}>{quadrants[2]}</div>
          <div className="quad" style={{ right: 30, bottom: 44, textAlign: "right" }}>{quadrants[3]}</div>
        </>
      )}
    </div>
  );
}
