import { Fragment } from "react";
import Balanced from "./Balanced";
import type { Row } from "../lib/layouts";

/** Renders a layout (lib/layouts.ts) over a page's panels. A cell whose panels
 *  are all absent is dropped and its width given to the rest of the row; a
 *  panel no row placed lands in two closing columns. Runs of two-cell rows
 *  and the closing columns are balanced (Balanced.tsx): no hole under the
 *  shorter column. */
export default function LayoutGrid({ rows, panels }: { rows: Row[]; panels: { id: string; node: React.ReactNode }[] }) {
  const byId = new Map(panels.map((p) => [p.id, p.node]));
  const placed = new Set<string>();
  const out = rows.map((r) => {
    const cells = r.cells.map((c, i) => {
      const ids = (Array.isArray(c) ? c : [c]).filter((id) => byId.has(id));
      ids.forEach((id) => placed.add(id));
      return { ids, w: r.cols[i] ?? 1 };
    }).filter((c) => c.ids.length);
    return cells;
  }).filter((cells) => cells.length);
  const rest = panels.filter((p) => !placed.has(p.id));
  const items = (ids: string[]) => ids.map((id) => ({ id, node: byId.get(id) }));

  // Consecutive two-cell rows run as one balanced pair of columns, each panel
  // keeping its side, at the widths of the run's first row: a short panel no
  // longer leaves a hole beside a tall one, because the next row's panel
  // moves up under it. A one- or three-cell row (the game log across the
  // page) ends the run. The panels no row placed join the last run, or make
  // one, each going under whichever column is shorter.
  type Run = { left: string[]; right: string[]; free: string[]; w: [number, number] };
  const blocks: (Run | { cells: { ids: string[]; w: number }[] })[] = [];
  const run = (): Run | null => { const b = blocks[blocks.length - 1]; return b && "left" in b ? b : null; };
  for (const cells of out) {
    if (cells.length === 2) {
      const r = run();
      if (r) { r.left.push(...cells[0].ids); r.right.push(...cells[1].ids); }
      else blocks.push({ left: [...cells[0].ids], right: [...cells[1].ids], free: [], w: [cells[0].w, cells[1].w] });
    } else blocks.push({ cells });
  }
  if (rest.length) {
    let r = run();
    if (!r) { r = { left: [], right: [], free: [], w: [1, 1] }; blocks.push(r); }
    r.free.push(...rest.map((p) => p.id));
  }
  return (
    <div className="lay">
      {blocks.map((b, i) => "left" in b ? (
        <Balanced key={i} left={items(b.left)} right={items(b.right)} free={items(b.free)}
          leftWidth={`minmax(0, ${b.w[0]}fr)`} rightWidth={`minmax(0, ${b.w[1]}fr)`} />
      ) : (
        <div key={i} className="lay-row" style={{ gridTemplateColumns: b.cells.map((c) => `minmax(0, ${c.w}fr)`).join(" ") }}>
          {b.cells.map((c) => <div key={c.ids.join("|")} className="lay-cell">{c.ids.map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>)}</div>)}
        </div>
      ))}
    </div>
  );
}
