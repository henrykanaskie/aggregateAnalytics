import { useEffect, useState } from "react";
import { api5, GradeSummary } from "../api";
import { Banner, Field, Spinner } from "../components/common";
import { fmtPct } from "../lib/format";
import { useMeta } from "../state";

export default function Results() {
  const { meta } = useMeta();
  const [data, setData] = useState<GradeSummary | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useState<number | "">("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api5.gradeSummary(season ?? undefined).then(setData);
  useEffect(() => { load(); }, [season]);
  const run = async () => {
    if (!meta) return; setBusy(true); setMsg(null);
    try {
      const w = week === "" ? Math.max(1, meta.week - 1) : week;
      const r = await api5.gradeRun(season ?? meta.season, w);
      setMsg(`Graded ${r.graded} lines for ${season ?? meta.season} week ${w}.`); await load();
    } finally { setBusy(false); }
  };
  const logBase = async () => { setBusy(true); try { const r = await api5.logBaseline(); setMsg(`Logged ${r.logged} baseline projections for week ${r.week}.`); } finally { setBusy(false); } };
  const Rate = ({ v, good = 0.55 }: { v: number | null; good?: number }) => <span className={v === null ? "muted" : v >= good ? "over" : v <= 1 - good ? "under" : ""}>{fmtPct(v, 1)}</span>;
  return (
    <div>
      <div className="page-head"><div><h1>Results</h1><div className="muted small">Closing lines and logged predictions graded against the box score. This is the feedback loop: which books post soft numbers, whether the hit-rate signals mean anything, and whether the projection beats the market.</div></div></div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="controls">
          <Field label="Season"><input className="input num" type="number" value={season ?? meta?.season ?? ""} onChange={(e) => setSeason(Number(e.target.value))} /></Field>
          <Field label="Grade week (blank = last)"><input className="input num" type="number" min={1} max={22} value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} /></Field>
          <button className="btn primary" disabled={busy} onClick={run}>{busy ? <Spinner /> : "Grade"}</button>
          <button className="btn" disabled={busy} onClick={logBase}>Log baseline for this week</button>
          <span className="hint">The daily script does both automatically (dashboard/scripts/daily.sh).</span>
        </div>
        {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
      {data && data.n === 0 && <Banner kind="info">Nothing graded yet for this season. Lines can only be graded once their games have been played.</Banner>}
      {data && data.n > 0 && (
        <div className="grid grid-2">
          <div className="panel">
            <div className="panel-head"><h3>By book · {data.n} lines · weeks {data.weeks.map((w) => w[1]).join(", ")}</h3></div>
            <table className="tbl"><thead><tr><th className="left">Book</th><th>n</th><th>Over %</th><th>Push %</th><th>MAE</th><th>Bias</th></tr></thead>
              <tbody>{data.by_book.map((b) => <tr key={b.book}><td className="left">{meta?.books[b.book] ?? b.book}</td><td className="num muted">{b.n}</td><td className="num"><Rate v={b.over_rate} /></td><td className="num muted">{fmtPct(b.push_rate, 1)}</td><td className="num">{b.mae.toFixed(1)}</td><td className={`num ${b.bias > 0 ? "over" : "under"}`}>{b.bias > 0 ? "+" : ""}{b.bias.toFixed(1)}</td></tr>)}</tbody></table>
            <div className="hint" style={{ marginTop: 6 }}>MAE = average distance between the closing line and the actual (lower = sharper book). Bias = actual minus line; positive means the book's lines ran low.</div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>By market</h3></div>
            <div className="tbl-wrap" style={{ maxHeight: 360 }}><table className="tbl"><thead><tr><th className="left">Market</th><th>n</th><th>Over %</th><th>MAE</th><th>Bias</th></tr></thead>
              <tbody>{data.by_market.map((m) => <tr key={m.market}><td className="left">{meta?.markets.find((x) => x.key === m.market)?.label ?? m.market}</td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.over_rate} /></td><td className="num">{m.mae.toFixed(1)}</td><td className={`num ${m.bias > 0 ? "over" : "under"}`}>{m.bias > 0 ? "+" : ""}{m.bias.toFixed(1)}</td></tr>)}</tbody></table></div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Do the signals work?</h3></div>
            <table className="tbl"><thead><tr><th className="left">Signal</th><th>n</th><th>Hit rate</th></tr></thead>
              <tbody>{[...data.signals, ...data.movement].map((s, i) => <tr key={i}><td className="left">{s.signal}</td><td className="num muted">{s.n}</td><td className="num"><Rate v={s.hit_rate} good={0.55} /></td></tr>)}</tbody></table>
            <div className="hint" style={{ marginTop: 6 }}>Break-even at -110 is 52.4%. A signal has to clear that with a real sample before it deserves weight.</div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Models vs the line</h3></div>
            {data.models.length === 0 && <div className="hint">No logged predictions graded yet.</div>}
            {data.models.length > 0 && <table className="tbl"><thead><tr><th className="left">Model</th><th>n</th><th>Side hit %</th><th>Strong (|edge| ≥ 5)</th><th>Pred MAE</th><th>Line MAE</th></tr></thead>
              <tbody>{data.models.map((m) => <tr key={m.model_version}><td className="left"><span className="pill accent">{m.model_version}</span></td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.hit_rate} /></td><td className="num">{m.n_strong ? <><Rate v={m.hit_rate_strong} /> <span className="muted">({m.n_strong})</span></> : "–"}</td><td className={`num ${m.line_mae !== null && m.pred_mae < m.line_mae ? "over" : ""}`}>{m.pred_mae.toFixed(1)}</td><td className="num muted">{m.line_mae === null ? "–" : m.line_mae.toFixed(1)}</td></tr>)}</tbody></table>}
            <div className="hint" style={{ marginTop: 6 }}>Side hit % = how often the actual landed on the side the prediction leaned. Pred MAE below Line MAE means the model's point estimate was closer to reality than the market's.</div>
          </div>
        </div>
      )}
    </div>
  );
}
