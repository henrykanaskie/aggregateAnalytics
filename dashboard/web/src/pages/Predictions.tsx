import { api, PredictionsResponse } from "../api";
import { Field, TeamTag } from "../components/common";
import { fmtPct, fmtSpread } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

export default function Predictions() {
  const { meta } = useMeta();
  const [week, setWeek] = useSticky<number | null>("predictions.week", null);
  const { data } = useQuery<PredictionsResponse>(meta ? api.predictions.url(undefined, week ?? meta.week) : null);
  const weeks = Array.from({ length: 22 }, (_, i) => i + 1);
  return (
    <div>
      <div className="page-head"><div><h1>Predictions</h1><div className="muted small">What the model has logged. This page only reads the log; it never computes anything.</div></div></div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="controls"><Field label="Week"><select className="input" value={week ?? meta?.week ?? 1} onChange={(e) => setWeek(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select></Field></div></div>
      <div className="grid grid-2">
        <div className="panel">
          <div className="panel-head"><h3>Game predictions · data/predictions.parquet</h3><span className="hint">{data?.games.length ?? 0} rows</span></div>
          {data && data.games.length === 0 && <div className="empty">Nothing logged for this week.</div>}
          {data && data.games.length > 0 && (
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th className="left">Game</th><th className="left">Model</th><th>Home margin</th><th>Home win prob</th><th>Home spread</th><th>Edge</th><th className="left">Logged</th></tr></thead>
              <tbody>{data.games.map((p) => { const [, , away, home] = p.game_id.split("_"); const edge = p.market_spread === null ? null : p.pred_margin - p.market_spread; return (
                <tr key={p.game_id + p.model_version}><td className="left"><TeamTag abbr={away} /> @ <TeamTag abbr={home} /></td><td className="left"><span className="pill accent">{p.model_version}</span></td><td className="num">{fmtSpread(Number(p.pred_margin.toFixed(1)))}</td><td className="num">{fmtPct(p.pred_win_prob)}</td><td className="num muted">{fmtSpread(p.market_spread === null ? null : -p.market_spread)}</td><td className={`num ${edge === null ? "" : edge > 0 ? "over" : "under"}`} title="model home margin minus the market's">{edge === null ? "–" : fmtSpread(Number(edge.toFixed(1)))}</td><td className="left faint small">{new Date(p.logged_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td></tr>
              ); })}</tbody>
            </table></div>
          )}
        </div>
        <div className="panel">
          <div className="panel-head"><h3>Player prop predictions</h3><span className={`pill ${data?.prop_file_exists ? "over" : ""}`}>{data?.prop_file_exists ? "file present" : "not wired yet"}</span></div>
          <p className="small muted" style={{ marginTop: 0 }}>The research page and the lines board show a prediction next to each line as soon as the model writes rows to <code>{data?.prop_file ?? "data/derived/prop_predictions.parquet"}</code>. The contract (append-only, latest row per player + market + model wins):</p>
          <pre>{data ? Object.entries(data.prop_contract).map(([k, v]) => `${k.padEnd(14)} ${v}`).join("\n") : ""}</pre>
          <p className="small muted"><code>market</code> uses the canonical keys from <code>dashboard/odds/markets.py</code> (e.g. <code>player_reception_yds</code>). <code>pred</code> is the point estimate; <code>p_over</code> and <code>line</code> are optional and let the UI show a probability against a specific book's number.</p>
          {data && data.props.length > 0 && <pre>{JSON.stringify(data.props.slice(0, 5), null, 1)}</pre>}
        </div>
      </div>
    </div>
  );
}
