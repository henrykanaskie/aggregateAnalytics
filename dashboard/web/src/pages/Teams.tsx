import { chartTheme } from "../lib/theme";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api2, LeagueTendencies, TeamMetric, TeamTendencies } from "../api";
import { Banner, Field, Seg, Spinner, TeamTag } from "../components/common";
import { fmtStat } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";
import TeamScatter from "../components/TeamScatter";
import UsageTree from "../components/UsageTree";
import { PCT_LEGEND, rankTint, shownRank } from "../lib/rank";
import DvpTable from "../components/DvpTable";

export default function Teams() {
  const { meta } = useMeta();
  const T = chartTheme();
  const [sp, setSp] = useSearchParams();
  const team = sp.get("team") ?? "";
  const [since, setSince] = useSticky("teams.since", 2012);
  const [side, setSide] = useSticky<"off" | "def">("teams.side", "off");
  const [metric, setMetric] = useSticky("teams.metric", "pass_rate");
  const [leagueSeason, setLeagueSeason] = useSticky<number | null>("teams.leagueSeason", null);
  const { data, error: teamErr } = useQuery<TeamTendencies>(team ? api2.teamTendencies.url(team, since) : null);
  const { data: league, error: leagueErr } = useQuery<LeagueTendencies>(meta ? api2.league.url(leagueSeason ?? meta.season - 1) : null);
  const err = teamErr ?? leagueErr;
  const metrics: TeamMetric[] = (data?.metrics ?? meta?.team_metrics ?? []).filter((m) => m.side === side);
  const mdef = metrics.find((m) => m.key === metric) ?? metrics[0];
  // Newest season the coordinator scrape has for this team; it can trail the
  // schedule, so the header labels it rather than passing it off as "now".
  const staff = (data?.coordinators ?? [])[0];
  const trend = useMemo(() => (data?.seasons ?? []).slice().reverse().map((s) => ({ season: s.season, v: s[metric] as number | null, rank: shownRank(s[`${metric}_rank`] as number | null, s.n_teams, mdef?.good) })), [data, metric, mdef?.good]);
  const gameTrend = useMemo(() => (data?.games ?? []).filter((g) => g.season >= (data?.seasons[0]?.season ?? 0) - 1).map((g) => ({ label: `${g.season} W${g.week} ${g.home ? "vs" : "@"} ${g.opponent}`, v: g[metric] as number | null })), [data, metric]);
  const teams = (meta?.teams ?? []).filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr));
  const active = mdef?.key ?? metric;   // what is actually charted, sorted and highlighted
  const sortedLeague = useMemo(() => (league?.teams ?? []).slice().sort((a, b) => ((b[active] as number) ?? -1e9) - ((a[active] as number) ?? -1e9)), [league, active]);
  // The highlighted column is usually past the right edge of a table this wide,
  // so choosing a metric looked like it did nothing. Bring it into view.
  const leagueWrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const wrap = leagueWrap.current;
    const th = wrap?.querySelector<HTMLElement>("th[data-active='1']");
    if (wrap && th) wrap.scrollLeft = Math.max(0, th.offsetLeft - wrap.clientWidth / 2 + th.offsetWidth / 2);
  }, [active, league]);
  if (meta && !meta.team_table_ready) return <Banner kind="warn">The team tendency table is not built yet. Run <code>python -m dashboard.stats.team</code> (about a minute) and reload.</Banner>;
  return (
    <div>
      <div className="page-head"><div><h1>Team tendencies</h1><div className="muted small">Pass rate, pace, red zone, personnel, RB usage and defense, per season with league ranks and per game. Built from play-by-play, so every number is a countable thing.{team ? "" : " Pick a team for its history and game-by-game charts, or stay here to rank all 32 on one metric."}</div></div></div>
      {err && <Banner kind="err">{err}</Banner>}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="controls">
          <Field label="Team"><select className="input" value={team} onChange={(e) => setSp({ team: e.target.value })}><option value="">League table only</option>{teams.map((t) => <option key={t.team_abbr} value={t.team_abbr}>{t.team_name}</option>)}</select></Field>
          <Field label="Side"><Seg value={side} options={[{ v: "off", l: "Offense" }, { v: "def", l: "Defense" }]} onChange={(v) => { setSide(v); const first = (meta?.team_metrics ?? []).find((m) => m.side === v); if (first) setMetric(first.key); }} /></Field>
          <Field label={team ? "Charted metric" : "Rank the league by"}><select className="input" value={mdef?.key ?? ""} onChange={(e) => setMetric(e.target.value)}>{metrics.map((m) => <option key={m.key} value={m.key}>{m.label}{m.since > 1999 ? ` (${m.since}+)` : ""}</option>)}</select></Field>
          {/* Only ever used to fetch one team's season history, so with no team
              picked it was a control that changed nothing. */}
          {team && <Field label="History since"><input className="input num" type="number" min={1999} max={2026} value={since} onChange={(e) => setSince(Number(e.target.value))} /></Field>}
          {mdef?.note && <div className="hint" style={{ maxWidth: 380 }}>{mdef.note}</div>}
        </div>
      </div>
      {team && !data && <div className="empty"><Spinner /></div>}
      {team && data && (
        <div className="grid" style={{ marginBottom: 14 }}>
          <div className="panel">
            <div className="panel-head">
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><TeamTag abbr={team} name />
                <span className="muted small">head coach {data.current_coach ? <Link to={`/coaches?role=HC&coach=${encodeURIComponent(data.current_coach)}`}>{data.current_coach}</Link> : "–"}</span>
                {staff && (
                  <span className="muted small">
                    {/* The staff table is scraped per completed season, so it can trail the
                        schedule; say which season these two are from rather than implying now. */}
                    {staff.season !== data.seasons[0]?.season ? `${staff.season} ` : ""}OC {staff.OC ? <Link to={`/coaches?role=OC&coach=${encodeURIComponent(staff.OC)}`}>{staff.OC}</Link> : "–"}
                    {" · "}DC {staff.DC ? <Link to={`/coaches?role=DC&coach=${encodeURIComponent(staff.DC)}`}>{staff.DC}</Link> : "–"}
                  </span>
                )}
              </div>
              <span className="hint">coaches by season: {data.coaches.slice(0, 8).map((c) => `${c.season} ${c.coach.split(" ").slice(-1)[0]}`).join(" · ")}</span>
            </div>
            <div className="grid grid-2">
              <div>
                <div className="small muted"><b>{mdef?.label}</b> by season (line) · rank in bubbles</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={trend} margin={{ top: 10, right: 10, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={T.grid} vertical={false} />
                    <XAxis dataKey="season" tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={{ stroke: T.axis }} />
                    <YAxis tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v) => fmtStat(v, mdef?.fmt as any)} />
                    <Tooltip contentStyle={T.tooltip} formatter={(v: any, _n, p: any) => [`${fmtStat(v, mdef?.fmt as any)} (rank ${p.payload.rank})`, mdef?.label]} />
                    <Line type="monotone" dataKey="v" stroke={T.accent} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div className="small muted"><b>{mdef?.label}</b> game by game, last two seasons</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={gameTrend} margin={{ top: 10, right: 10, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={T.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: T.tick, fontSize: 9 }} tickLine={false} axisLine={{ stroke: T.axis }} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: T.tick, fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v) => fmtStat(v, mdef?.fmt as any)} />
                    <Tooltip contentStyle={T.tooltip} formatter={(v: any) => [fmtStat(v, mdef?.fmt as any), mdef?.label]} />
                    <Line type="monotone" dataKey="v" stroke={T.over} strokeWidth={1.6} dot={{ r: 2 }} isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="panel" data-tour="team-seasons">
            <div className="panel-head"><h3>{team} by season · {side === "off" ? "offense" : "defense"}</h3><span className="hint">value with league rank, shaded by percentile the good way round: {PCT_LEGEND} · <span className="scroll-hint">scroll sideways for all {metrics.length} metrics</span></span></div>
            <div className="tbl-wrap">
              <table className="tbl wide">
                <thead><tr><th className="left">Season</th><th className="left">Coach</th><th className="left">{side === "off" ? "OC" : "DC"}</th><th>G</th>{metrics.map((m) => <th key={m.key} className={m.key === active ? "over" : ""} onClick={() => setMetric(m.key)} title={m.note || undefined}>{m.label}</th>)}</tr></thead>
                <tbody>
                  {data.seasons.map((s) => { const coach = data.coaches.find((c) => c.season === s.season); const co = (data.coordinators ?? []).find((c) => c.season === s.season); const cord = side === "off" ? co?.OC : co?.DC; return (
                    <tr key={s.season}><td className="left">{s.season}</td><td className="left small muted">{coach?.coach ?? ""}</td>
                      <td className="left small muted">{cord ? <Link to={`/coaches?role=${side === "off" ? "OC" : "DC"}&coach=${encodeURIComponent(cord)}`}>{cord}</Link> : ""}</td>
                      <td className="num muted">{s.games}</td>
                      {metrics.map((m) => { const v = s[m.key] as number | null; const r = s[`${m.key}_rank`] as number | null; return <td key={m.key} className="num" style={{ background: rankTint(r, s.n_teams, m.good) }} title={r ? `rank ${shownRank(r, s.n_teams, m.good)} of ${s.n_teams}` : ""}>{v === null || v === undefined ? "–" : <>{fmtStat(v, m.fmt as any)} <span className="faint tiny">{shownRank(r, s.n_teams, m.good)}</span></>}</td>; })}
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {team && data && (
        <div className="grid grid-2" style={{ marginBottom: 14 }}>
          <div className="panel"><UsageTree team={team} season={data.seasons[0]?.season ?? (meta?.season ?? 2026) - 1} /></div>
          <div className="panel"><DvpTable season={league?.season ?? (meta?.season ?? 2026) - 1} highlight={team} onPick={(t) => setSp({ team: t })} /></div>
        </div>
      )}
      {!team && (
        <div className="panel" style={{ marginBottom: 14 }}><DvpTable season={league?.season ?? (meta?.season ?? 2026) - 1} onPick={(t) => setSp({ team: t })} /></div>
      )}
      {league && (
        <div className="panel" style={{ marginBottom: 14 }} data-tour="team-scatter">
          <div className="panel-head"><h3>League scatter · {league.season}</h3><span className="hint">where every team sits on two tendencies at once{team ? `, ${team} highlighted` : ""}</span></div>
          <TeamScatter league={league} highlight={team ? [team] : []} onPick={(t) => setSp({ team: t })} />
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h3>League table · {league?.season}</h3>
          <span className="hint">sorted by {mdef?.label ?? active}, high to low{mdef?.good === "low" ? " (low is better here)" : ""} · click any column to sort by it</span>
          <Field label="Season"><input className="input num" type="number" min={1999} max={(meta?.season ?? 2026) - 1} value={leagueSeason ?? league?.season ?? ""} onChange={(e) => setLeagueSeason(Number(e.target.value))} /></Field>
        </div>
        <div className="tbl-wrap" style={{ maxHeight: 640 }} ref={leagueWrap}>
          <table className="tbl wide">
            <thead><tr><th className="left">Team</th><th className="left">Coach</th>{metrics.map((m) => <th key={m.key} data-active={m.key === active ? "1" : undefined} className={m.key === active ? "over" : ""} onClick={() => setMetric(m.key)} title={m.note || undefined}>{m.label}{m.key === active ? " ↓" : ""}</th>)}</tr></thead>
            <tbody>
              {sortedLeague.map((t) => (
                <tr key={t.team as string} className={`clickable ${t.team === team ? "hl" : ""}`} onClick={() => setSp({ team: t.team as string })}>
                  <td className="left"><TeamTag abbr={t.team as string} /></td><td className="left small muted">{league?.coaches[t.team as string] ?? ""}</td>
                  {metrics.map((m) => { const v = t[m.key] as number | null; const r = t[`${m.key}_rank`] as number | null; return <td key={m.key} className="num" style={{ background: rankTint(r, t.n_teams, m.good) }} title={r ? `rank ${shownRank(r, t.n_teams, m.good)} of ${t.n_teams}` : ""}>{v === null || v === undefined ? "–" : fmtStat(v, m.fmt as any)}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
