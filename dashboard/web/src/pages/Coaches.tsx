import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Link as RLink } from "react-router-dom";
import { api2, api3, CoachProfile, CoachRoleKey, CoachSummary, CoachUsageRow } from "../api";
import { fmtPct } from "../lib/format";
import { Banner, Field, Seg, Spinner, TeamTag } from "../components/common";
import { fmtStat } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import { PCT_LEGEND, barFill, oriented, rankTint, shownRank } from "../lib/rank";
import ScatterPlot from "../components/ScatterPlot";
import { fmtStat as fmtS } from "../lib/format";
import { axisEnds, describeQuadrants } from "../lib/quadrants";

const ROLES: { v: CoachRoleKey; l: string }[] = [{ v: "HC", l: "Head coaches" }, { v: "OC", l: "OCs" }, { v: "DC", l: "DCs" }];
// A coordinator is only answerable for his own side of the ball, so the side
// toggle is a head-coach control; for an OC or a DC the side is the job.
const ROLE_SIDE: Record<CoachRoleKey, "off" | "def" | null> = { HC: null, OC: "off", DC: "def" };
const ROLE_NOUN: Record<CoachRoleKey, string> = { HC: "head coach", OC: "offensive coordinator", DC: "defensive coordinator" };

export default function Coaches() {
  const { meta } = useMeta();
  const [sp, setSp] = useSearchParams();
  const name = sp.get("coach") ?? "";
  const role = ((sp.get("role") as CoachRoleKey) || "HC") as CoachRoleKey;
  const [hcSide, setHcSide] = useSticky<"off" | "def">("coaches.side", "off");
  const side = ROLE_SIDE[role] ?? hcSide;
  const [q, setQ] = useSticky("coaches.q", "");
  const [onlyActive, setOnlyActive] = useSticky("coaches.onlyActive", true);
  const [sx, setSx] = useSticky("coaches.sx", "pass_rate");
  const [sy, setSy] = useSticky("coaches.sy", "sec_per_play");
  const haveCoords = meta?.have_coordinators ?? true;
  const roleReady = role === "HC" || haveCoords;
  const select = (next: { coach?: string; role?: CoachRoleKey }) => {
    const r = next.role ?? role;
    const c = next.coach ?? "";
    setSp(c ? { role: r, coach: c } : { role: r });
  };
  const { data: allCoaches, error: listErr } = useQuery<CoachSummary[]>(roleReady ? api2.coaches.url(role) : null);
  const list = allCoaches ?? [];
  // Someone in his first season has the job but no numbers yet, so there is
  // nothing to fetch and a 404 would read as a broken page.
  const picked = list.find((c) => c.coach === name);
  const noHistory = !!picked && !picked.has_history;
  const { data: prof, error: profErr } = useQuery<CoachProfile>(name && roleReady && !noHistory ? api2.coach.url(name, role) : null);
  // Who got the ball is an offensive question; a DC's page has no use for it.
  const wantUsage = name && roleReady && !noHistory && role !== "DC";
  const { data: usageResp } = useQuery<{ coach: string; rows: CoachUsageRow[] }>(wantUsage ? api3.coachUsage.url(name, role) : null);
  const usage = usageResp?.rows ?? [];
  const err = listErr ?? profErr;
  const sides = prof?.sides ?? (ROLE_SIDE[role] ? [ROLE_SIDE[role] as string] : ["off", "def"]);
  const allMetrics = (prof?.metrics ?? meta?.team_metrics ?? []).filter((m) => sides.includes(m.side));
  const metrics = allMetrics.filter((m) => m.side === side);
  const fp = useMemo(() => (prof?.fingerprint ?? []).filter((f) => f.side === side && f.seasons >= 2), [prof, side]);
  // Only worth a column when the seasons actually came from more than one job.
  const mixed = Object.keys(prof?.season_roles ?? {}).length > 1;
  // Which side of the ball each job answers for, taken from the API rather
  // than restated here, so the rule lives in one place.
  const sidesOf = (held: CoachRoleKey) => meta?.coach_roles?.find((r) => r.key === held)?.sides ?? ["off", "def"];
  const answersFor = (held: CoachRoleKey, sd: string) => sidesOf(held).includes(sd);
  // A head coach's offensive years include the ones he spent coordinating an
  // offense; his defensive table must not, or it credits him with a defense he
  // never ran.
  const seasonsThisSide = (prof?.seasons ?? []).filter((s) => answersFor(s.held, side));
  const shown = useMemo(() => list.filter((c) => (!onlyActive || c.current_team) && (!q || c.coach.toLowerCase().includes(q.toLowerCase()))), [list, onlyActive, q]);
  // A coordinator's scatter axes have to come from his own side, or the
  // selector offers him metrics his page cannot plot.
  const axisMetrics = allMetrics;
  const ax = axisMetrics.some((m) => m.key === sx) ? sx : axisMetrics[0]?.key ?? sx;
  const ay = axisMetrics.some((m) => m.key === sy) ? sy : axisMetrics[1]?.key ?? sy;
  if (meta && !meta.team_table_ready) return <Banner kind="warn">The team tendency table is not built yet. Run <code>python -m dashboard.stats.team</code> and reload.</Banner>;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Coaches</h1>
          <div className="muted small">A coach's tendencies over the seasons he ran, with the league rank each year. "Feeds his running backs" becomes a number: RB target share, and how many seasons it ranked in the top third. Coordinators are here too, each judged only on his own side of the ball.</div>
        </div>
        <Field label="Role"><Seg value={role} options={ROLES} onChange={(r) => select({ role: r as CoachRoleKey })} /></Field>
      </div>
      {err && <Banner kind="err">{err}</Banner>}
      {!roleReady && <Banner kind="warn">Coordinators are not in the cache yet. nflverse carries no OC or DC anywhere, so they are scraped separately: run <code>python -m data_handling.fetch_coordinators</code> and reload.</Banner>}
      <div className="grid grid-main grid-side-340">
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="controls" style={{ marginBottom: 8 }}>
            <input className="input" placeholder={`filter ${role === "HC" ? "coaches" : role + "s"}…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
            <button className={`chip ${onlyActive ? "on" : ""}`} onClick={() => setOnlyActive(!onlyActive)}>2026 {role}s</button>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: "70vh" }}>
            <table className="tbl compact">
              <thead><tr><th className="left">{role === "HC" ? "Coach" : role}</th><th className="left">Now</th><th>Yrs</th><th>W-L</th></tr></thead>
              <tbody>{shown.map((c) => <tr key={c.coach} className={`clickable ${c.coach === name ? "hl" : ""}`} onClick={() => select({ coach: c.coach })}><td className="left">{c.coach}</td><td className="left">{c.current_team ? <TeamTag abbr={c.current_team} /> : <span className="faint small">{c.first_season}–{c.last_season}</span>}</td><td className="num muted">{c.seasons}</td><td className="num muted">{c.wins}-{c.losses}</td></tr>)}</tbody>
            </table>
          </div>
          {roleReady && shown.length === 0 && <div className="hint" style={{ marginTop: 8 }}>Nobody matches. {onlyActive ? "The 2026 filter is on." : ""}</div>}
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          {!name && roleReady && <div className="empty">Pick a {ROLE_NOUN[role]}.</div>}
          {noHistory && (
            <div className="panel">
              <h2>{name}</h2>
              <div className="muted small">{picked?.current_team ? <>2026: <Link to={`/teams?team=${picked.current_team}`}><TeamTag abbr={picked.current_team} name /></Link></> : null}</div>
              <div className="hint" style={{ marginTop: 8 }}>First season in this job. The tendency table runs through 2025, so there is nothing to profile until 2026 games are played.</div>
            </div>
          )}
          {name && !prof && !err && roleReady && !noHistory && <div className="empty"><Spinner /></div>}
          {prof && (
            <>
              <div className="panel" data-tour="coach-profile">
                <div className="panel-head">
                  <div>
                    <h2>{prof.coach}</h2>
                    <div className="muted small">{prof.role_label} · {prof.current_team ? <>2026: <Link to={`/teams?team=${prof.current_team}`}><TeamTag abbr={prof.current_team} name /></Link> · </> : null}{prof.seasons.length} seasons{mixed ? ` (${Object.entries(prof.season_roles).map(([r, n]) => `${n} as ${r}`).join(", ")})` : ""} · {prof.seasons.reduce((a, s) => a + s.win, 0)}-{prof.seasons.reduce((a, s) => a + s.loss, 0)} · teams {[...new Set(prof.seasons.map((s) => s.team))].join(", ")}</div>
                    {prof.also.filter((a) => a.role !== role).length > 0 && (
                      <div className="hint" style={{ marginTop: 4 }}>Also{" "}
                        {prof.also.filter((a) => a.role !== role).map((a, i) => (
                          <span key={a.role}>{i > 0 ? ", " : ""}<a href="#" onClick={(e) => { e.preventDefault(); select({ coach: prof.coach, role: a.role }); }}>{a.label.toLowerCase()} {a.first_season}–{a.last_season}</a></span>
                        ))}
                      </div>
                    )}
                  </div>
                  {role === "HC" && <Field label="Side"><Seg value={side} options={[{ v: "off", l: "Offense" }, { v: "def", l: "Defense" }]} onChange={setHcSide} /></Field>}
                </div>
                {prof.attribution === "season" && (
                  <div className="hint" style={{ marginBottom: 8 }}>
                    Coordinator tenures are dated by season, not by game: the source lists each season's final staff, so a mid-season hire owns the whole year and the man he replaced owns none of it. These are the team's full-season numbers.
                    {(prof.season_roles.HC ?? 0) > 0 && <> His {prof.season_roles.HC} season{prof.season_roles.HC === 1 ? "" : "s"} as a head coach {prof.season_roles.HC === 1 ? "is" : "are"} counted here too: a head coach answers for this side of the ball as much as a coordinator does. The <b>Job</b> column says which is which.</>}
                  </div>
                )}
                <h3 style={{ marginBottom: 6 }}>Tendency fingerprint</h3>
                <div className="hint" style={{ marginBottom: 8 }}>Average league percentile of each tendency across his seasons (regular season). Far from the middle = a consistent identity. Colour is the percentile itself: {PCT_LEGEND}. Where a lower number is better, the percentile is taken the good way round, so green is always the good end. "Top ⅓" counts the seasons ranked in the top third of the league.</div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th className="left">Tendency</th><th>Career</th><th style={{ width: 180 }}>Percentile</th><th>Seasons</th><th>Top ⅓</th><th>Bottom ⅓</th></tr></thead>
                    <tbody>{fp.map((f) => (
                      <tr key={f.key}><td className="left">{f.label}</td><td className="num">{fmtStat(f.career, f.fmt as any)}</td>
                        {(() => { const p = oriented(f.mean_pct, f.good) ?? 0; const [top, bottom] = f.good === "low" ? [f.bottom_third, f.top_third] : [f.top_third, f.bottom_third]; return <>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="bar" style={{ flex: 1, marginTop: 0 }}><div style={{ width: `${p * 100}%`, background: barFill(p) }} /></div><span className="num tiny" style={{ width: 30 }}>{Math.round(p * 100)}</span></div></td>
                        <td className="num muted">{f.seasons}</td><td className={`num ${top >= f.seasons / 2 ? "over" : ""}`}>{top}</td><td className={`num ${bottom >= f.seasons / 2 ? "under" : ""}`}>{bottom}</td></>; })()}</tr>
                    ))}</tbody>
                  </table>
                </div>
                {fp.length === 0 && <div className="hint">Only one season on record, so there is no fingerprint to average yet.</div>}
              </div>
              {usage.length > 0 && (
                <div className="panel">
                  <div className="panel-head"><h3>Who got the ball · lead RB, WR and TE each season</h3><span className="hint">shares are of the team's regular-season targets / carries</span></div>
                  <div className="tbl-wrap"><table className="tbl compact tight">
                    <thead><tr><th className="left">Season</th><th className="left">Team</th><th className="left">RB1</th><th>Carry share</th><th>RB2 share</th><th>RB1 tgt/g</th><th>RB tgt share</th><th className="left">WR1</th><th>Tgt share</th><th className="left">TE1</th><th>Tgt share</th></tr></thead>
                    <tbody>{usage.slice().reverse().map((u) => (
                      <tr key={`${u.season}-${u.team}`}><td className="left">{u.season}</td><td className="left"><TeamTag abbr={u.team} /></td>
                        <td className="left">{u.rb1 ? <RLink to={`/research?player=${u.rb1.player_id}`}>{u.rb1.name}</RLink> : "–"}</td><td className="num">{u.rb1 ? fmtPct(u.rb1.carry_share) : "–"}</td><td className="num muted">{u.rb2_carry_share !== undefined ? fmtPct(u.rb2_carry_share) : "–"}</td><td className="num">{u.rb1 ? u.rb1.targets_pg.toFixed(1) : "–"}</td><td className="num">{fmtPct(u.rb_target_share)}</td>
                        <td className="left">{u.wr1 ? <RLink to={`/research?player=${u.wr1.player_id}`}>{u.wr1.name}</RLink> : "–"}</td><td className="num">{u.wr1 ? fmtPct(u.wr1.target_share) : "–"}</td>
                        <td className="left">{u.te1 ? <RLink to={`/research?player=${u.te1.player_id}`}>{u.te1.name}</RLink> : "–"}</td><td className="num">{u.te1 ? fmtPct(u.te1.target_share) : "–"}</td></tr>
                    ))}</tbody>
                  </table></div>
                </div>
              )}
              <div className="panel">
                <div className="panel-head"><h3>Seasons as dots</h3>
                  <div className="controls">
                    <Field label="X"><select className="input" value={ax} onChange={(e) => setSx(e.target.value)}>{axisMetrics.map((m) => <option key={m.key} value={m.key}>{m.side === "def" ? "DEF · " : ""}{m.label}</option>)}</select></Field>
                    <Field label="Y"><select className="input" value={ay} onChange={(e) => setSy(e.target.value)}>{axisMetrics.map((m) => <option key={m.key} value={m.key}>{m.side === "def" ? "DEF · " : ""}{m.label}</option>)}</select></Field>
                  </div>
                </div>
                {(() => { const mx = axisMetrics.find((m) => m.key === ax), my = axisMetrics.find((m) => m.key === ay); const dots = prof.seasons.filter((s) => answersFor(s.held, mx?.side ?? "off") && answersFor(s.held, my?.side ?? "off")).map((s) => ({ id: `${s.season}-${s.team}`, label: `${s.season} ${s.team}`, x: s[ax] as number | null, y: s[ay] as number | null, sub: `${s.win}-${s.loss}`, extra: { [`${mx?.label ?? ax} rank`]: shownRank(s[`${ax}_rank`] as number | null, s.n_teams, mx?.good), [`${my?.label ?? ay} rank`]: shownRank(s[`${ay}_rank`] as number | null, s.n_teams, my?.good) } })); return <ScatterPlot dots={dots} xLabel={mx?.label ?? ax} yLabel={my?.label ?? ay} xFmt={(v) => fmtS(v, (mx?.fmt ?? "dec1") as any)} yFmt={(v) => fmtS(v, (my?.fmt ?? "dec1") as any)} quadrants={describeQuadrants(ax, ay, mx?.label ?? ax, my?.label ?? ay)} xEnds={axisEnds(ax, mx?.label ?? ax)} yEnds={axisEnds(ay, my?.label ?? ay)} showLabels="all" height={420} />; })()}
                <div className="hint">Each dot is one of his seasons; the dashed lines are his own career averages, so the corner notes read relative to his norm, not the league's. A tight cluster is an identity, a drift is a coach who changed.</div>
              </div>
              <div className="panel">
                <div className="panel-head"><h3>Season by season · {side === "off" ? "offense" : "defense"}{mixed ? ` · ${seasonsThisSide.length} of ${prof.seasons.length} seasons answer for it` : ""}</h3><span className="hint">shaded by league percentile: {PCT_LEGEND} · <span className="scroll-hint">scroll sideways for all {metrics.length} metrics</span></span></div>
                <div className="tbl-wrap">
                  <table className="tbl wide">
                    <thead><tr><th className="left">Season</th><th className="left">Team</th>{mixed && <th className="left">Job</th>}<th>W-L</th><th>PPG</th>{metrics.map((m) => <th key={m.key} title={m.note || undefined}>{m.label}</th>)}</tr></thead>
                    <tbody>{seasonsThisSide.slice().reverse().map((s) => (
                      <tr key={`${s.season}-${s.team}`}><td className="left">{s.season}</td><td className="left"><TeamTag abbr={s.team} /></td>
                        {mixed && <td className="left"><span className={`chip tiny ${s.held === role ? "" : "on"}`}>{s.held}</span></td>}
                        <td className="num muted">{s.win}-{s.loss}</td><td className="num muted">{fmtStat(s.ppg, "dec1")}</td>
                        {metrics.map((m) => { const v = s[m.key] as number | null; const r = s[`${m.key}_rank`] as number | null; return <td key={m.key} className="num" style={{ background: rankTint(r, s.n_teams, m.good) }} title={r ? `rank ${shownRank(r, s.n_teams, m.good)} of ${s.n_teams}` : ""}>{v === null || v === undefined ? "–" : <>{fmtStat(v, m.fmt as any)} <span className="faint tiny">{shownRank(r, s.n_teams, m.good)}</span></>}</td>; })}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
