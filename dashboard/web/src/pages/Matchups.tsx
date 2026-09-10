import { useEffect, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, api4, Angle, DefPlayer, GameMatchup, MatchupSideFull, ScheduleGame, TeamMetric } from "../api";
import { Banner, Field, Headshot, SampleBanner, Spinner, TeamTag } from "../components/common";
import { fmtLine, fmtOdds, fmtPct, fmtSpread, fmtStat } from "../lib/format";
import { warm } from "../lib/prefetch";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import { rankTint, shownRank } from "../lib/rank";

const OFF_KEYS = ["pass_rate", "proe", "neutral_pass_rate", "plays_pg", "sec_per_play", "third_down_conv", "shotgun_rate", "under_center_rate", "p11_rate", "p12_rate", "pa_rate", "motion_rate", "screen_rate", "deep_rate", "adot", "rb_target_share", "wr_target_share", "te_target_share", "lead_rb_share", "qb_rush_rate", "rz_td_rate", "rz_pass_rate", "rz_te_target_share", "rz_rb_target_share", "fourth_go_rate", "fga_pg", "sack_rate_taken", "int_rate", "epa_play", "explosive_rate"];
const DEF_KEYS = ["def_epa_play", "def_pass_epa", "def_rush_epa", "def_success_rate", "def_explosive_rate", "def_pass_rate_faced", "def_third_down_conv", "def_sack_rate", "def_int_rate", "def_pressure_rate", "def_blitz_rate", "def_man_rate", "def_cover1_rate", "def_cover3_rate", "def_two_high_rate", "def_cover0_rate", "def_box_avg", "def_adot_faced", "def_deep_rate_faced", "def_rb_target_share", "def_te_target_share", "def_rz_td_rate", "def_fga_pg"];
const leanClass = (l: Angle["lean"]) => (l === "over" ? "over" : l === "under" ? "under" : "muted");

export default function Matchups() {
  const { meta, settings } = useMeta();
  const [sp, setSp] = useSearchParams();
  const gameId = sp.get("game") ?? "";
  const [week, setWeek] = useSticky<number | null>("matchups.week", null);
  const { data: schedule } = useQuery<ScheduleGame[]>(meta ? api.schedule.url(meta.season, week ?? meta.week) : null);
  const games = schedule ?? [];
  const shown = week ?? meta?.week ?? null;
  // Warming this week's slate here as well as at startup, so switching back to
  // the live week loads its games rather than only the one that gets clicked.
  // Earlier weeks are left alone: those games are played and settled, nobody is
  // betting them, and warming sixteen of them is sixteen requests that push the
  // one game the user actually opened to the back of the queue.
  useEffect(() => {
    if (schedule && meta && shown === meta.week) warm(schedule.map((g) => api4.gameMatchup.url(g.game_id, settings.includeSample)));
  }, [schedule, meta, shown, settings.includeSample]);
  const { data, loading, error: err } = useQuery<GameMatchup>(gameId ? api4.gameMatchup.url(gameId, settings.includeSample) : null);
  const weeks = Array.from({ length: 22 }, (_, i) => i + 1);
  if (meta && !meta.team_table_ready) return <Banner kind="warn">The team tendency table is not built yet. Run <code>python -m dashboard.stats.team</code> and reload.</Banner>;
  return (
    <div>
      <div className="page-head"><div><h1>Matchups</h1><div className="muted small">One game, both sides: each offense's scheme against the other defense's, the angles where two tendencies collide, who plays and who covers, every past meeting, and the props posted for it.</div></div></div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="controls">
          <Field label="Week"><select className="input" value={week ?? meta?.week ?? 1} onChange={(e) => setWeek(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select></Field>
          <Field label="Game">
            <div className="chips">
              {games.map((g) => <button key={g.game_id} className={`chip ${g.game_id === gameId ? "on" : ""}`} onClick={() => setSp({ game: g.game_id })}>{g.away_team} @ {g.home_team}<span className="faint tiny"> {g.gameday.slice(5)}</span></button>)}
            </div>
          </Field>
        </div>
      </div>
      {err && <Banner kind="err">{err}</Banner>}
      {loading && <div className="empty"><Spinner /></div>}
      {!gameId && !loading && <div className="empty">Pick a game.</div>}
      {data && <GameView d={data} />}
    </div>
  );
}

function GameView({ d }: { d: GameMatchup }) {
  const { meta } = useMeta();
  const nav = useNavigate();
  const g = d.game;
  const pred = d.predictions[0];
  const dk = d.lines.filter((l) => l.book === "draftkings");
  const line = (market: string, side: string) => dk.find((l) => l.market === market && l.side === side);
  const hs = line("spreads", g.home_team), tot = line("totals", "Over"), hm = line("h2h", g.home_team), am = line("h2h", g.away_team);
  return (
    <div className="grid" style={{ gap: 14 }}>
      <SampleBanner sources={d.sources} />
      <div className="panel" data-tour="matchup-top">
        <div className="panel-head">
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 16 }}><TeamTag abbr={g.away_team} name /> <span className="muted">at</span> <TeamTag abbr={g.home_team} name /></div>
          <div className="small muted">{d.venue.gameday} {d.venue.gametime} · {d.venue.stadium} · {d.venue.roof}, {d.venue.surface}{d.venue.temp ? ` · ${d.venue.temp}°F` : ""}{d.venue.wind ? `, wind ${d.venue.wind}` : ""}{g.div_game ? " · division game" : ""}</div>
        </div>
        <div className="tiles">
          <div className="tile"><div className="k">{g.home_team} spread</div><div className="v">{fmtSpread(hs ? hs.line : g.spread_line === null ? null : -g.spread_line)}</div><div className="s">{hs ? `DraftKings ${fmtOdds(hs.price)}${hs.open_line !== null ? `, opened ${fmtSpread(hs.open_line)}` : ""}` : "nflverse reference"}</div></div>
          <div className="tile"><div className="k">Total</div><div className="v">{fmtLine(tot ? tot.line : g.total_line)}</div><div className="s">{tot ? `over ${fmtOdds(tot.price)}` : "nflverse reference"}</div></div>
          <div className="tile"><div className="k">Moneyline</div><div className="v" style={{ fontSize: 16 }}>{g.home_team} {fmtOdds(hm ? hm.price : g.home_moneyline)} · {g.away_team} {fmtOdds(am ? am.price : g.away_moneyline)}</div><div className="s">{hm?.open_price !== null && hm ? `opened ${fmtOdds(hm.open_price)} / ${fmtOdds(am?.open_price)}` : ""}</div></div>
          <div className="tile"><div className="k">Implied totals</div><div className="v" style={{ fontSize: 16 }}>{implied(g, hs?.line ?? (g.spread_line === null ? null : -g.spread_line), tot?.line ?? g.total_line)}</div><div className="s">from spread and total</div></div>
          <div className="tile"><div className="k">Model · {pred?.model_version ?? "none"}</div><div className="v" style={{ fontSize: 16 }}>{pred ? `${pred.pred_margin >= 0 ? g.home_team : g.away_team} by ${Math.abs(pred.pred_margin).toFixed(1)}` : "–"}</div><div className="s">{pred ? `${g.home_team} win prob ${fmtPct(pred.pred_win_prob)} · edge ${pred.market_spread === null ? "–" : (pred.pred_margin - pred.market_spread).toFixed(1)}` : "nothing logged"}</div></div>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>Tendencies below use {d.season_used} regular-season numbers{d.season_used < g.season ? " (this season has too few games yet)" : ""}. Ranks are among 32 teams.</div>
      </div>

      <div className="grid" style={{ gap: 14 }} data-tour="matchup-sides">
        {d.sides.map((s) => <SideView key={s.offense} s={s} metrics={d.metrics} labels={d.dvp_labels} />)}
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <div className="panel-head"><h3>Props posted for this game</h3><span className="hint">{d.props.length} lines · click to research</span></div>
          {d.props.length === 0 && <div className="hint">None pulled yet. Settings → Pull from ESPN.</div>}
          {d.props.length > 0 && (
            <div className="tbl-wrap" style={{ maxHeight: 520 }}><table className="tbl compact tight">
              <thead><tr><th className="left">Player</th><th className="left">Market</th><th>Line</th><th>L5</th><th>L10</th><th>Szn</th><th>Avg−line</th><th>Move</th></tr></thead>
              <tbody>{[...d.props].sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || a.player_name.localeCompare(b.player_name)).map((r) => (
                <tr key={r.market + r.player_name} className="clickable" onClick={() => r.player_id && nav(`/research?player=${r.player_id}&market=${r.market}`)}>
                  <td className="left"><b>{r.team}</b> {r.player_name} <span className="muted">{r.position}</span></td><td className="left">{r.market_label}</td>
                  <td className="num"><b>{r.kind === "ou" ? fmtLine(r.consensus) : fmtPct(r.consensus)}</b></td>
                  <td className="num">{rate(r.form?.l5?.rate)}</td><td className="num">{rate(r.form?.l10?.rate)}</td><td className="num">{rate(r.form?.season?.rate)}</td>
                  <td className={`num ${r.form && r.kind === "ou" ? (r.form.avg - r.consensus > 0 ? "over" : "under") : "muted"}`}>{r.form && r.kind === "ou" ? (r.form.avg - r.consensus > 0 ? "+" : "") + (r.form.avg - r.consensus).toFixed(1) : "–"}</td>
                  <td className="num muted">{r.books[0]?.moved ? (r.books[0].moved > 0 ? "+" : "") + r.books[0].moved : "–"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="panel">
          <div className="panel-head"><h3>Head to head · {d.history.length} meetings since 1999</h3><span className="hint">spread and total from {d.history[0]?.a}'s side</span></div>
          {d.history.length === 0 && <div className="hint">No previous meetings in the cache.</div>}
          {d.history.length > 0 && (
            <>
              <div className="small" style={{ marginBottom: 6 }}>
                {(() => { const a = d.history[0].a; const w = d.history.filter((h) => h.margin > 0).length; const cov = d.history.filter((h) => h.a_cover === true).length; const covN = d.history.filter((h) => h.a_cover !== null).length; const ov = d.history.filter((h) => h.over === true).length; const ovN = d.history.filter((h) => h.over !== null).length; const avgT = d.history.reduce((x, h) => x + h.total, 0) / d.history.length;
                  return <>{a} {w}-{d.history.length - w} straight up · {cov}-{covN - cov} against the spread · overs {ov}-{ovN - ov} · avg total <b className="num">{avgT.toFixed(1)}</b></>; })()}
              </div>
              <div className="tbl-wrap" style={{ maxHeight: 520 }}><table className="tbl compact tight">
                <thead><tr><th className="left">Game</th><th>Score</th><th>Spread</th><th>ATS</th><th>Total</th><th>O/U</th><th className="left">Top performers</th></tr></thead>
                <tbody>{d.history.map((h) => (
                  <tr key={h.game_id}>
                    <td className="left">{h.season} {h.game_type === "REG" ? `W${h.week}` : h.game_type} <span className="muted">{h.a_home ? "vs" : "@"} {h.b}</span><div className="faint tiny">{h.a_qb ?? ""} v {h.b_qb ?? ""}</div></td>
                    <td className={`num ${h.margin > 0 ? "over" : h.margin < 0 ? "under" : ""}`}>{h.a_pts}-{h.b_pts}</td>
                    <td className="num muted">{fmtSpread(h.a_spread)}</td>
                    <td className={`num ${h.a_cover === true ? "over" : h.a_cover === false ? "under" : "muted"}`}>{h.a_cover === null ? "push" : h.a_cover ? "cover" : "miss"}</td>
                    <td className="num muted">{h.total} <span className="faint">/ {fmtLine(h.total_line)}</span></td>
                    <td className={`num ${h.over === true ? "over" : h.over === false ? "under" : "muted"}`}>{h.over === null ? "–" : h.over ? "over" : "under"}</td>
                    <td className="left small wrap">{h.stars.slice(0, 3).map((st) => <div key={st.player_id}><Link to={`/research?player=${st.player_id}`}>{st.name}</Link> <span className="muted">{st.team}: {st.line}</span></div>)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Injury reports · week {g.week}</h3></div>
        <div className="grid grid-2">
          {[g.away_team, g.home_team].map((t) => { const rows = (d.injuries[t] ?? []).filter((r) => (r.report_status && r.report_status !== "Note") || r.practice_status); return (
            <div key={t}><div className="small" style={{ marginBottom: 4 }}><TeamTag abbr={t} /> {rows.length === 0 && <span className="hint">nothing filed yet for this week</span>}</div>
              <div className="chips">{rows.map((r, i) => <span key={i} className="chip" title={`${r.report_primary_injury ?? ""} · ${r.practice_status ?? ""}`}><span className={r.report_status === "Out" || r.report_status === "Doubtful" ? "under" : "push"}>{r.report_status ?? (r.practice_status?.startsWith("Did Not") ? "DNP" : r.practice_status?.startsWith("Limited") ? "Limited" : "Full")}</span> {r.full_name} <span className="muted">{r.position}</span></span>)}</div></div>
          ); })}
        </div>
      </div>
      <div className="hint">{meta ? "" : ""}Coverage assignments (who shadows whom) are not published in any nflverse table. The defensive personnel above shows who is on the field and how they have fared when targeted; pair it with the receivers' man-vs-zone and coverage splits on their research pages.</div>
    </div>
  );
}

function implied(g: ScheduleGame, homeSpread: number | null, total: number | null): string {
  if (homeSpread === null || total === null) return "–";
  const home = (total - homeSpread) / 2, away = total - home;
  return `${g.home_team} ${home.toFixed(1)} · ${g.away_team} ${away.toFixed(1)}`;
}
function AngleGrid({ title, angles, empty }: { title: string; angles: Angle[]; empty: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h3 style={{ marginBottom: 6 }}>{title} <span className="faint">· {angles.length}</span></h3>
      {angles.length === 0 && <div className="hint">{empty}</div>}
      {angles.length > 0 && (
        <div className="grid grid-3">
          {angles.map((a, i) => (
            <div key={i} className="tile" style={{ borderLeft: `3px solid var(--${a.lean === "over" ? "over" : a.lean === "under" ? "under" : "border-2"})` }}>
              <div className="k"><span className={leanClass(a.lean)}>{a.lean === "neutral" ? "check" : `lean ${a.lean}`}</span> · {a.tags.join(", ")}{a.strength >= 2 ? " · strong" : ""}</div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{a.player_id ? <Link to={`/research?player=${a.player_id}`}>{a.title}</Link> : a.title}</div>
              <div className="small muted" style={{ marginTop: 2 }}>{a.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const rate = (r: number | null | undefined) => r === null || r === undefined ? <span className="muted">–</span> : <span className={r >= 0.6 ? "over" : r <= 0.4 ? "under" : ""}>{fmtPct(r)}</span>;

function SideView({ s, metrics, labels }: { s: MatchupSideFull; metrics: TeamMetric[]; labels: Record<string, string> }) {
  const mdefs = useMemo(() => new Map(metrics.map((m) => [m.key, m])), [metrics]);
  const os = s.offense_block.season, ds = s.defense_block.season;
  const Row = ({ k, block }: { k: string; block: MatchupSideFull["offense_block"] }) => {
    const m = mdefs.get(k); const row = block.season; if (!m || !row) return null;
    const v = row[k] as number | null; const r = row[`${k}_rank`] as number | null; const l4 = block.last4?.[k] ?? null;
    if (v === null || v === undefined) return null;
    return <tr><td className="left" title={m.note || undefined}>{m.label}</td><td className="num">{fmtStat(v, m.fmt as any)}</td><td className="num" style={{ background: rankTint(r, row.n_teams, m.good) }}>{shownRank(r, row.n_teams, m.good)}</td><td className="num muted">{fmtStat(l4, m.fmt as any)}</td></tr>;
  };
  const groups: Record<string, DefPlayer[]> = { CB: [], S: [], LB: [], DL: [] };
  for (const p of s.defense_personnel) groups[p.group]?.push(p);
  return (
    <div className="panel">
      <div className="panel-head">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}><TeamTag abbr={s.offense} /> <b>offense</b> <span className="muted">vs</span> <TeamTag abbr={s.defense} /> <b>defense</b></div>
        <span className="hint">{s.offense_block.coach ? <Link to={`/coaches?coach=${encodeURIComponent(s.offense_block.coach)}`}>{s.offense_block.coach}</Link> : null} · {s.defense_block.coach ? <Link to={`/coaches?coach=${encodeURIComponent(s.defense_block.coach)}`}>{s.defense_block.coach}</Link> : null}</span>
      </div>
      <AngleGrid title="Team angles" angles={s.angles} empty="No strong collisions between ranked tendencies on this side." />
      <AngleGrid title="Player angles · each key player's own splits against what this defense does most" angles={s.player_angles} empty="No key player has a split that lines up with a strong tendency of this defense." />
      <div className="grid grid-3">
        <div>
          <h3 style={{ marginBottom: 6 }}>{s.offense} offense · {os?.season}</h3>
          <div className="tbl-wrap"><table className="tbl compact"><thead><tr><th className="left">Tendency</th><th>Value</th><th>Rk</th><th>L4</th></tr></thead><tbody>{OFF_KEYS.map((k) => <Row key={k} k={k} block={s.offense_block} />)}</tbody></table></div>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>{s.defense} defense · {ds?.season}</h3>
          <div className="tbl-wrap"><table className="tbl compact"><thead><tr><th className="left">Tendency</th><th>Value</th><th>Rk</th><th>L4</th></tr></thead><tbody>{DEF_KEYS.map((k) => <Row key={k} k={k} block={s.defense_block} />)}</tbody></table></div>
          <h3 style={{ margin: "10px 0 6px" }}>{s.defense} allows per game</h3>
          <div className="tbl-wrap"><table className="tbl compact"><thead><tr><th className="left">To</th>{["QB", "RB", "WR", "TE"].map((p) => <th key={p}>{p}</th>)}</tr></thead>
            <tbody>{["passing_yards", "rushing_yards", "receptions", "receiving_yards", "fantasy_points_ppr"].map((k) => (
              <tr key={k}><td className="left">{labels[k]}</td>{["QB", "RB", "WR", "TE"].map((p) => { const row = s.dvp[p]?.season_row; const v = row?.[k] as number | undefined; const r = row?.[`${k}_rank`] as number | undefined; const n = (row?.n_teams as number) ?? 32; const show = v !== undefined && v !== null && (s.dvp[p].stats.includes(k)); return <td key={p} className="num" style={{ background: show ? rankTint(r, n) : undefined }}>{show ? <>{v!.toFixed(1)} <span className="faint tiny">{shownRank(r, n, "low")}</span></> : <span className="faint">–</span>}</td>; })}</tr>
            ))}</tbody></table></div>
          <div className="hint">rank 1 = fewest allowed; green = generous to that position, red = stingy</div>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Who gets the ball · {s.offense}</h3>
          <div className="tbl-wrap"><table className="tbl compact tight"><thead><tr><th className="left">Player</th><th>G</th><th>Tgt%</th><th>Car%</th><th>Tch/g</th><th>PPR/g</th></tr></thead>
            <tbody>{s.offense_personnel.map((p) => <tr key={p.player_id}><td className="left"><Link to={`/research?player=${p.player_id}`}>{p.player_display_name}</Link> <span className="muted">{p.position}{p.depth_rank ? p.depth_rank : ""}</span>{p.new_to_team && p.stats_team ? <span className="pill warn" title={`New to ${s.offense}. The numbers here are his ${os?.season} season with ${p.stats_team}.`}>{p.stats_team}</span> : null}{!p.stats_team && p.games === 0 ? <span className="pill" title="No prior season on record">rookie</span> : null}</td><td className="num muted">{p.games}</td><td className="num">{p.position === "QB" ? "–" : fmtPct(p.target_share)}</td><td className="num">{p.position === "RB" || p.position === "QB" ? fmtPct(p.carry_share) : "–"}</td><td className="num">{(p.touches_pg ?? 0).toFixed(1)}</td><td className="num">{(p.ppr_pg ?? 0).toFixed(1)}</td></tr>)}</tbody></table></div>
          <h3 style={{ margin: "10px 0 6px" }}>Who covers · {s.defense}</h3>
          <div className="tbl-wrap"><table className="tbl compact tight"><thead><tr><th className="left">Defender</th><th>Snap%</th><th>Tgt/g</th><th>Y/tgt</th><th>Catch%</th><th>TD</th><th>Prs</th></tr></thead>
            <tbody>{(["CB", "S", "LB", "DL"] as const).flatMap((grp) => groups[grp].slice(0, grp === "DL" ? 4 : grp === "LB" ? 3 : 4).map((p) => (
              <tr key={p.name + p.position}><td className="left">{p.player_id ? <Link to={`/research?player=${p.player_id}`}>{p.name}</Link> : p.name} <span className="muted">{p.position}</span></td><td className="num">{fmtPct(p.snap_pct)}</td><td className="num">{p.group === "DL" || p.targets_pg === null ? "–" : p.targets_pg.toFixed(1)}</td><td className={`num ${p.group !== "DL" && p.yards_per_target !== null && p.targets >= 20 ? (p.yards_per_target >= 9 ? "under" : p.yards_per_target <= 6 ? "over" : "") : ""}`}>{p.group === "DL" || p.yards_per_target === null ? "–" : p.yards_per_target.toFixed(1)}</td><td className="num">{p.group === "DL" ? "–" : fmtPct(p.catch_rate)}</td><td className="num">{p.group === "DL" ? "–" : p.td_allowed ?? "–"}</td><td className="num muted">{p.pressures ?? "–"}</td></tr>
            )))}</tbody></table></div>
          <div className="hint">Coverage stats from PFR (targets when nearest defender). Red yards-per-target = a defender receivers have beaten; green = one they have not.</div>
        </div>
      </div>
    </div>
  );
}
