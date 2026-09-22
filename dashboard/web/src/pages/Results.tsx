import { useState } from "react";
import { api5, AngleTrackRecord, GradeSummary } from "../api";
import { Link } from "react-router-dom";
import { Outcome } from "../components/AngleReview";
import { ApplyField, Banner, Field, Spinner } from "../components/common";
import { fmtPct } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

export default function Results() {
  const { meta, admin, adminNote } = useMeta();
  const [season, setSeason] = useSticky<number | null>("results.season", null);
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useSticky<number | "">("results.week", "");
  const [msg, setMsg] = useState<string | null>(null);
  // Grading rewrites the log, so the POST drops the cached summary and this
  // pulls the new one.
  const { data, reload: load } = useQuery<GradeSummary>(api5.gradeSummary.url(season ?? undefined));
  const run = async () => {
    if (!meta) return; setBusy(true); setMsg(null);
    try {
      const w = week === "" ? Math.max(1, meta.week - 1) : week;
      const r = await api5.gradeRun(season ?? meta.season, w);
      setMsg(`Graded ${r.graded} lines for ${season ?? meta.season} week ${w}.`); load();
    } finally { setBusy(false); }
  };
  const logBase = async () => { setBusy(true); try { const r = await api5.logBaseline(); setMsg(`Logged ${r.logged} baseline projections for week ${r.week}.`); load(); } finally { setBusy(false); } };
  const Rate = ({ v, good = 0.55 }: { v: number | null; good?: number }) => <span className={v === null ? "muted" : v >= good ? "over" : v <= 1 - good ? "under" : ""}>{fmtPct(v, 1)}</span>;
  return (
    <div>
      <div className="page-head"><div><h1>Results</h1><div className="muted small">Closing lines and logged predictions graded against the box score. This is the feedback loop: which books post soft numbers, whether the hit-rate signals mean anything, and whether the projection beats the market.</div></div></div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="controls">
          <ApplyField<number | ""> label="Season" value={(season ?? meta?.season ?? "") as number | ""} onApply={(v) => { if (typeof v === "number" && v >= 1999) setSeason(v); }} show={(v) => String(v)}>{(d, set) => <input className="input num" type="number" value={d ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />}</ApplyField>
          <Field label="Grade week (blank = last)"><input className="input num" type="number" min={1} max={22} value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} /></Field>
          {/* Both of these write to the log, so they need the admin password.
              Absent rather than disabled: they would answer 403. */}
          {admin && <button className="btn primary" disabled={busy} onClick={run}>{busy ? <Spinner /> : "Grade"}</button>}
          {admin && <button className="btn" disabled={busy} onClick={logBase}>Log baseline for this week</button>}
          <span className="hint">{admin ? "The daily script does both automatically (dashboard/scripts/daily.sh)." : `Grading is run by the maintainer${adminNote ? " (not configured yet)" : ""}; the table below is the result.`}</span>
        </div>
        {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
      <AngleTrack />
      {data && data.n === 0 && <Banner kind="info">Nothing graded yet for this season. Lines can only be graded once their games have been played.</Banner>}
      {data && data.n > 0 && (
        <div className="grid grid-2">
          <div className="panel" data-tour="results-books">
            <div className="panel-head"><h3>By book · {data.n} lines · weeks {data.weeks.map((w) => w[1]).join(", ")}</h3></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Book</th><th>n</th><th>Over %</th><th>Push %</th><th>MAE</th><th>Bias</th></tr></thead>
              <tbody>{data.by_book.map((b) => <tr key={b.book}><td className="left">{meta?.books[b.book] ?? b.book}</td><td className="num muted">{b.n}</td><td className="num"><Rate v={b.over_rate} /></td><td className="num muted">{fmtPct(b.push_rate, 1)}</td><td className="num">{b.mae.toFixed(1)}</td><td className={`num ${b.bias > 0 ? "over" : "under"}`}>{b.bias > 0 ? "+" : ""}{b.bias.toFixed(1)}</td></tr>)}</tbody></table></div>
            <div className="hint" style={{ marginTop: 6 }}>MAE = average distance between the closing line and the actual (lower = sharper book). Bias = actual minus line; positive means the book's lines ran low.</div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>By market</h3></div>
            <div className="tbl-wrap" style={{ maxHeight: 360 }}><table className="tbl"><thead><tr><th className="left">Market</th><th>n</th><th>Over %</th><th>MAE</th><th>Bias</th></tr></thead>
              <tbody>{data.by_market.map((m) => <tr key={m.market}><td className="left">{meta?.markets.find((x) => x.key === m.market)?.label ?? m.market}</td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.over_rate} /></td><td className="num">{m.mae.toFixed(1)}</td><td className={`num ${m.bias > 0 ? "over" : "under"}`}>{m.bias > 0 ? "+" : ""}{m.bias.toFixed(1)}</td></tr>)}</tbody></table></div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Do the signals work?</h3></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Signal</th><th>n</th><th>Hit rate</th></tr></thead>
              <tbody>{[...data.signals, ...data.movement].map((s, i) => <tr key={i}><td className="left">{s.signal}</td><td className="num muted">{s.n}</td><td className="num"><Rate v={s.hit_rate} good={0.55} /></td></tr>)}</tbody></table></div>
            <div className="hint" style={{ marginTop: 6 }}>Break-even at -110 is 52.4%. A signal has to clear that with a real sample before it deserves weight.</div>
          </div>
          <div className="panel" data-tour="results-models">
            <div className="panel-head"><h3>Models vs the line</h3></div>
            {data.models.length === 0 && <div className="hint">No logged predictions graded yet.</div>}
            {data.models.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Model</th><th>n</th><th>Side hit %</th><th>Strong (|edge| ≥ 5)</th><th>Pred MAE</th><th>Line MAE</th></tr></thead>
              <tbody>{data.models.map((m) => <tr key={m.model_version}><td className="left"><span className="pill accent">{m.model_version}</span></td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.hit_rate} /></td><td className="num">{m.n_strong ? <><Rate v={m.hit_rate_strong} /> <span className="muted">({m.n_strong})</span></> : "–"}</td><td className={`num ${m.line_mae !== null && m.pred_mae < m.line_mae ? "over" : ""}`}>{m.pred_mae.toFixed(1)}</td><td className="num muted">{m.line_mae === null ? "–" : m.line_mae.toFixed(1)}</td></tr>)}</tbody></table></div>}
            <div className="hint" style={{ marginTop: 6 }}>Side hit % = how often the actual landed on the side the prediction leaned. Pred MAE below Line MAE means the model's point estimate was closer to reality than the market's.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** How the matchup angles have done: each kind of angle, graded game by game
 *  on the number it was about (dashboard/stats/angle_grades.py). */
function AngleTrack() {
  const { meta } = useMeta();
  const [weeks, setWeeks] = useSticky<number>("results.angleWeeks2", 22);
  const { data } = useQuery<AngleTrackRecord>(api5.angleTrack.url(weeks));
  const [show, setShow] = useState(15);
  if (!data) return null;
  if (data.n === 0) return <Banner kind="info">No matchup angles graded yet. <code>python -m dashboard.stats.angle_grades</code> grades every finished week.</Banner>;
  const Rate = ({ n, hits }: { n: number; hits: number }) => { const r = hits / n; return <span className={n < 5 ? "" : r >= 0.6 ? "over" : r <= 0.4 ? "under" : ""}>{fmtPct(r)}</span>; };
  const span = data.weeks.length ? `${data.season} W${data.weeks[0][1]} to W${data.weeks[data.weeks.length - 1][1]}${data.current ? "" : `, last season: no ${meta?.season ?? "current-season"} game graded yet`}` : "";
  return (
    <div className="grid grid-2" style={{ marginBottom: 12 }}>
      <div className="panel">
        <div className="panel-head">
          <h3>Matchup angles · {data.hits} of {data.n} right (<Rate n={data.n} hits={data.hits} />){data.pushes ? <span className="muted"> · {data.pushes} pushes</span> : null}</h3>
          <ApplyField label="Window" value={weeks} onApply={setWeeks} show={(v) => (v === 22 ? "the whole season" : `the last ${v} weeks`)}>{(d, set) => <select className="input" value={d} onChange={(e) => set(Number(e.target.value))}>{[[4, "Last 4 weeks"], [8, "Last 8 weeks"], [22, "Whole season"]].map(([w, l]) => <option key={w} value={w}>{l}</option>)}</select>}</ApplyField>
        </div>
        <div className="small muted" style={{ marginBottom: 6 }}>{span} · {data.by_kind.map((k) => <span key={k.kind}>{k.kind} angles {k.hits}/{k.n} (<Rate n={k.n} hits={k.hits} />) </span>)}</div>
        <div className="tbl-wrap" style={{ maxHeight: 420 }}><table className="tbl compact">
          <thead><tr><th className="left">Angle</th><th>Kind</th><th>n</th><th>Right</th><th>Rate</th></tr></thead>
          <tbody>{data.families.slice(0, show).map((f) => <tr key={f.family + f.kind + f.lean}><td className="left small">{f.family} <span className={`tiny ${f.lean === "over" ? "over" : f.lean === "under" ? "under" : "muted"}`}>{f.lean === "neutral" ? "" : f.lean}</span></td><td className="muted small">{f.kind}</td><td className="num muted">{f.n}</td><td className="num">{f.hits}</td><td className="num"><Rate n={f.n} hits={f.hits} /></td></tr>)}</tbody>
        </table></div>
        {data.families.length > show && <button className="btn" style={{ marginTop: 6 }} onClick={() => setShow(data.families.length)}>Show all {data.families.length}</button>}
        <div className="hint" style={{ marginTop: 6 }}>An angle is right when the number it was about landed on the side it said: the team's rate against its own pre-game number, the player's game against his previous 16. This season only (last season until a game of this one is graded). Rebuilt from what was known before kickoff. Moves under 5% of the usual number (half a point for rates, 0.02 for EPA) are pushes and left out of n. Colour needs five or more.</div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Called it · the clearest recent hits</h3></div>
        <div className="hint" style={{ marginBottom: 6 }}>Hits only, picked for how far the number moved. Examples of what a right call looks like, not a measure of how often they are right: the table is that.</div>
        <div className="grid" style={{ gap: 6 }}>
          {data.best.map((a, i) => (
            <div key={i} className="tile" style={{ borderLeft: "3px solid var(--over)", padding: "8px 10px" }}>
              <div className="small muted"><Link to={`/matchups?game=${a.game_id}`}>{a.season} W{a.week} · {a.offense} vs {a.defense}</Link></div>
              <div style={{ fontWeight: 600 }}>{a.player_id ? <Link to={`/research?player=${a.player_id}`}>{a.title}</Link> : a.title}</div>
              <Outcome a={a} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
