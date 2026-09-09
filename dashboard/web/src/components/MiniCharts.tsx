import { useState } from "react";
import type { GameRow } from "../api";
import { fmtStat } from "../lib/format";
import { summarize } from "../lib/stats";
import { useMeta } from "../state";
import PropChart from "./PropChart";
import StatPicker from "./StatPicker";

/** Small multiples: any set of stats over the same filtered games. */
export default function MiniCharts({ rows, keys, setKeys, available, position, onFocus }: { rows: GameRow[]; keys: string[]; setKeys: (k: string[]) => void; available?: Record<string, number>; position?: string | null; onFocus: (k: string) => void }) {
  const { statByKey } = useMeta();
  const [add, setAdd] = useState("targets");
  return (
    <div>
      <div className="panel-head">
        <h3>Compare stats · same games</h3>
        <div className="actions">
          <StatPicker value={add} onChange={setAdd} available={available} position={position} />
          <button className="btn sm" onClick={() => !keys.includes(add) && setKeys([...keys, add])}>+ add</button>
          {keys.length > 0 && <button className="btn sm ghost" onClick={() => setKeys([])}>clear</button>}
        </div>
      </div>
      {keys.length === 0 && <div className="empty">Add stats to compare them side by side over the filtered games.</div>}
      <div className="minis">
        {keys.map((k) => {
          const s = statByKey.get(k);
          const sum = summarize(rows, k, null);
          return (
            <div className="mini" key={k}>
              <div className="t">
                <b className="clickable" onClick={() => onFocus(k)} title="make this the main chart">{s?.label ?? k}</b>
                <span className="muted">avg <span className="num">{fmtStat(sum.avg, s?.fmt)}</span> · <button className="btn sm ghost" style={{ padding: "0 4px" }} onClick={() => setKeys(keys.filter((x) => x !== k))}>×</button></span>
              </div>
              <PropChart rows={rows} statKey={k} stat={s} line={null} height={120} compact showRolling={false} showAvg />
            </div>
          );
        })}
      </div>
    </div>
  );
}
