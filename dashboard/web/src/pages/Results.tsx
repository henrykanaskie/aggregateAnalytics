import { KeyboardEvent, useState } from "react";
import { api5, AngleFamily, AngleTrackRecord, GradeSignal, GradeSummary } from "../api";
import { Link } from "react-router-dom";
import { Outcome, prettyFamily } from "../components/AngleReview";
import { ApplyField, Banner, FilterFold, Field, Seg, Spinner } from "../components/common";
import { Drill, DrillDrawer } from "../components/ResultsDrill";
import { fmtPct } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

type Tab = "angles" | "signals" | "books" | "models";
const BREAK_EVEN = 0.524;

/** A rate with a small bar, the midline at 50%. Colour needs five or more,
 *  and a rate at least ``good`` (or at most 1 - good). */
function RateCell({ hits, n, good = 0.6 }: { hits: number; n: number; good?: number }) {
  const r = n ? hits / n : 0;
  const tone = n < 5 ? "" : r >= good ? "over" : r <= 1 - good ? "under" : "";
  return <span className="rate-cell"><span className={`mono ${tone}`}>{fmtPct(r)}</span><span className="rate-bar"><div className={tone} style={{ width: `${r * 100}%` }} /></span></span>;
}

/** Props for a table row that opens a drawer, by mouse or keyboard. */
const opens = (fn: () => void) => ({ className: "row-link", tabIndex: 0, onClick: fn, onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } } });

export default function Results() {
  const { meta, admin, adminNote } = useMeta();
  const [season, setSeason] = useSticky<number | null>("results.season", null);
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useSticky<number | "">("results.week", "");
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useSticky<Tab>("results.tab", "angles");
  const [weeks, setWeeks] = useSticky<number>("results.angleWeeks2", 22);
  const [drill, setDrill] = useState<Drill | null>(null);
  // Grading rewrites the log, so the POST drops the cached summary and this
  // pulls the new one.
  const { data, reload: load } = useQuery<GradeSummary>(api5.gradeSummary.url(season ?? undefined));
  const { data: track } = useQuery<AngleTrackRecord>(api5.angleTrack.url(weeks));
  const run = async () => {
    if (!meta) return; setBusy(true); setMsg(null);
    try {
      const w = week === "" ? Math.max(1, meta.week - 1) : week;
      const r = await api5.gradeRun(season ?? meta.season, w);
      setMsg(`Graded ${r.graded} lines for ${season ?? meta.season} week ${w}.`); load();
    } finally { setBusy(false); }
  };
  const logBase = async () => { setBusy(true); try { const r = await api5.logBaseline(); setMsg(`Logged ${r.logged} baseline projections for week ${r.week}.`); load(); } finally { setBusy(false); } };

  // The strip: one number per section, and the way to switch between them.
  const sigs = data ? [...data.signals, ...data.movement] : [];
  const cleared = sigs.filter((s) => s.n >= 30 && s.hit_rate > BREAK_EVEN).length;
  const sharp = data?.by_book.length ? [...data.by_book].sort((a, b) => a.mae - b.mae)[0] : null;
  const bestModel = data?.models.length ? [...data.models].sort((a, b) => (b.hit_rate ?? 0) - (a.hit_rate ?? 0))[0] : null;
  const tiles: { t: Tab; k: string; v: string; s: string }[] = [
    { t: "angles", k: "Matchup angles", v: track?.n ? fmtPct(track.hits / track.n) : "–", s: track?.n ? `${track.hits} of ${track.n} calls right` : "nothing graded yet" },
    { t: "signals", k: "Line signals", v: sigs.length ? `${cleared} of ${sigs.length}` : "–", s: sigs.length ? "beat break-even on 30+ lines" : "nothing graded yet" },
    { t: "books", k: "Books & markets", v: data?.n ? data.n.toLocaleString() : "–", s: sharp ? `lines graded · sharpest ${meta?.books[sharp.book] ?? sharp.book}` : "lines graded" },
    { t: "models", k: "Models", v: bestModel?.hit_rate != null ? fmtPct(bestModel.hit_rate, 1) : "–", s: bestModel ? `side hit rate · ${bestModel.model_version}` : "no predictions graded yet" },
  ];
  const openSignal = (s: GradeSignal) => setDrill({ type: "signal", id: s.id, label: s.signal, season: season ?? undefined });

  return (
    <div>
      <div className="page-head">
        <div><h1>Results</h1><div className="muted small">Every call the site makes, checked against the box score. Click any row to see the games behind it.</div></div>
        <ApplyField<number | ""> label="Season" value={(season ?? meta?.season ?? "") as number | ""} onApply={(v) => { if (typeof v === "number" && v >= 1999) setSeason(v); }} show={(v) => String(v)}>{(d, set) => <input className="input num" type="number" value={d ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />}</ApplyField>
      </div>

      {/* Both of these write to the log, so they need the admin password.
          Absent rather than disabled: they would answer 403. */}
      {admin && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <FilterFold id="results-admin" label="Grading">
            <div className="controls">
              <Field label="Grade week (blank = last)"><input className="input num" type="number" min={1} max={22} value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} /></Field>
              <button className="btn primary" disabled={busy} onClick={run}>{busy ? <Spinner /> : "Grade"}</button>
              <button className="btn" disabled={busy} onClick={logBase}>Log baseline for this week</button>
              <span className="hint">The daily script does both automatically (dashboard/scripts/daily.sh).</span>
            </div>
          </FilterFold>
          {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      )}

      <div className="res-strip" role="tablist" data-tour="results-strip">
        {tiles.map((x) => (
          <button key={x.t} role="tab" aria-selected={tab === x.t} className={`tile res-tab ${tab === x.t ? "on" : ""}`} onClick={() => setTab(x.t)}>
            <div className="k">{x.k}</div><div className="v">{x.v}</div><div className="s">{x.s}</div>
          </button>
        ))}
      </div>

      {tab === "angles" && <AnglesTab track={track} weeks={weeks} setWeeks={setWeeks} open={setDrill} />}

      {tab !== "angles" && data && data.n === 0 && <Banner kind="info">Nothing graded yet for this season. Lines can only be graded once their games have been played.</Banner>}
      {tab !== "angles" && data && data.n > 0 && (
        <>
          {tab === "signals" && (
            <div className="grid grid-2">
              <SignalTable title="Recent form: does a hot or cold streak carry?" rows={data.signals} open={openSignal}
                hint="How often he cleared this same number over his last 10 or 5 games, at least five games of history. Break-even at -110 is 52.4%: a signal has to clear that on a real sample before it deserves weight." />
              <SignalTable title="Line movement: does the move know something?" rows={data.movement} open={openSignal}
                hint="Lines that moved between the first pull and the close. If the books move for good reasons, the first row should be well over 50%." />
            </div>
          )}
          {tab === "books" && (
            <div className="grid grid-2">
              <div className="panel" data-tour="results-books">
                <div className="panel-head"><h3>By book · {data.n} lines · weeks {data.weeks.map((w) => w[1]).join(", ")}</h3></div>
                <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Book</th><th>n</th><th>Over %</th><th>Push %</th><th>MAE</th><th>Bias</th></tr></thead>
                  <tbody>{data.by_book.map((b) => <tr key={b.book}><td className="left">{meta?.books[b.book] ?? b.book}</td><td className="num muted">{b.n}</td><td className="num"><Rate v={b.over_rate} /></td><td className="num muted">{fmtPct(b.push_rate, 1)}</td><td className="num">{b.mae.toFixed(1)}</td><td className={`num ${b.bias > 0 ? "over" : "under"}`}>{b.bias > 0 ? "+" : ""}{b.bias.toFixed(1)}</td></tr>)}</tbody></table></div>
                <div className="hint" style={{ marginTop: 6 }}>MAE = average distance between the closing line and the actual (lower = sharper book). Bias = actual minus line; positive means the book's lines ran low.</div>
              </div>
              <div className="panel">
                <div className="panel-head"><h3>By market</h3></div>
                <div className="tbl-wrap" style={{ maxHeight: 480 }}><table className="tbl"><thead><tr><th className="left">Market</th><th>n</th><th>Over %</th><th>MAE</th><th>Bias</th></tr></thead>
                  <tbody>{data.by_market.map((m) => <tr key={m.market}><td className="left">{meta?.markets.find((x) => x.key === m.market)?.label ?? m.market}</td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.over_rate} /></td><td className="num">{m.mae.toFixed(1)}</td><td className={`num ${m.bias > 0 ? "over" : "under"}`}>{m.bias > 0 ? "+" : ""}{m.bias.toFixed(1)}</td></tr>)}</tbody></table></div>
                <div className="hint" style={{ marginTop: 6 }}>Over % well away from 50% says a market's lines lean one way.</div>
              </div>
            </div>
          )}
          {tab === "models" && (
            <div className="panel" data-tour="results-models">
              <div className="panel-head"><h3>Models vs the line</h3></div>
              {data.models.length === 0 && <div className="hint">No logged predictions graded yet.</div>}
              {data.models.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Model</th><th>n</th><th>Side hit %</th><th>Strong (|edge| ≥ 5)</th><th>Pred MAE</th><th>Line MAE</th></tr></thead>
                <tbody>{data.models.map((m) => <tr key={m.model_version}><td className="left"><span className="pill accent">{m.model_version}</span></td><td className="num muted">{m.n}</td><td className="num"><Rate v={m.hit_rate} /></td><td className="num">{m.n_strong ? <><Rate v={m.hit_rate_strong} /> <span className="muted">({m.n_strong})</span></> : "–"}</td><td className={`num ${m.line_mae !== null && m.pred_mae < m.line_mae ? "over" : ""}`}>{m.pred_mae.toFixed(1)}</td><td className="num muted">{m.line_mae === null ? "–" : m.line_mae.toFixed(1)}</td></tr>)}</tbody></table></div>}
              <div className="hint" style={{ marginTop: 6 }}>Side hit % = how often the actual landed on the side the prediction leaned. Pred MAE below Line MAE means the model's point estimate was closer to reality than the market's.</div>
            </div>
          )}
        </>
      )}

      {!admin && <div className="hint" style={{ marginTop: 14 }}>Grading is run by the maintainer{adminNote ? " (not configured yet)" : ""}; these pages are the result.</div>}
      <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}

const Rate = ({ v, good = 0.55 }: { v: number | null; good?: number }) => <span className={v === null ? "muted" : v >= good ? "over" : v <= 1 - good ? "under" : ""}>{fmtPct(v, 1)}</span>;

function SignalTable({ title, rows, hint, open }: { title: string; rows: GradeSignal[]; hint: string; open: (s: GradeSignal) => void }) {
  return (
    <div className="panel">
      <div className="panel-head"><h3>{title}</h3></div>
      {rows.length === 0 ? <div className="hint">Not enough graded lines yet.</div> : (
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th className="left">Signal</th><th>n</th><th>Right</th><th></th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id} {...opens(() => open(s))}>
              <td className="left" style={{ whiteSpace: "normal" }}>{s.signal}</td><td className="num muted">{s.n}</td>
              <td className="num"><RateCell hits={Math.round(s.hit_rate * s.n)} n={s.n} good={0.55} /></td><td className="go">›</td>
            </tr>
          ))}</tbody></table></div>
      )}
      <div className="hint" style={{ marginTop: 6 }}>{hint}</div>
    </div>
  );
}

type Kind = "all" | "team" | "player";
type Sort = "n" | "best" | "worst";

/** How the matchup angles have done: each kind of angle, graded game by game
 *  on the number it was about (dashboard/stats/angle_grades.py). Each row
 *  opens the games behind it. */
function AnglesTab({ track: data, weeks, setWeeks, open }: { track: AngleTrackRecord | null; weeks: number; setWeeks: (w: number) => void; open: (d: Drill) => void }) {
  const { meta } = useMeta();
  const [kind, setKind] = useSticky<Kind>("results.angleKind", "all");
  const [sort, setSort] = useSticky<Sort>("results.angleSort", "n");
  const [show, setShow] = useState(20);
  if (!data) return <div className="empty"><Spinner /></div>;
  if (data.n === 0) return <Banner kind="info">No matchup angles graded yet. <code>python -m dashboard.stats.angle_grades</code> grades every finished week.</Banner>;
  const span = data.weeks.length ? `${data.season} W${data.weeks[0][1]} to W${data.weeks[data.weeks.length - 1][1]}${data.current ? "" : `, last season: no ${meta?.season ?? "current-season"} game graded yet`}` : "";
  const openFam = (f: Pick<AngleFamily, "family" | "kind" | "lean">) => open({ type: "angle", family: f.family, kind: f.kind, lean: f.lean, weeks });
  // Best and worst only rank angles with five or more calls: a 2-for-2 is not
  // the best angle on the site.
  const fams = data.families.filter((f) => kind === "all" || f.kind === kind);
  const ranked = sort === "n" ? fams : [...fams].sort((a, b) => (Number(b.n >= 5) - Number(a.n >= 5)) || (sort === "best" ? b.rate - a.rate : a.rate - b.rate) || b.n - a.n);
  return (
    <div className="grid grid-main">
      <div className="panel" data-tour="results-angles">
        <div className="panel-head">
          <h3>Which angles have worked</h3>
          <div className="actions">
            <Seg<Kind> value={kind} onChange={setKind} options={[{ v: "all", l: "All" }, { v: "team", l: "Team" }, { v: "player", l: "Player" }]} />
            <Seg<Sort> value={sort} onChange={setSort} options={[{ v: "n", l: "Most calls" }, { v: "best", l: "Best" }, { v: "worst", l: "Worst" }]} />
            <ApplyField label="" value={weeks} onApply={setWeeks} show={(v) => (v === 22 ? "the whole season" : `the last ${v} weeks`)}>{(d, set) => <select className="input" value={d} onChange={(e) => set(Number(e.target.value))}>{[[4, "Last 4 weeks"], [8, "Last 8 weeks"], [22, "Whole season"]].map(([w, l]) => <option key={w} value={w}>{l}</option>)}</select>}</ApplyField>
          </div>
        </div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          {span} · {data.by_kind.map((k) => <span key={k.kind}>{k.kind} {k.hits}/{k.n} ({fmtPct(k.hits / k.n)}) </span>)}{data.line_n ? `· vs the line ${data.line_hits}/${data.line_n} (${fmtPct((data.line_hits ?? 0) / data.line_n)}) ` : ""}{data.absent ? ` · ${data.absent} box calls where the box never showed up` : ""}{data.hurt ? ` · ${data.hurt} counted calls on players who got hurt` : ""}
        </div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th className="left">Angle</th>{kind === "all" && <th className="left res-kind">Kind</th>}<th>Record</th><th>Right</th><th title="Against the closing prop line, on the calls that had one: a player's own line, or the sum of a position's">vs line</th><th></th></tr></thead>
          <tbody>{ranked.slice(0, show).map((f) => (
            <tr key={f.family + f.kind + f.lean} {...opens(() => openFam(f))}>
              <td className="left" style={{ whiteSpace: "normal" }}>{prettyFamily(f.family)} {f.lean !== "neutral" && <span className={`tiny ${f.lean}`}>{f.lean}</span>}</td>
              {kind === "all" && <td className="left muted small res-kind">{f.kind}</td>}
              <td className="num"><span className="over">{f.hits}</span><span className="faint">–</span><span className="under">{f.n - f.hits}</span></td>
              <td className="num"><RateCell hits={f.hits} n={f.n} /></td>
              <td className="num">{f.line_n ? <><RateCell hits={f.line_hits ?? 0} n={f.line_n} /> <span className="faint tiny">{f.line_hits}/{f.line_n}</span></> : <span className="faint">–</span>}</td>
              <td className="go">›</td>
            </tr>
          ))}</tbody>
        </table></div>
        {ranked.length > show && <button className="btn" style={{ marginTop: 8 }} onClick={() => setShow(ranked.length)}>Show all {ranked.length}</button>}
        <details style={{ marginTop: 8 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>How an angle is graded</summary>
          <div className="hint" style={{ marginTop: 6 }}>An angle is right when the number it was about landed on the side it said: the team's rate against its own pre-game number, the player's game against his previous 16, and a "generous to RBs" kind of angle on what the offense's RBs usually get, not the league average. Separately, "vs line" asks the betting question: where there was a closing prop line (the player's own, or the sum of a position's lines), did the result land on the side of it the angle leaned? This season only (last season until a game of this one is graded). Rebuilt from what was known before kickoff. Every call is a hit or a miss, with no margin: a move the way the angle said is a hit, anything else, a tie included, is a miss. Against a line, landing exactly on it is a miss too. A call on a player who got hurt in the game (under half his usual snaps, then on the next week's injury report) still counts, and is marked "got hurt" so you can read it knowing that. Box angles only count games where that box actually showed up on at least one of the carries they were about (FTN charting); the rest are left out too. Colour needs five or more.</div>
        </details>
      </div>
      <div className="panel" data-tour="results-called">
        <div className="panel-head"><h3>Called it</h3><span className="hint">clearest recent hits</span></div>
        <div className="hint" style={{ marginBottom: 8 }}>Examples of what a right call looks like, picked for how far the number moved. Not a measure of how often they are right: the table is that.</div>
        <div className="grid" style={{ gap: 8 }}>
          {data.best.slice(0, 6).map((a, i) => (
            <div key={i} className="tile case hit">
              <div className="tiny muted"><Link to={`/matchups?game=${a.game_id}`}>W{a.week} · {a.offense} vs {a.defense}</Link></div>
              <div style={{ fontWeight: 600, margin: "2px 0 3px" }}>{a.player_id ? <Link to={`/research?player=${a.player_id}`}>{a.title}</Link> : a.title}</div>
              <Outcome a={a} />
              <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => openFam(a)}>Every call like this ›</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
