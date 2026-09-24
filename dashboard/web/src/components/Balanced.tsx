import { ReactNode, useLayoutEffect, useRef, useState } from "react";

// Two columns side by side that leave no hole under the shorter one.
//
// Panel heights are not known until they render (and many grow when their
// data lands), so no fixed split keeps two columns even. So every panel of
// both columns is a child of one grid with 1px rows, and each is placed at
// the row its measured height puts it: the left column's panels stack in
// the left track, the right's in the right. Once a panel of the longer
// column would start below where the other column ends, it and the rest of
// that column span the full width underneath instead. Only grid positions
// change, never the tree, so nothing inside a panel resets when it moves.
// Re-measured whenever a panel resizes. On a narrow screen the grid is one
// column in plain order (left, then right) and nothing is placed by hand.

export interface Item { id: string; node: ReactNode }
const GAP = 14;
const NARROW = "(max-width: 1100px)";
type Place = { gridColumn: string; gridRow: string };

export default function Balanced({ left, right, free = [], leftWidth, rightWidth }: {
  left: Item[]; right: Item[];
  /** Panels with no side of their own: each goes under whichever column is
   *  shorter at that point. */
  free?: Item[];
  /** Track sizes, e.g. "minmax(0, 1fr)" and "390px". */
  leftWidth: string; rightWidth: string;
}) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  // Each panel's height the last time it sat in its column. A panel moved
  // full width is usually shorter there; judging which column is longer by
  // that height could move it back, and back again.
  const inColumn = useRef(new Map<string, number>());
  const [places, setPlaces] = useState<Record<string, Place> | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW).matches);

  useLayoutEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const key = [...left, "|", ...right, "|", ...free].map((x) => (typeof x === "string" ? x : x.id)).join("|");
  useLayoutEffect(() => {
    if (narrow) { setPlaces(null); return; }
    const measure = () => {
      const h = (id: string) => refs.current.get(id)?.offsetHeight ?? 0;
      const wide = (id: string) => refs.current.get(id)?.style.gridColumn === "1 / -1";
      for (const [id, el] of refs.current) if (!wide(id)) inColumn.current.set(id, el.offsetHeight);
      const colH = (id: string) => (wide(id) ? inColumn.current.get(id) ?? h(id) : h(id));
      const total = (list: Item[]) => list.reduce((a, x) => a + colH(x.id) + GAP, 0);
      const out: Record<string, Place> = {};
      const sides = [[...left], [...right]];
      const totals = sides.map(total);
      for (const x of free) {
        const side = totals[0] <= totals[1] ? 0 : 1;
        sides[side].push(x);
        totals[side] += colH(x.id) + GAP;
      }
      const longer = totals[0] >= totals[1] ? 0 : 1, other = totals[1 - longer];
      const ends = [0, 0];
      const spill: Item[] = [];
      sides.forEach((list, side) => {
        let y = 0;
        list.forEach((x, i) => {
          // A panel of the longer column that would start where the other
          // column has already ended goes full width, with the rest after it.
          if (side === longer && (spill.length || (i > 0 && y >= other - 1))) { spill.push(x); return; }
          out[x.id] = { gridColumn: String(side + 1), gridRow: `${y + 1} / span ${Math.max(1, h(x.id))}` };
          y += h(x.id) + GAP;
        });
        ends[side] = y;
      });
      let y = Math.max(ends[0], ends[1]);
      for (const x of spill) {
        out[x.id] = { gridColumn: "1 / -1", gridRow: `${y + 1} / span ${Math.max(1, h(x.id))}` };
        y += h(x.id) + GAP;
      }
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
      {[...left.map((x) => [x, 1] as const), ...right.map((x) => [x, 2] as const), ...free.map((x) => [x, 1] as const)].map(([x, col]) => (
        <div key={x.id} className="balanced-item" ref={(el) => { if (el) refs.current.set(x.id, el); else refs.current.delete(x.id); }}
          style={placed ? (places?.[x.id] ?? { gridColumn: String(col) }) : undefined}>
          {x.node}
        </div>
      ))}
    </div>
  );
}
