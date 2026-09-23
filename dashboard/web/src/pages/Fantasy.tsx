import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFantasy, FantasyPlayer, FantasyWeek } from "../api";
import { ApplyField, Banner, Field, FilterFold, Seg, Spinner, TeamTag } from "../components/common";
import { fmtPct } from "../lib/format";
import { FANTASY_KEY, Scoring, SCORING_LABEL, useLens } from "../lib/profile";
import { rankTint } from "../lib/rank";
import StartSit from "../components/StartSit";
import { DEFAULT_SLOTS, RosterEntry, Slots, toEntry } from "../components/MyRoster";
import MyTeam from "../components/MyTeam";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import { useMobile } from "../lib/useMobile";

// The week in fantasy terms: every skill player on a team that plays, ranked
// by what the baseline projects, next to the matchup and the role behind it.
// Everything here is read from /api/fantasy/week, which projects all three
// scoring formats at once, so switching format is a re-sort, not a request.

type Pos = "ALL" | "ROSTER" | "MINE" | "QB" | "RB" | "WR" | "TE";
type SortKey = "proj" | "low" | "high" | "last3" | "implied" | "matchup";
const OUT = ["Out", "Doubtful", "IR"];

// A bare date parses as UTC midnight, which is the evening before across the
// US; noon keeps it on its own day.
const dayOf = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }) : "");

const statusPill = (p: FantasyPlayer) =>
  p.status ? <span className={`pill ${OUT.includes(p.status) ? "under" : "warn"}`} title={p.injury ?? undefined}>{p.status}</span> : null;

/** How much a role moved: the last three games against the dozen before. */
function roleChange(p: FantasyPlayer): number | null {
  if (!p.role || p.role.before < 3) return null;
  return (p.role.last3 - p.role.before) / p.role.before;
}

export default function Fantasy() {
  const { meta, settings } = useMeta();
  const nav = useNavigate();
  const profile = settings.profile;
  const [week, setWeek] = useSticky<number | null>("fantasy.week", null);
  // The scoring the profile names wins; without one the page keeps its own.
  const [ownScoring, setOwnScoring] = useSticky<Scoring>("fantasy.scoring", "ppr");
  const scoring: Scoring = profile?.purposes.includes("fantasy") ? profile.scoring : ownScoring;
  // The positions from the tailoring answers, as one filter: "Yours".
  const mine = (profile?.positions ?? []).filter((x): x is "QB" | "RB" | "WR" | "TE" => x !== "K");
  const [picked, setPos] = useSticky<Pos>("fantasy.pos", mine.length > 1 ? "MINE" : mine.length === 1 ? mine[0] : "ALL");
  const pos: Pos = picked === "MINE" && mine.length < 2 ? "ALL" : picked;
  const [team, setTeam] = useState<string>("");
  const [q, setQ] = useState("");
  const [hideOut, setHideOut] = useSticky("fantasy.hideOut", true);
  const [starters, setStarters] = useSticky("fantasy.starters", true);
  // Best ball and DFS play for the big week, so they rank by ceiling.
  const lens = useLens();
  const [sort, setSort] = useState<{ k: SortKey; d: 1 | -1 }>({ k: lens.ceiling ? "high" : "proj", d: -1 });
  const setsLineups = !profile || !profile.purposes.includes("fantasy") || (lens.profile?.fantasyFormat ?? "season") === "season";
  // On a phone the player (with the start / sit button) is the pinned first
  // column and the projection comes straight after it, so the number the page
  // is ranked by is on screen without a sideways swipe.
  const mobile = useMobile();
  // The week's list, or the roster someone has told us about. Only offered
  // where a lineup is set each week; best ball and daily fantasy have none.
  const [view, setView] = useSticky<"week" | "team">("fantasy.view", "week");
  // Players picked for start/sit. Kept across weeks and visits: the same
  // decision tends to come back every week.
  const [compare, setCompare] = useSticky<string[]>("fantasy.compare", []);
  // The roster lives in this browser, like the tailoring answers.
  const [roster, setRoster] = useSticky<RosterEntry[]>("fantasy.roster", []);
  const [slots, setSlots] = useSticky<Slots>("fantasy.slots", DEFAULT_SLOTS);
  const onRoster = useMemo(() => new Set(roster.map((r) => r.player_id)), [roster]);
  const star = (p: FantasyPlayer) => setRoster((r) => (onRoster.has(p.player_id) ? r.filter((x) => x.player_id !== p.player_id) : [...r, toEntry(p)]));
  const starBtn = (p: FantasyPlayer) => (
    <button className={`star-btn ${onRoster.has(p.player_id) ? "on" : ""}`} title={onRoster.has(p.player_id) ? "Take off my roster" : "Add to my roster"} onClick={(e) => { e.stopPropagation(); star(p); }}>{onRoster.has(p.player_id) ? "★" : "☆"}</button>
  );
  const toggle = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? c : [...c, id]));

  const shown = week ?? meta?.week ?? null;
  const { data, loading, error } = useQuery<FantasyWeek>(meta && shown ? apiFantasy.fantasyWeek.url(meta.season, shown) : null);
  const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
  const fav = profile?.team ?? null;

  const val = (p: FantasyPlayer, k: SortKey): number | null => {
    const pr = p.proj[scoring];
    if (k === "implied") return p.implied;
    if (k === "matchup") return p.matchup_rank === null ? null : -p.matchup_rank;   // easiest first when descending
    return pr ? pr[k === "proj" ? "value" : k] : null;
  };

  const rows = useMemo(() => {
    let r = data?.players ?? [];
    if (pos === "ROSTER") r = r.filter((p) => onRoster.has(p.player_id));
    else if (pos === "MINE") r = r.filter((p) => (mine as string[]).includes(p.position));
    else if (pos !== "ALL") r = r.filter((p) => p.position === pos);
    if (team) r = r.filter((p) => p.team === team || p.opponent === team);
    if (q.trim()) { const s = q.trim().toLowerCase(); r = r.filter((p) => p.name.toLowerCase().includes(s)); }
    if (hideOut) r = r.filter((p) => !p.status || !OUT.includes(p.status));
    // A team's QB1, top two backs, top three receivers and TE1: the players a
    // lineup is actually built from. The rest are one click away.
    if (starters && pos !== "ROSTER") r = r.filter((p) => p.depth_rank === null || p.depth_rank <= ({ QB: 1, RB: 2, WR: 3, TE: 1 }[p.position] ?? 1));
    return [...r].sort((a, b) => {
      const x = val(a, sort.k), y = val(b, sort.k);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x - y) * sort.d;
    });
  }, [data, pos, team, q, hideOut, starters, sort, scoring, onRoster]);

  // Position ranks by projection, over everyone who plays, so filtering the
  // table never renumbers a player.
  const posRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of ["QB", "RB", "WR", "TE"]) {
      (data?.players ?? []).filter((x) => x.position === p && x.proj[scoring]).sort((a, b) => b.proj[scoring]!.value - a.proj[scoring]!.value)
        .forEach((x, i) => m.set(x.player_id, i + 1));
    }
    return m;
  }, [data, scoring]);

  const risers = useMemo(() => (data?.players ?? []).filter((p) => (roleChange(p) ?? 0) >= 0.3 && (p.role?.last3 ?? 0) >= 5 && p.position !== "QB")
    .sort((a, b) => (roleChange(b) ?? 0) - (roleChange(a) ?? 0)).slice(0, 6), [data]);
  const fallers = useMemo(() => (data?.players ?? []).filter((p) => (roleChange(p) ?? 0) <= -0.3 && (p.role?.before ?? 0) >= 6 && p.position !== "QB")
    .sort((a, b) => (roleChange(a) ?? 0) - (roleChange(b) ?? 0)).slice(0, 6), [data]);
  const shootouts = useMemo(() => [...(data?.games ?? [])].filter((g) => g.total !== null).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 5), [data]);
  const byId = useMemo(() => new Map((data?.players ?? []).map((p) => [p.player_id, p])), [data]);
  const comparing = compare.map((id) => byId.get(id)).filter((p): p is FantasyPlayer => !!p);
  const missing = data ? compare.filter((id) => !byId.has(id)) : [];
  const teams = useMemo(() => [...new Set((data?.players ?? []).map((p) => p.team))].sort(), [data]);

  const th = (k: SortKey, label: string, title?: string) => (
    <th className={`clickable ${sort.k === k ? "over" : ""}`} title={title} onClick={() => setSort((s) => (s.k === k ? { k, d: (s.d * -1) as 1 | -1 } : { k, d: -1 }))}>{label}{sort.k === k ? (sort.d === -1 ? " ▾" : " ▴") : ""}</th>
  );
  const cmp = (p: FantasyPlayer) => (
    <button className={`cmp-btn ${compare.includes(p.player_id) ? "on" : ""}`} disabled={!compare.includes(p.player_id) && compare.length >= 4}
      title={compare.includes(p.player_id) ? "Take out of start / sit" : compare.length >= 4 ? "Four is the limit" : "Add to start / sit"}
      onClick={(e) => { e.stopPropagation(); toggle(p.player_id); }}>{compare.includes(p.player_id) ? "✓" : "+"}</button>
  );
  const proj = (pr: FantasyPlayer["proj"][Scoring]) => <>
    <td className="num"><b>{pr ? pr.value.toFixed(1) : "–"}</b></td>
    <td className="num muted">{pr ? pr.low.toFixed(1) : "–"}</td>
    <td className="num muted">{pr ? pr.high.toFixed(1) : "–"}</td>
  </>;
  const open = (p: FantasyPlayer) => nav(`/research?player=${p.player_id}&stat=${FANTASY_KEY[scoring]}`);
  const who = (p: FantasyPlayer) => <><Link to={`/research?player=${p.player_id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link> <span className="muted">{p.position} {p.team}</span></>;

  const weekField = <ApplyField label="Week" value={shown ?? 1} onApply={setWeek} show={(v) => `week ${v}`}>{(d, set) => <select className="input" value={d} onChange={(e) => set(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select>}</ApplyField>;
  const scoringField = profile?.purposes.includes("fantasy")
            ? <Field label="Scoring"><span className="hint" style={{ lineHeight: "28px" }}>{SCORING_LABEL[scoring]} (from your answers)</span></Field>
            : <Field label="Scoring"><Seg value={ownScoring} options={[{ v: "ppr", l: "PPR" }, { v: "half", l: "Half" }, { v: "std", l: "Std" }]} onChange={setOwnScoring} /></Field>;
  const teamView = setsLineups && view === "team";

  return (
    <div>
      <div className="page-head">
        <div><h1>Fantasy{shown ? ` · week ${shown}` : ""}</h1><div className="muted small">Every starter on a team that plays this week, ranked by {lens.ceiling ? "ceiling (the big week your format pays for)" : "projected"} {SCORING_LABEL[scoring]} points, next to the matchup and the role behind the number.</div></div>
      </div>

      {setsLineups && <div className="view-switch" role="tablist">
        <button role="tab" aria-selected={!teamView} className={!teamView ? "on" : ""} onClick={() => setView("week")}>This week</button>
        <button role="tab" aria-selected={teamView} className={teamView ? "on" : ""} onClick={() => setView("team")}>My team{roster.length ? <span className="count">{roster.length}</span> : null}</button>
      </div>}

      {teamView ? <>
        <div className="panel" style={{ marginBottom: 12 }}><FilterFold id="fantasy-team" summary={`Week ${shown ?? ""} · ${SCORING_LABEL[scoring]}`}><div className="controls">{weekField}{scoringField}</div></FilterFold></div>
        {error && <Banner kind="err">{error}</Banner>}
        <MyTeam data={data ?? null} scoring={scoring} loading={loading} roster={roster} setRoster={setRoster} slots={slots} setSlots={setSlots} />
      </> : <>
      <div className="panel" style={{ marginBottom: 12 }}>
        <FilterFold id="fantasy" active={(pos !== "ALL" ? 1 : 0) + (team ? 1 : 0) + (q.trim() ? 1 : 0)}
          summary={`Week ${shown ?? ""} · ${pos === "ALL" ? "all positions" : pos === "MINE" ? "your positions" : pos} · ${SCORING_LABEL[scoring]}`}>
        <div className="controls">
          {weekField}
          <Field label="Position"><Seg value={pos} options={[{ v: "ALL", l: "All" }, ...(roster.length ? [{ v: "ROSTER" as Pos, l: `My roster (${roster.length})` }] : []), ...(mine.length > 1 ? [{ v: "MINE" as Pos, l: `Yours (${mine.join(", ")})` }] : []), { v: "QB", l: "QB" }, { v: "RB", l: "RB" }, { v: "WR", l: "WR" }, { v: "TE", l: "TE" }]} onChange={setPos} /></Field>
          {scoringField}
          <Field label="Team"><select className="input" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All</option>{fav && <option value={fav}>{fav} (favorite)</option>}{teams.filter((t) => t !== fav).map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          <Field label="Player"><input className="input" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Show"><div className="chips">
            <button className={`chip ${starters ? "on" : ""}`} title="QB1, RB1-2, WR1-3 and TE1 on each depth chart" onClick={() => setStarters(!starters)}>starters only</button>
            <button className={`chip ${hideOut ? "on" : ""}`} title="Leave out players listed Out or Doubtful" onClick={() => setHideOut(!hideOut)}>hide out / doubtful</button>
          </div></Field>
        </div>
        </FilterFold>
      </div>

      {error && <Banner kind="err">{error}</Banner>}
      {loading && !data && <div className="empty"><Spinner /> projecting the week…</div>}
      {data && data.injury_week !== null && data.injury_week < data.week && (
        <Banner kind="info">Week {data.week} injury reports are not filed yet (they come out Wednesday to Friday), so nobody below is marked hurt. Check back before kickoff.</Banner>
      )}


      {data && compare.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <StartSit players={comparing} missing={missing} scoring={scoring} onRemove={(id) => setCompare((c) => c.filter((x) => x !== id))} onClear={() => setCompare([])} />
        </div>
      )}

      {data && (
        <div className="grid grid-3 deck" style={{ marginBottom: 14 }}>
          <div className="panel">
            <div className="panel-head"><h3>Roles growing</h3><span className="hint">targets + carries, last 3 vs before</span></div>
            {risers.length === 0 ? <div className="hint">No big jumps in role this week.</div> : risers.map((p) => (
              <div key={p.player_id} className="small fantasy-mover">{who(p)} <span className="num over">{p.role!.before.toFixed(1)} → {p.role!.last3.toFixed(1)}</span></div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Roles shrinking</h3><span className="hint">worth a look before you start them</span></div>
            {fallers.length === 0 ? <div className="hint">No big drops in role this week.</div> : fallers.map((p) => (
              <div key={p.player_id} className="small fantasy-mover">{who(p)} {statusPill(p)} <span className="num under">{p.role!.before.toFixed(1)} → {p.role!.last3.toFixed(1)}</span></div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Highest-scoring games</h3><span className="hint">by the betting total</span></div>
            {shootouts.map((g) => (
              <div key={g.game_id} className="small fantasy-mover">
                <Link to={`/matchups?game=${g.game_id}`}>{g.away_team} @ {g.home_team}</Link>
                <span className="num"><b>{g.total}</b> <span className="muted">({g.away_team} {g.away_implied ?? "–"}, {g.home_team} {g.home_implied ?? "–"})</span></span>
              </div>
            ))}
            {data.byes.length > 0 && <div className="hint" style={{ marginTop: 8 }}>On bye: {data.byes.join(", ")}</div>}
          </div>
        </div>
      )}

      {data && (
        <div className="panel" data-tour="fantasy-table">
          <div className="panel-head"><h3>{rows.length} players {loading && <Spinner />}</h3><span className="hint">+ adds a player to start / sit (up to four) · click a row for their game-by-game fantasy points</span></div>
          <div className="tbl-wrap" style={{ maxHeight: "72vh" }}>
            <table className="tbl compact tight">
              <thead><tr>
                {mobile ? <th className="left">Player</th> : <>
                  <th title="Compare in start / sit" />
                  <th title="Rank at the position by projection">Rk</th><th className="left">Player</th>
                </>}
                {mobile && <>{th("proj", "Proj")}{th("low", "Floor", "A quiet week: the bottom of the middle half of outcomes")}{th("high", "Ceiling", "A good week: the top of the middle half of outcomes")}</>}
                <th className="left">Game</th>
                {th("matchup", "Matchup", "How much this defense gives up to the position, this season blended with last. Green is generous.")}
                {th("implied", "Team pts", "Points the team is expected to score, from the betting spread and total")}
                {!mobile && <>{th("proj", "Proj")}{th("low", "Floor", "A quiet week: the bottom of the middle half of outcomes")}{th("high", "Ceiling", "A good week: the top of the middle half of outcomes")}</>}
                {th("last3", "Last 3", "Average over the last three games")}
                <th title="Targets plus carries (QB: attempts plus carries) a game, the last three against the dozen before">Role</th>
                <th title="Share of the team's targets / carries">Tgt / car</th>
              </tr></thead>
              <tbody>
                {rows.map((p) => {
                  const pr = p.proj[scoring];
                  const rc = roleChange(p);
                  return (
                    <tr key={p.player_id} className={`clickable ${fav && p.team === fav ? "fav-row" : ""} ${compare.includes(p.player_id) ? "picked-row" : ""} ${onRoster.has(p.player_id) ? "roster-row" : ""}`} onClick={() => open(p)}>
                      {!mobile && <td>{cmp(p)}</td>}
                      {!mobile && <td className="num muted">{posRank.has(p.player_id) ? `${p.position}${posRank.get(p.player_id)}` : "–"}</td>}
                      <td className="left">
                        {mobile ? <div className="fx-player">{cmp(p)}{starBtn(p)}<div className="fx-name"><b>{p.name}</b><span className="muted tiny">{posRank.has(p.player_id) ? `${p.position}${posRank.get(p.player_id)}` : p.position} · {p.team}</span></div></div>
                          : <>{starBtn(p)}<b>{p.name}</b> <span className="muted">{p.position}{p.depth_rank ?? ""}</span> </>}
                        {statusPill(p)}
                        {p.new_to_team && p.stats_team && <span className="pill warn" title={`New to ${p.team}. The numbers are from ${p.stats_team}.`}>was {p.stats_team}</span>}
                        {!pr && <span className="pill" title={`Fewer than ${data.method.min_games} games on record`}>{p.games === 0 ? "no games yet" : "small sample"}</span>}
                      </td>
                      {mobile && proj(pr)}
                      <td className="left small"><TeamTag abbr={p.team} /> <span className="muted">{p.home ? "vs" : "@"}</span> {p.opponent} <span className="faint tiny">{dayOf(p.gameday)}</span></td>
                      <td className="num" style={{ background: rankTint(p.matchup_rank, p.matchup_n) }} title={p.matchup_rank ? `${p.opponent} gives up the ${ordinal(p.matchup_rank)} most to ${p.position}s (projection ×${p.factor})` : undefined}>{p.matchup_rank ? (p.matchup_rank <= 8 ? "easy" : p.matchup_rank > (p.matchup_n ?? 32) - 8 ? "tough" : "neutral") : "–"}</td>
                      <td className="num muted">{p.implied ?? "–"}</td>
                      {!mobile && proj(pr)}
                      <td className="num">{pr ? pr.last3.toFixed(1) : "–"}</td>
                      <td className={`num ${rc === null ? "muted" : rc >= 0.2 ? "over" : rc <= -0.2 ? "under" : ""}`} title={p.role ? `${p.role.last3} a game lately, ${p.role.before} before` : undefined}>{rc === null ? "–" : rc >= 0.2 ? "▲ growing" : rc <= -0.2 ? "▼ shrinking" : "steady"}</td>
                      <td className="num muted">{p.position === "QB" ? "–" : `${fmtPct(p.target_share)} / ${fmtPct(p.carry_share)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Projection: a recency-weighted average of each player's last {data.method.n_games} games (the most recent counts most), scaled by how much this week's opponent gives up to the position, clipped to between 0.8× and 1.25×. It is a reference point, not a forecast: it knows nothing about injuries, depth-chart changes or a new role until they show up in the games. Floor and ceiling are the middle half of outcomes around it.
          </div>
        </div>
      )}
      </>}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
