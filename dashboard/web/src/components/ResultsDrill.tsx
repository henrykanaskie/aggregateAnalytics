import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api5, AngleFamilyRecord, SignalLines } from "../api";
import { fmtLine, fmtPct } from "../lib/format";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import { Mark, Outcome, prettyFamily } from "./AngleReview";
import { Seg, Spinner } from "./common";
import Drawer from "./Drawer";

/** What a Results row opens: one angle family or one line signal. */
export type Drill =
  | { type: "angle"; family: string; kind: string; lean: string; weeks: number }
  | { type: "signal"; id: string; label: string; season?: number };

export function DrillDrawer({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  const title = !drill ? null : drill.type === "angle"
    ? <><h2>{prettyFamily(drill.family)}</h2><div className="small muted" style={{ marginTop: 3 }}>{drill.kind} angle{drill.lean !== "neutral" && <> · leans <span className={drill.lean}>{drill.lean}</span></>}</div></>
    : <><h2>{drill.label}</h2><div className="small muted" style={{ marginTop: 3 }}>line signal</div></>;
  return (
    <Drawer open={!!drill} onClose={onClose} title={title}>
      {drill?.type === "angle" && <FamilyBody d={drill} />}
      {drill?.type === "signal" && <SignalBody d={drill} />}
    </Drawer>
  );
}

const Record = ({ hits, n, absent = 0, hurt = 0, unit = "calls" }: { hits: number; n: number; absent?: number; hurt?: number; unit?: string }) => {
  const r = n ? hits / n : null;
  const tone = r === null || n < 5 ? "" : r >= 0.55 ? "over" : r <= 0.45 ? "under" : "";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span className={`mono ${tone}`} style={{ fontSize: 26, fontWeight: 650 }}>{fmtPct(r)}</span>
      <span className="small"><b>{hits}</b> of <b>{n}</b> {unit} right{absent ? <span className="muted"> · {absent} where it never happened, not counted</span> : null}{hurt ? <span className="muted"> · {hurt} on a player who got hurt, counted</span> : null}</span>
    </div>
  );
};

type Verdict = "all" | "hit" | "miss" | "absent";

/** A graded number in its own format: 6.2%, +0.14, 4.1. */
const num = (v: number | null, fmt: string, signed = false) => {
  if (v === null || v === undefined) return "–";
  if (fmt === "pct") return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
  if (fmt === "dec2") return Math.abs(v) < 0.005 ? "0.00" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}`;
  if (fmt === "int") return v.toFixed(0);
  return v.toFixed(1);
};

function FamilyBody({ d }: { d: Extract<Drill, { type: "angle" }> }) {
  const { data, error } = useQuery<AngleFamilyRecord>(api5.angleFamily.url(d.family, d.kind, d.lean, d.weeks));
  const [verdict, setVerdict] = useState<Verdict>("all");
  const [openRow, setOpenRow] = useState<number | null>(null);
  const { meta } = useMeta();
  if (error) return <div className="hint">Could not load this angle: {error}</div>;
  if (!data) return <div className="empty"><Spinner /></div>;
  if (!data.rows.length) return <div className="hint">No graded games for this angle in the window.</div>;
  const rows = data.rows.filter((r) => verdict === "all" || r.verdict === verdict);
  const count = (v: Verdict) => data.rows.filter((r) => r.verdict === v).length;
  const g = data.graded_on;
  const p = data.premise;
  const hasPremise = data.rows.some((r) => r.in_game);
  const hasProp = data.rows.some((r) => r.line_result || r.lines?.length);
  const mkLabel = (m: string) => meta?.markets.find((x) => x.key === m)?.label ?? m;
  const signed = (g?.measure ?? "").includes("EPA");
  const span = data.weeks.length ? `${data.season} weeks ${data.weeks[0][1]} to ${data.weeks[data.weeks.length - 1][1]}` : "";
  const who = d.kind === "player" ? "Player" : "Offense";
  const premiseWord = p?.label === "blitzed" ? "the defense blitz" : p?.label === "light box" ? "the defense play a light box" : "the defense stack the box";
  return (
    <>
      <div className="drawer-sec">
        <Record hits={data.hits} n={data.n} absent={data.absent} hurt={data.hurt} />
        <div className="hint" style={{ marginTop: 4 }}>{span}. Right means {g ? <><b>{g.measure}</b> came in <b>{g.direction === "up" ? "higher" : "lower"}</b> than {g.baseline_label.replace(/^[A-Z]{2,3}'s usual$/, "the team's usual")}</> : "the number moved the way the angle said"}.</div>
      </div>

      {data.prop && (
        <div className="drawer-sec">
          <h4>Against the closing line</h4>
          <div className="small">Landed on the side of the closing line the angle leaned in <b>{data.prop.agreed} of {data.prop.n}</b> ({fmtPct(data.prop.agreed / data.prop.n)}) {d.kind === "team" ? " player lines, each player's line its own call" : " games that had one"}. That is the betting question: was the line set too high or too low, the way the angle said. The record above is against {g?.baseline_label.replace(/^[A-Z]{2,3}'s usual$/, "the team's usual") ?? "the usual number"}, so the two can disagree when the line already priced the matchup in.</div>
        </div>
      )}

      {p && (
        <div className="drawer-sec">
          <h4>Did {premiseWord}?</h4>
          <div className="tile" style={{ padding: "10px 12px" }}>
            <div className="small"><b>{p.snaps} of {p.of}</b> {p.label === "blitzed" ? "dropbacks were blitzed" : `carries came against ${p.label.startsWith("8") ? "an" : "a"} ${p.label}`} ({fmtPct(p.snaps / Math.max(1, p.of))}) across these {p.games} games.</div>
            {p.on !== null && p.off !== null && (
              <div className="small" style={{ marginTop: 4 }}>On those: <b className="mono">{num(p.on, p.label === "blitzed" ? "dec2" : "dec1", p.label === "blitzed")}</b> {p.unit}. On everything else: <b className="mono">{num(p.off, p.label === "blitzed" ? "dec2" : "dec1", p.label === "blitzed")}</b>.</div>
            )}
            {p.never > 0 && <div className="small" style={{ marginTop: 4 }}>In <b>{p.never}</b> of the {p.games} games it never happened at all. Those are left out of the record above: a game with no {p.label} carries says nothing about the angle.</div>}
            <div className="hint" style={{ marginTop: 6 }}>From FTN's play charting, which counts the defenders in the box on every carry.</div>
          </div>
        </div>
      )}

      {d.kind === "team" && <PlayerLinesTable rows={data.rows} lean={d.lean} label={mkLabel} />}

      <div className="drawer-sec">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>{d.kind === "player" ? "Every player it was called on" : "The team number it is graded on"}</h4>
          <Seg<Verdict> value={verdict} onChange={setVerdict} options={[
            { v: "all", l: `All ${data.rows.length}` }, { v: "hit", l: `Right ${count("hit")}` }, { v: "miss", l: `Wrong ${count("miss")}` },
            ...(count("absent") ? [{ v: "absent" as Verdict, l: `Didn't happen ${count("absent")}` }] : [])]} />
        </div>
        <div className="tbl-wrap"><table className="tbl compact tight pin-first">
          <thead><tr>
            <th className="left">{who}</th><th className="left">Wk · vs</th>
            {hasPremise && <th>{p?.label ?? "Premise"}</th>}{hasPremise && <th>{p?.label === "blitzed" ? "EPA there / rest" : "YPC there / rest"}</th>}
            <th>{g?.measure ?? "Number"}</th><th>Usual</th>{hasProp && <th>{d.kind === "team" ? "Player lines" : "Prop"}</th>}<th></th>
          </tr></thead>
          <tbody>{rows.map((a, i) => {
            const ig = a.in_game;
            const f = a.fmt;
            const open = openRow === i;
            const cols = 5 + (hasPremise ? 2 : 0) + (hasProp ? 1 : 0);
            const perSnap = (sum: number, n: number) => (n ? num(sum / n, p?.label === "blitzed" ? "dec2" : "dec1", p?.label === "blitzed") : "–");
            return (
              <Fragment key={i}>
                <tr className="row-link" tabIndex={0} onClick={() => setOpenRow(open ? null : i)} onKeyDown={(e) => { if (e.key === "Enter") setOpenRow(open ? null : i); }}>
                  <td className="left">{a.player_id ? <Link to={`/research?player=${a.player_id}`} onClick={(e) => e.stopPropagation()}>{a.player}</Link> : <b>{a.offense}</b>}{a.player && <span className="faint tiny"> {a.offense}</span>}{a.hurt && <span className="pill warn" style={{ marginLeft: 6 }} title={`${Math.round((a.snap_pct ?? 0) * 100)}% of snaps against his usual ${Math.round((a.usual_snap_pct ?? 0) * 100)}%, then on the next injury report. The call still counts.`}>got hurt</span>}</td>
                  <td className="left muted">W{a.week} · <Link to={`/matchups?game=${a.game_id}`} onClick={(e) => e.stopPropagation()}>{a.defense}</Link></td>
                  {hasPremise && <td className={`num ${ig && ig.snaps === 0 ? "faint" : ""}`}>{ig ? `${ig.snaps}/${ig.of}` : "–"}</td>}
                  {hasPremise && <td className="num">{ig ? <>{perSnap(ig.on_sum, ig.on_n)} <span className="faint">/</span> {perSnap(ig.off_sum, ig.off_n)}</> : "–"}</td>}
                  <td className={`num ${a.verdict === "hit" ? "over" : a.verdict === "miss" ? "under" : ""}`}>{num(a.actual, f, signed)}</td>
                  <td className="num muted">{num(a.baseline, f, signed)}</td>
                  {hasProp && d.kind === "team" && <td className="num">{a.lines?.length ? <span className={a.lines.filter((l) => l.agreed).length * 2 >= a.lines.length ? "over" : "under"}>{a.lines.filter((l) => l.agreed).length}/{a.lines.length} {d.lean}</span> : <span className="faint">–</span>}</td>}
                  {hasProp && d.kind !== "team" && <td className="num">{a.line_result ? <span className={a.line_verdict === "hit" ? "over" : a.line_verdict === "miss" ? "under" : ""} title={a.line !== null ? `line ${a.line}${a.line_actual != null ? `, had ${a.line_actual}` : ""}` : undefined}>{a.line_result}</span> : <span className="faint">–</span>}</td>}
                  <td><Mark v={a.verdict} /></td>
                </tr>
                {open && (
                  <tr><td colSpan={cols} className="left" style={{ whiteSpace: "normal", background: "var(--bg-2)" }}>
                    <div className="case-pre" style={{ marginTop: 0 }}><b>Before kickoff:</b> {a.detail}</div>
                    {ig && <div className="small" style={{ marginBottom: 4 }}><b>In the game:</b> {ig.premise}; {ig.split}.</div>}
                    <Outcome a={a} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table></div>
        <div className="hint" style={{ marginTop: 6 }}>
          Click a row for what the page said before kickoff and the box score.
          {hasPremise && <> The {p?.label ?? "premise"} column is how many of his {p?.label === "blitzed" ? "dropbacks" : "carries"} it actually happened on; a faint 0 means it never did.</>}
          {hasProp && d.kind !== "team" && <> Prop is where he finished against the closing line, green when it was the way the angle leaned.</>}
          {hasProp && d.kind === "team" && <> Player lines is how many of the offense's players with a line went {d.lean} it; each one is listed in the table above.</>}
        </div>
      </div>

      {data.why && (
        <div className="drawer-sec">
          <h4>Why it should work</h4>
          <p className="drawer-why">{data.why}</p>
        </div>
      )}

    </>
  );
}

/** A team angle read the way a bettor reads it: every player it pointed at,
 *  his closing line, and whether he went the way the angle leaned. Only the
 *  calls in the record (not a box that never showed up). */
function PlayerLinesTable({ rows, lean, label }: { rows: AngleFamilyRecord["rows"]; lean: string; label: (m: string) => string }) {
  const [show, setShow] = useState<"all" | "right" | "wrong">("all");
  const all = rows.filter((r) => r.verdict === "hit" || r.verdict === "miss")
    .flatMap((r) => (r.lines ?? []).map((l) => ({ ...l, week: r.week, game_id: r.game_id, opp: l.team === r.defense ? r.offense : r.defense })));
  if (!all.length) return (
    <div className="drawer-sec"><h4>Player lines</h4><div className="hint">No closing player lines for this angle's markets in these games.</div></div>
  );
  const right = all.filter((l) => l.agreed).length;
  const list = all.filter((l) => show === "all" || l.agreed === (show === "right"));
  return (
    <div className="drawer-sec">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <h4 style={{ margin: 0 }}>Every player line · {right} of {all.length} went {lean} ({fmtPct(right / all.length)})</h4>
        <Seg value={show} onChange={setShow} options={[{ v: "all", l: `All ${all.length}` }, { v: "right", l: `Went ${lean} ${right}` }, { v: "wrong", l: `Didn't ${all.length - right}` }]} />
      </div>
      <div className="tbl-wrap"><table className="tbl compact tight pin-first">
        <thead><tr><th className="left">Player</th><th className="left">Wk · vs</th><th className="left">Market</th><th>Line</th><th>Had</th><th></th></tr></thead>
        <tbody>{list.map((l, i) => (
          <tr key={i}>
            <td className="left"><Link to={`/research?player=${l.player_id}`}>{l.player}</Link> <span className="faint tiny">{l.position ?? ""} {l.team}</span></td>
            <td className="left muted">W{l.week} · <Link to={`/matchups?game=${l.game_id}`}>{l.opp}</Link></td>
            <td className="left small">{label(l.market)}</td>
            <td className="num">{fmtLine(l.line)}</td>
            <td className={`num ${l.agreed ? "over" : "under"}`}>{l.actual}</td>
            <td><span className={`pill ${l.agreed ? "over" : "under"}`}>{l.agreed ? "✓" : "✗"} {l.result}</span></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="hint" style={{ marginTop: 6 }}>Each player's closing line is its own call. Landing exactly on the line counts as not going {lean}.</div>
    </div>
  );
}

type Hit = "all" | "right" | "wrong";

function SignalBody({ d }: { d: Extract<Drill, { type: "signal" }> }) {
  const { meta } = useMeta();
  const { data, error } = useQuery<SignalLines>(api5.signalLines.url(d.id, d.season));
  const [hit, setHit] = useState<Hit>("all");
  const [market, setMarket] = useState<string | null>(null);
  const [show, setShow] = useState(60);
  const label = (m: string) => meta?.markets.find((x) => x.key === m)?.label ?? m;
  // Where the signal works and where it does not: the same rate by market.
  const byMarket = useMemo(() => {
    const m = new Map<string, { n: number; hits: number }>();
    for (const r of data?.rows ?? []) { const e = m.get(r.market) ?? { n: 0, hits: 0 }; e.n++; if (r.hit) e.hits++; m.set(r.market, e); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [data]);
  if (error) return <div className="hint">Could not load this signal: {error}</div>;
  if (!data) return <div className="empty"><Spinner /></div>;
  if (!data.rows.length) return <div className="hint">This signal has not fired on a graded line yet.</div>;
  const form = d.id.startsWith("l10") ? "l10_rate" : d.id.startsWith("l5") ? "l5_rate" : null;
  const rows = data.rows.filter((r) => (hit === "all" || r.hit === (hit === "right")) && (!market || r.market === market));
  const right = data.rows.filter((r) => r.hit).length;
  return (
    <>
      <div className="drawer-sec"><Record hits={data.hits} n={data.n} unit="lines" /><div className="hint" style={{ marginTop: 4 }}>Break-even for a bet at -110 is 52.4%.</div></div>
      <div className="drawer-sec"><h4>The idea, and the catch</h4><p className="drawer-why">{data.why}</p></div>
      <div className="drawer-sec">
        <h4>By market</h4>
        <div className="chips">
          {byMarket.map(([m, e]) => {
            const r = e.hits / e.n;
            return (
              <button key={m} className={`chip chip-btn ${market === m ? "on" : ""}`} onClick={() => setMarket(market === m ? null : m)}>
                {label(m)} <span className={`mono ${e.n < 10 ? "" : r >= 0.55 ? "over" : r <= 0.45 ? "under" : ""}`}>{e.hits}/{e.n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="drawer-sec">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>Every line{market ? ` · ${label(market)}` : ""}</h4>
          <Seg<Hit> value={hit} onChange={setHit} options={[{ v: "all", l: `All ${data.rows.length}` }, { v: "right", l: `Right ${right}` }, { v: "wrong", l: `Wrong ${data.rows.length - right}` }]} />
        </div>
        <div className="tbl-wrap"><table className="tbl compact tight">
          <thead><tr><th className="left">Player</th><th>Wk</th><th className="left">Market</th><th>{form ? "Line" : "Open → close"}</th>{form && <th>{form === "l10_rate" ? "L10" : "L5"}</th>}<th>Actual</th><th></th></tr></thead>
          <tbody>{rows.slice(0, show).map((r, i) => (
            <tr key={i}>
              <td className="left"><Link to={`/research?player=${r.player_id}`}>{r.player_name}</Link> <span className="faint tiny">{r.team}</span></td>
              <td className="num muted">{r.week}</td>
              <td className="left small">{label(r.market)}</td>
              <td className="num">{form ? fmtLine(r.line) : <>{fmtLine(r.open_line)} → {fmtLine(r.line)}</>}</td>
              {form && <td className="num muted">{fmtPct(r[form])}</td>}
              <td className={`num ${r.result}`}>{r.actual}</td>
              <td><span className={`pill ${r.hit ? "over" : "under"}`}>{r.hit ? "✓" : "✗"} {r.result}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
        {rows.length > show && <button className="btn" style={{ marginTop: 8 }} onClick={() => setShow(rows.length)}>Show all {rows.length}</button>}
      </div>
    </>
  );
}
