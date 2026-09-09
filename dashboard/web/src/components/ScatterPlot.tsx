import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { chartTheme } from "../lib/theme";
import type { Quadrant } from "../lib/quadrants";

export interface Dot { id: string; label: string; x: number | null; y: number | null; image?: string | null; sub?: string; highlight?: boolean; muted?: boolean; labelled?: boolean; color?: string | null; extra?: Record<string, string | number | null>; }
interface Props {
  dots: Dot[]; xLabel: string; yLabel: string; xFmt?: (v: number) => string; yFmt?: (v: number) => string;
  height?: number; imageSize?: number; showLabels?: "all" | "some" | "highlight" | "none"; quadrants?: [Quadrant, Quadrant, Quadrant, Quadrant]; // TL, TR, BL, BR
  // The crosshairs are the mean of what is plotted unless the caller knows
  // better. A chart showing a trimmed field has to pass the full population's
  // average, or the line reads as the league when it is only the top of it.
  xAvg?: number | null; yAvg?: number | null;
  // What each end of an axis means, in words, drawn with arrows beside the
  // axis so the reader does not have to work it out from the numbers.
  xEnds?: { low: string; high: string; lowMeans?: string; highMeans?: string }; yEnds?: { low: string; high: string; lowMeans?: string; highMeans?: string };
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
  return (text: string, font: string = FONT): number => {
    if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * 6;
    ctx.font = font;
    return ctx.measureText(text).width;
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

// The chart's margins and the Y axis width, shared with the overlays that
// have to know where the plot area starts and ends.
const M = { top: 30, right: 24, bottom: 24, left: 22 };
const Y_AXIS_W = 56;
const X_TICKS_H = 30;
const CORNER_FONT = "500 10px system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Where a corner tag would sit inside the plot, or null when a dot or a
 *  name is already there: then it goes in the margin instead. */
function cornerInside(i: number, text: string, width: number, height: number, busy: Box[]): Box | null {
  const w = measure(text, CORNER_FONT) + 8, h = 14, pad = 6;
  const x0 = M.left + Y_AXIS_W + pad, x1 = width - M.right - pad - w;
  const y0 = M.top + pad, y1 = height - M.bottom - X_TICKS_H - pad - h;
  const box: Box = i === 0 ? { x: x0, y: y0, w, h } : i === 1 ? { x: x1, y: y0, w, h } : i === 2 ? { x: x0, y: y1, w, h } : { x: x1, y: y1, w, h };
  // A little breathing room: a name brushing the tag reads as a collision.
  const roomy = { x: box.x - 6, y: box.y - 4, w: box.w + 12, h: box.h + 8 };
  return busy.some((b) => overlaps(b, roomy)) ? null : box;
}

/**
 * Greedy placement: each label takes the first side that is still clear, and
 * whatever it takes is off the table for the rest. Highlighted dots go first
 * so the one the reader came for is never the one pushed somewhere odd, and
 * the rest follow the caller's order, which is the order they matter in.
 *
 * A label with no clear side is left off rather than written over another:
 * with twenty-five names in a field whose leaders cluster, the forced ones
 * were an unreadable pile, and every dot still names itself on hover. Only
 * a highlighted dot is always named, above itself if it must be.
 */
function placeLabels(dots: Dot[], pos: Map<string, { cx: number; cy: number; r: number }>, wanted: (d: Dot) => boolean): { sides: Record<string, Side>; boxes: Box[] } {
  const order = dots.filter(wanted).sort((a, b) => Number(!!b.highlight) - Number(!!a.highlight));
  // Other labels are a hard rule: two names never share pixels. Dots are a
  // preference: a side that also clears every marker is taken first, and
  // only if no side does may a name sit over a neighbour's dot. Making dots
  // a hard rule too left a crowded field with one name on it.
  const markers: Box[] = [...pos.values()].map((p) => ({ x: p.cx - p.r, y: p.cy - p.r, w: p.r * 2, h: p.r * 2 }));
  const taken: Box[] = [];
  const out: Record<string, Side> = {};
  for (const d of order) {
    const p = pos.get(d.id);
    if (!p) continue;
    const w = measure(d.label);
    const clear = (side: Side, of: Box[]) => !of.some((t) => overlaps(t, labelAt(side, p.cx, p.cy, p.r, w).box));
    const free = SIDES.find((side) => clear(side, taken) && clear(side, markers)) ?? SIDES.find((side) => clear(side, taken));
    if (!free && !d.highlight) continue;
    out[d.id] = free ?? "top";
    taken.push(labelAt(out[d.id], p.cx, p.cy, p.r, w).box);
  }
  return { sides: out, boxes: [...taken, ...markers] };
}

const sameSides = (a: Record<string, Side>, b: Record<string, Side>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** Teams or players as dots (logos / headshots) on two metrics, with league
 *  averages as crosshairs. Highlighted dots draw larger and labelled. */
export default function ScatterPlot({ dots, xLabel, yLabel, xFmt = (v) => String(v), yFmt = (v) => String(v), height = 380, imageSize = 22, showLabels = "highlight", quadrants, onPick, xAvg, yAvg, xEnds, yEnds }: Props) {
  const T = chartTheme();
  const [hover, setHover] = useState<string | null>(null);
  // Filled while rendering, read after: `shape` below is the only place the
  // pixel position of a dot is known, and it is known one dot at a time.
  const pos = useRef(new Map<string, { cx: number; cy: number; r: number }>());
  const [sides, setSides] = useState<Record<string, Side>>({});
  // Per corner, the box its tag occupies inside the plot, or null for the margin.
  const [inside, setInside] = useState<(Box | null)[]>([null, null, null, null]);
  const wrap = useRef<HTMLDivElement | null>(null);
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
    const { sides: next, boxes } = placeLabels(data, pos.current, persistent);
    setSides((prev) => (sameSides(prev, next) ? prev : next));
    if (quadrants && wrap.current) {
      const { clientWidth: w, clientHeight: h } = wrap.current;
      const nextIn = quadrants.map((q, i) => cornerInside(i, q.head, w, h, boxes));
      setInside((prev) => (prev.every((b, i) => (b === null && nextIn[i] === null) || (b && nextIn[i] && b.x === nextIn[i]!.x && b.y === nextIn[i]!.y && b.w === nextIn[i]!.w)) ? prev : nextIn));
    }
  });

  const shape = (props: any) => {
    const { cx, cy, payload } = props as { cx: number; cy: number; payload: Dot };
    const hl = payload.highlight || hover === payload.id;
    const size = hl ? imageSize * 1.5 : imageSize;
    // The dot's own radius, so a label clears the headshot it belongs to
    // rather than a nominal one. Recorded at its resting size: hover inflates
    // the dot, and a layout that moved with the pointer would be worse than
    // the overlap it fixed.
    // The radius actually drawn: a face at its resting size, a plain marker
    // at its own few pixels, so the reserved circle is the visible one.
    pos.current.set(payload.id, { cx, cy, r: payload.image ? (payload.highlight ? imageSize * 1.5 : imageSize) / 2 : payload.highlight ? 9 : 6 });
    const dim = payload.muted && !hl ? 0.55 : 1;
    // "some" lets the caller name the dots worth naming and leave the rest to
    // hover, which is the only readable option once a crowded field is plotted
    // whole: fifty labels at this size overlap forty of each other.
    // Hover and highlight always name the dot; anything else needs a place
    // from the layout pass, which leaves out what would have overlapped.
    const placed = payload.id in sides;
    const label = hl || (showLabels === "all" && placed) || (showLabels === "some" && !!payload.labelled && placed);
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
          <circle cx={cx} cy={cy} r={hl ? 7 : 5.5} fill={hl ? T.accent : payload.color ?? T.muted} stroke={T.tooltip.background as string} strokeWidth={1.5} />
        )}
        {label && (() => {
          const at = labelAt(sides[payload.id] ?? "top", cx, cy, size / 2, measure(payload.label));
          return <text x={at.x} y={at.y} textAnchor={at.anchor} fontSize={hl ? 11 : 10} fontWeight={hl ? 700 : 500} fill={hl ? T.text : T.muted}>{payload.label}</text>;
        })()}
      </g>
    );
  };
  return (
    <div>
      {/* The plot and everything drawn over it measure against this box
          alone; the title row and the legend below sit outside it. */}
      <div style={{ position: "relative" }} ref={wrap}>
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={M}>
          <CartesianGrid stroke={T.grid} strokeDasharray="2 4" />
          <XAxis type="number" dataKey="x" domain={[x0, x1]} tick={{ fill: T.tick, fontSize: 11 }} tickFormatter={xFmt} tickLine={false} axisLine={{ stroke: T.axis }} />
          <YAxis type="number" dataKey="y" domain={[y0, y1]} tick={{ fill: T.tick, fontSize: 11 }} tickFormatter={yFmt} tickLine={false} axisLine={false} width={Y_AXIS_W} />
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
      {/* The Y axis title, rotated up the left gutter with the two ends of
          the axis either side of it, so the arrows sit against the title
          rather than in the corners. Rotated text reads upward, so the low
          end comes first. */}
      <div className="axis-y" style={{ top: M.top, bottom: M.bottom + X_TICKS_H }}>
        <div className="axis-y-inner">
          {yEnds && <span className="axis-end" title={yEnds.lowMeans}>← {yEnds.low}</span>}
          <b>{yLabel}</b>
          {yEnds && <span className="axis-end" title={yEnds.highMeans}>{yEnds.high} →</span>}
        </div>
      </div>
      {quadrants && (
        // A short tag for each corner: inside the plot when that corner is
        // clear of dots and names, in the margin above or below it otherwise.
        // The reading in full is in the legend below, laid out the same way.
        <>
          {inside[0] ? <div className="quad in" style={{ left: inside[0].x, top: inside[0].y }}>{quadrants[0].head}</div> : <div className="quad" style={{ left: 86, top: 6 }}>↖ {quadrants[0].head}</div>}
          {inside[1] ? <div className="quad in" style={{ left: inside[1].x, top: inside[1].y }}>{quadrants[1].head}</div> : <div className="quad" style={{ right: 24, top: 6, textAlign: "right" }}>{quadrants[1].head} ↗</div>}
          {inside[2] ? <div className="quad in" style={{ left: inside[2].x, top: inside[2].y }}>{quadrants[2].head}</div> : <div className="quad" style={{ left: 86, bottom: 4 }}>↙ {quadrants[2].head}</div>}
          {inside[3] ? <div className="quad in" style={{ left: inside[3].x, top: inside[3].y }}>{quadrants[3].head}</div> : <div className="quad" style={{ right: 24, bottom: 4, textAlign: "right" }}>{quadrants[3].head} ↘</div>}
        </>
      )}
      </div>
      {/* The X axis title under the plot with its two ends either side. */}
      <div className="axis-x">
        {xEnds && <span className="axis-end" title={xEnds.lowMeans}>← {xEnds.low}</span>}
        <b>{xLabel}</b>
        {xEnds && <span className="axis-end" title={xEnds.highMeans}>{xEnds.high} →</span>}
      </div>
      {quadrants && (
        // The four corners as a two-by-two legend in the chart's own layout:
        // what the reader sees top-left on the plot is top-left here.
        <div className="quad-legend">
          {([["↖", quadrants[0]], ["↗", quadrants[1]], ["↙", quadrants[2]], ["↘", quadrants[3]]] as [string, Quadrant][]).map(([arrow, q]) => (
            <div key={arrow} className="quad-card">
              <div className="quad-head"><span className="quad-arrow">{arrow}</span>{q.head}</div>
              {q.body && <div className="quad-body">{q.body}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
