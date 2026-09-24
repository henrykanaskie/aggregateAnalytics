import { ReactNode, useLayoutEffect, useRef, useState } from "react";

// Two columns side by side that leave no hole under the shorter one.
//
// Panel heights are not known until they render (and many grow when their
// data lands), so no fixed split keeps two columns even. So every panel is a
// child of one grid with 1px rows, and each is placed at the rows its
// measured height covers. The panels come in page order, each with a side:
// "left" and "right" panels stack in their own column; an "either" panel
// (one a layout gave the full width, or none at all) goes under whichever
// column is shorter at that point, so it fills a hole rather than waiting
// below it. Once a panel of the longer column would start below where the
// other column ends, it and the rest of that column span the full width
// underneath. Only grid positions change, never the tree, so nothing inside
// a panel resets when it moves. Re-measured whenever a panel resizes. On a
// narrow screen the grid is one column in page order and nothing is placed
// by hand.

export type Side = "left" | "right" | "either";
export interface Item { id: string; node: ReactNode }
export interface SidedItem extends Item { side: Side }
const GAP = 14;
const NARROW = "(max-width: 1100px)";
/** An "either" panel keeps its column until the other is shorter by more
 *  than this, so heights settling by a few pixels do not move it back and forth. */
const STICKY = 60;
/** Columns within this of each other count as level: an "either" panel
 *  arriving then keeps its full width. */
const LEVEL = 40;
type Place = { gridColumn: string; gridRow: string };

export default function Balanced({ items: given, left = [], right = [], free = [], leftWidth, rightWidth }: {
  /** Panels in page order, each with its side. Or left / right / free lists. */
  items?: SidedItem[];
  left?: Item[]; right?: Item[];
  /** Panels with no side of their own, after the others. */
  free?: Item[];
  /** Track sizes, e.g. "minmax(0, 1fr)" and "390px". */
  leftWidth: string; rightWidth: string;
}) {
  const items: SidedItem[] = given ?? [
    ...left.map((x) => ({ ...x, side: "left" as const })), ...right.map((x) => ({ ...x, side: "right" as const })),
    ...free.map((x) => ({ ...x, side: "either" as const })),
  ];
  const refs = useRef(new Map<string, HTMLDivElement>());
  // Each panel's height the last time it sat in a column. A panel moved full
  // width is usually shorter there; judging which column is longer by that
  // height could move it back, and back again.
  const inColumn = useRef(new Map<string, number>());
  // Where each "either" panel went last time (0 left, 1 right).
  const chosen = useRef(new Map<string, number>());
  const [places, setPlaces] = useState<Record<string, Place> | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);

  useLayoutEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const key = items.map((x) => `${x.id}:${x.side}`).join("|");
  useLayoutEffect(() => {
    chosen.current.clear();
  }, [key]);
  useLayoutEffect(() => {
    if (narrow) { setPlaces(null); return; }
    const measure = () => {
      const h = (id: string) => refs.current.get(id)?.offsetHeight ?? 0;
      const wide = (id: string) => refs.current.get(id)?.style.gridColumn === "1 / -1";
      for (const [id, el] of refs.current) if (!wide(id)) inColumn.current.set(id, el.offsetHeight);
      const colH = (id: string) => (wide(id) ? inColumn.current.get(id) ?? h(id) : h(id));
      // Walk the page in order. Panels stack in bands of two columns; an
      // "either" panel that arrives while the columns are about level keeps
      // the full width its layout gave it and starts a new band, and one that
      // arrives beside a hole goes into the shorter column to fill it.
      const out: Record<string, Place> = {};
      let base = 0;
      let cols: SidedItem[][] = [[], []];
      let totals = [0, 0];
      const flush = (last: boolean) => {
        // Place the band: each column from `base`; on the last band, the
        // longer column's panels past the other's end go full width.
        const longer = totals[0] >= totals[1] ? 0 : 1, other = totals[1 - longer];
        const ends = [base, base];
        const spill: SidedItem[] = [];
        cols.forEach((list, side) => {
          let y = base;
          list.forEach((x, i) => {
            if (last && side === longer && (spill.length || (i > 0 && y - base >= other - 1))) { spill.push(x); return; }
            out[x.id] = { gridColumn: String(side + 1), gridRow: `${y + 1} / span ${Math.max(1, h(x.id))}` };
            y += h(x.id) + GAP;
          });
          ends[side] = y;
        });
        base = Math.max(ends[0], ends[1]);
        for (const x of spill) {
          out[x.id] = { gridColumn: "1 / -1", gridRow: `${base + 1} / span ${Math.max(1, h(x.id))}` };
          base += h(x.id) + GAP;
        }
        cols = [[], []];
        totals = [0, 0];
      };
      for (const x of items) {
        let s: number;
        if (x.side === "left") s = 0;
        else if (x.side === "right") s = 1;
        else {
          const prev = chosen.current.get(x.id);
          const diff = Math.abs(totals[0] - totals[1]);
          const level = prev === -1 ? diff <= LEVEL + STICKY : diff <= LEVEL;
          if (level) {
            chosen.current.set(x.id, -1);
            flush(false);
            out[x.id] = { gridColumn: "1 / -1", gridRow: `${base + 1} / span ${Math.max(1, h(x.id))}` };
            base += h(x.id) + GAP;
            continue;
          }
          const shorter = totals[0] <= totals[1] ? 0 : 1;
          s = prev !== undefined && prev >= 0 && totals[prev] - totals[1 - prev] <= STICKY ? prev : shorter;
          chosen.current.set(x.id, s);
        }
        cols[s].push(x);
        totals[s] += colH(x.id) + GAP;
      }
      flush(true);
      setPlaces((prev) => (prev && JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    };
    measure();
    const ro = new ResizeObserver(measure);
    refs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, narrow]);

  const placed = !narrow;
  return (
    <div className={`balanced ${placed ? "placed" : ""}`} style={placed ? { gridTemplateColumns: `${leftWidth} ${rightWidth}` } : undefined}>
      {items.map((x) => (
        <div key={x.id} className="balanced-item" ref={(el) => { if (el) refs.current.set(x.id, el); else refs.current.delete(x.id); }}
          style={placed ? (places?.[x.id] ?? { gridColumn: x.side === "right" ? "2" : "1" }) : undefined}>
          {x.node}
        </div>
      ))}
    </div>
  );
}
