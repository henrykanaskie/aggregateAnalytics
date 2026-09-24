import Balanced, { type SidedItem } from "./Balanced";
import type { Row } from "../lib/layouts";

/** Renders a layout (lib/layouts.ts) over a page's panels. A cell whose panels
 *  are all absent is dropped and its width given to the rest of the row; a
 *  panel no row placed comes after the rest. The whole layout is balanced
 *  (Balanced.tsx): two columns in the layout's order, with no hole under
 *  the shorter one. */
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

  // The whole layout is one balanced pair of columns, in the layout's order.
  // A two-cell row's panels keep their side; a panel the layout gave the full
  // width (a one-cell row, a three-cell row, or none at all) is "either":
  // it keeps the full width when the columns are level, and fills the
  // shorter column when they are not, so a short cell beside a tall one no
  // longer leaves a hole. The columns take the first two-cell row's widths.
  const items: SidedItem[] = [];
  let widths: [number, number] | null = null;
  for (const cells of out) {
    if (cells.length === 2) {
      widths = widths ?? [cells[0].w, cells[1].w];
      cells[0].ids.forEach((id) => items.push({ id, node: byId.get(id), side: "left" }));
      cells[1].ids.forEach((id) => items.push({ id, node: byId.get(id), side: "right" }));
    } else cells.forEach((c) => c.ids.forEach((id) => items.push({ id, node: byId.get(id), side: "either" })));
  }
  rest.forEach((p) => items.push({ id: p.id, node: p.node, side: "either" }));
  const [lw, rw] = widths ?? [1, 1];
  return (
    <div className="lay">
      <Balanced items={items} leftWidth={`minmax(0, ${lw}fr)`} rightWidth={`minmax(0, ${rw}fr)`} />
    </div>
  );
}
