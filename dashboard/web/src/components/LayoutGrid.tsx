import { Fragment } from "react";
import type { Row } from "../lib/layouts";

/** Renders a layout (lib/layouts.ts) over a page's panels. A cell whose panels
 *  are all absent is dropped and its width given to the rest of the row; a
 *  panel no row placed lands in a closing two-column row. */
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
  return (
    <div className="lay">
      {out.map((cells, i) => (
        <div key={i} className="lay-row" style={{ gridTemplateColumns: cells.map((c) => `minmax(0, ${c.w}fr)`).join(" ") }}>
          {cells.map((c) => <div key={c.ids.join("|")} className="lay-cell">{c.ids.map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>)}</div>)}
        </div>
      ))}
      {rest.length > 0 && (
        <div className="lay-row lay-rest">
          {rest.map((p) => <div key={p.id} className="lay-cell">{p.node}</div>)}
        </div>
      )}
    </div>
  );
}
