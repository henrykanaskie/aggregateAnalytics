import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, apiGet, FantasyPlayer, GameLog, GameRow } from "../api";
import { fmtPct } from "../lib/format";
import { FANTASY_KEY, fantasyHref, fantasyStatFor, Scoring, SCORING_LABEL } from "../lib/profile";
import { rankTint } from "../lib/rank";
import { val } from "../lib/stats";
import { chartTheme } from "../lib/theme";
import { useMeta } from "../state";
import { marksFor } from "./FantasySnapshot";

// Start/sit: two to four players side by side, and which one to play.
//
// The call is the chance each player scores the most, from their projections
// and the spread around them: each projection's floor-to-ceiling range is read as a
// normal distribution, and a few thousand simulated weeks count how often each
// player comes out on top. That is the whole model; the reasons underneath say
// what is pushing it, and the table shows the numbers behind those.

const COLORS = ["var(--cat-1)", "var(--cat-3)", "var(--cat-2)", "var(--cat-5)"];
const OUT = ["Out", "Doubtful", "IR", "Suspended", "Not playing"];
const SIMS = 8000;

/** A seeded generator, so the same comparison gives the same percentages
 *  every render instead of wobbling by a point. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000; };
}
function normal(r: () => number) {
  const u = Math.max(r(), 1e-9), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** How often each player outscores the rest, by player id. */
function winShares(players: FantasyPlayer[], scoring: Scoring): Map<string, number> {
  const live = players.filter((p) => p.proj[scoring] && !(p.status && OUT.includes(p.status)));
  const out = new Map<string, number>(players.map((p) => [p.player_id, 0]));
  if (live.length < 2) { if (live.length === 1) out.set(live[0].player_id, 1); return out; }
  // Floor and ceiling are the 20th and 80th percentiles, ±0.8416 sd of a
  // normal, so the range between them is 1.683 sd. The same range the table
  // shows, so the call and the table can never disagree about a player.
  const params = live.map((p) => { const pr = p.proj[scoring]!; return { id: p.player_id, mu: pr.value, sd: Math.max((pr.high - pr.low) / 1.683, 1) }; });
  const r = rng(params.reduce((a, p) => a + p.id.split("").reduce((x, c) => x * 31 + c.charCodeAt(0), 7), 0));
  const wins = new Map<string, number>();
  for (let i = 0; i < SIMS; i++) {
    let best = "", top = -Infinity;
    for (const p of params) { const x = Math.max(0, p.mu + p.sd * normal(r)); if (x > top) { top = x; best = p.id; } }
    wins.set(best, (wins.get(best) ?? 0) + 1);
  }
  for (const [id, n] of wins) out.set(id, n / SIMS);
  return out;
}

const matchupWord = (p: FantasyPlayer) => (p.matchup_rank === null ? null : p.matchup_rank <= 8 ? "easy" : p.matchup_rank > (p.matchup_n ?? 32) - 8 ? "tough" : "neutral");
const roleChange = (p: FantasyPlayer) => (!p.role || p.role.before < 3 ? null : (p.role.last3 - p.role.before) / p.role.before);

/** Plain-language reasons for and against one player, relative to the others. */
function reasons(p: FantasyPlayer, others: FantasyPlayer[], scoring: Scoring, boom: number | null): { up: string[]; down: string[] } {
  const up: string[] = [], down: string[] = [];
  const pr = p.proj[scoring];
  const best = (f: (x: FantasyPlayer) => number | null | undefined) => {
    const mine = f(p); if (mine === null || mine === undefined) return false;
    return others.every((o) => { const v = f(o); return v === null || v === undefined || mine > v; });
  };
  if (p.status === "Not playing") down.push("ESPN projects him for zero points: not expected to play.");
  else if (p.status && OUT.includes(p.status)) down.push(`Listed ${p.status}${p.injury ? ` (${p.injury.toLowerCase()})` : ""}.`);
  else if (p.status) down.push(`${p.status} on the injury report${p.injury ? ` (${p.injury.toLowerCase()})` : ""}.`);
  if (!pr) down.push(p.games === 0 ? "No games on record yet, so there is nothing to project from." : "Too few games to project with any confidence.");
  const m = matchupWord(p);
  if (p.matchup_text) { if (m === "easy") up.push(`${p.matchup_text}.`); else if (m === "tough") down.push(`${p.matchup_text}.`); }
  else if (m === "easy") up.push(`${p.opponent} gives up the ${ordinal(p.matchup_rank!)} most to ${p.position}s.`);
  else if (m === "tough") down.push(`${p.opponent} gives up the ${ordinal((p.matchup_n ?? 32) - p.matchup_rank! + 1)} fewest to ${p.position}s.`);
  const rc = roleChange(p);
  if (rc !== null && rc >= 0.2) up.push(`Role growing: ${p.role!.last3} chances a game lately, up from ${p.role!.before}.`);
  if (rc !== null && rc <= -0.2) down.push(`Role shrinking: ${p.role!.last3} chances a game lately, down from ${p.role!.before}.`);
  if (pr && others.length && best((x) => x.proj[scoring]?.low)) up.push(`Safest floor of the group (${pr.low.toFixed(1)}).`);
  if (pr && others.length && best((x) => x.proj[scoring]?.high)) up.push(`Biggest ceiling of the group (${pr.high.toFixed(1)}).`);
  if (p.position !== "DST" && others.length && best((x) => (x.position === "DST" ? null : x.implied))) up.push(`${p.team} is expected to score the most points (${p.implied}).`);
  if (boom !== null && boom >= 0.35) up.push(`Big weeks are common: ${Math.round(boom * 100)}% of recent games.`);
  if (p.new_to_team && p.stats_team) down.push(`New to ${p.team}; the numbers are from ${p.stats_team}.`);
  return { up, down };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function StartSit({ players, missing, scoring, onRemove, onClear }: {
  players: FantasyPlayer[]; missing: string[]; scoring: Scoring; onRemove: (id: string) => void; onClear: () => void;
}) {
  const { settings } = useMeta();
  const T = chartTheme();
  const key = FANTASY_KEY[scoring];
  const [logs, setLogs] = useState<Record<string, GameRow[]>>({});
  const ids = players.map((p) => p.player_id).join(",");
  useEffect(() => {
    let alive = true;
    for (const p of players) {
      if (logs[p.player_id] || p.position === "DST") continue;
      apiGet<GameLog>(api.gamelog.url(p.player_id, settings.since))
        .then((g) => alive && setLogs((l) => ({ ...l, [p.player_id]: g.rows.filter((r) => r.season_type === "REG") })))
        .catch(() => {});
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, settings.since]);

  // Keyed on what the simulation reads, not the array: the page rebuilds that
  // list every render, and eight thousand draws a render adds up.
  const sig = players.map((p) => { const x = p.proj[scoring]; return `${p.player_id}:${p.status}:${x?.value}:${x?.low}:${x?.high}`; }).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shares = useMemo(() => winShares(players, scoring), [sig]);
  // Kickers are scored on their own stat; everyone else on the chosen format.
  const statOf = (p: FantasyPlayer) => fantasyStatFor(p.position, key);
  const recent = (p: FantasyPlayer) => (logs[p.player_id] ?? []).slice(-16).map((r) => val(r, statOf(p))).filter((v): v is number => v !== null);
  const rate = (p: FantasyPlayer, boom: boolean) => {
    const xs = recent(p); if (!xs.length) return null;
    const [b, u] = marksFor(p.position, scoring);
    return xs.filter((x) => (boom ? x >= b : x < u)).length / xs.length;
  };
  const ranked = [...players].sort((a, b) => (shares.get(b.player_id) ?? 0) - (shares.get(a.player_id) ?? 0));
  const top = ranked[0], second = ranked[1];
  const pTop = top ? shares.get(top.player_id) ?? 0 : 0;
  const close = players.length >= 2 && second && pTop - (shares.get(second.player_id) ?? 0) < (players.length === 2 ? 0.1 : 0.08);

  // Last eight regular-season games each, lined up by how long ago they were.
  const N = 8;
  const chart = Array.from({ length: N }, (_, i) => {
    const row: Record<string, number | string | null> = { ago: i === N - 1 ? "last" : `${N - 1 - i} ago` };
    for (const p of players) { const g = (logs[p.player_id] ?? []).slice(-N); const r = g[i - (N - g.length)]; row[p.player_id] = r ? val(r, statOf(p)) : null; }
    return row;
  });

  if (!players.length && !missing.length) return null;
  type Metric = { label: string; hint?: string; skip?: (ps: FantasyPlayer[]) => boolean; get: (p: FantasyPlayer) => number | null; show: (p: FantasyPlayer) => React.ReactNode; better?: "high" | "low"; tint?: (p: FantasyPlayer) => string | undefined };
  const pr = (p: FantasyPlayer) => p.proj[scoring];
  const metrics: Metric[] = [
    { label: "Projection", get: (p) => pr(p)?.value ?? null, show: (p) => <b>{pr(p)?.value.toFixed(1) ?? "–"}</b>, better: "high" },
    { label: "Floor", hint: "a quiet week", get: (p) => pr(p)?.low ?? null, show: (p) => pr(p)?.low.toFixed(1) ?? "–", better: "high" },
    { label: "Ceiling", hint: "a good week", get: (p) => pr(p)?.high ?? null, show: (p) => pr(p)?.high.toFixed(1) ?? "–", better: "high" },
    { label: "Last 3", get: (p) => pr(p)?.last3 ?? null, show: (p) => pr(p)?.last3?.toFixed(1) ?? "–", better: "high" },
    { label: "Matchup", hint: "what the defense gives up to the position", get: (p) => (p.matchup_rank === null ? null : -p.matchup_rank), show: (p) => (p.matchup_rank === null ? "–" : `${matchupWord(p)} · ${ordinal(p.matchup_rank)}`), better: "high", tint: (p) => rankTint(p.matchup_rank, p.matchup_n) },
    // A defense wants its opponent to score little, so it shows that instead
    // and sits out the comparison.
    { label: "Team pts", hint: "from the betting spread and total; for a D/ST, what its opponent is expected to score", get: (p) => (p.position === "DST" ? null : p.implied), show: (p) => (p.position === "DST" ? `${p.opp_implied ?? "–"} opp` : p.implied ?? "–"), better: "high" },
    { label: "Role", skip: (ps: FantasyPlayer[]) => ps.every((p) => ["K", "DST"].includes(p.position)), hint: "targets + carries a game, last 3 vs before", get: (p) => p.role?.last3 ?? null, show: (p) => (p.role ? `${p.role.last3} (was ${p.role.before})` : "–"), better: "high" },
    { label: "Target / carry share", skip: (ps: FantasyPlayer[]) => ps.every((p) => ["QB", "K", "DST"].includes(p.position)), get: () => null, show: (p) => (p.position === "QB" ? "–" : `${fmtPct(p.target_share)} / ${fmtPct(p.carry_share)}`) },
    { label: "Boom weeks", skip: (ps: FantasyPlayer[]) => ps.every((p) => p.position === "DST"), hint: "last 16 games", get: (p) => rate(p, true), show: (p) => { const r = rate(p, true); return r === null ? (p.position === "DST" ? "–" : "…") : `${fmtPct(r)} ≥ ${marksFor(p.position, scoring)[0]}`; }, better: "high" },
    { label: "Bust weeks", skip: (ps: FantasyPlayer[]) => ps.every((p) => p.position === "DST"), hint: "last 16 games", get: (p) => rate(p, false), show: (p) => { const r = rate(p, false); return r === null ? (p.position === "DST" ? "–" : "…") : `${fmtPct(r)} < ${marksFor(p.position, scoring)[1]}`; }, better: "low" },
  ];
  const bestOf = (m: Metric) => {
    if (!m.better || players.length < 2) return null;
    const vals = players.map((p) => m.get(p)).filter((v): v is number => v !== null);
    if (vals.length < 2) return null;
    return m.better === "high" ? Math.max(...vals) : Math.min(...vals);
  };

  return (
    <div className="panel start-sit" data-tour="start-sit">
      <div className="panel-head">
        <h3>Start / sit · {SCORING_LABEL[scoring]}</h3>
        <div className="actions"><span className="hint">{players.length < 4 ? "add up to four with + in the table" : "four is the limit"}</span><button className="btn sm ghost" onClick={onClear}>clear</button></div>
      </div>

      {players.length === 1 && <div className="hint">Pick at least one more player with <b>+</b> in the table below to compare.</div>}
      {missing.length > 0 && <div className="hint" style={{ marginBottom: 8 }}>Not playing this week (bye or off the depth chart): {missing.length} player{missing.length === 1 ? "" : "s"} from your list. <button className="linkish" onClick={() => missing.forEach(onRemove)}>remove</button></div>}

      {players.length >= 2 && top && (
        <div className={`start-verdict ${close ? "close" : ""}`}>
          {pTop === 0
            ? <>Nobody here can be projected yet.</>
            : close
              ? <><b>Close call.</b> {top.name} scores the most in {Math.round(pTop * 100)}% of simulated weeks, {second.name} in {Math.round((shares.get(second.player_id) ?? 0) * 100)}%. Play the higher floor if you are favored this week, the higher ceiling if you need a big one.</>
              : <><b>Start {top.name}.</b> Scores the most in {Math.round(pTop * 100)}% of simulated weeks{players.length > 2 ? `, ahead of ${second.name} at ${Math.round((shares.get(second.player_id) ?? 0) * 100)}%` : ""}.</>}
        </div>
      )}

      <div className="start-cols" style={{ gridTemplateColumns: `repeat(${players.length}, minmax(0, 1fr))` }}>
        {players.map((p, i) => {
          const r = reasons(p, players.filter((o) => o !== p), scoring, rate(p, true));
          const share = shares.get(p.player_id) ?? 0;
          return (
            <div key={p.player_id} className="start-col" style={{ borderTopColor: COLORS[i] }}>
              <div className="start-name">
                <div><Link to={fantasyHref(p, statOf(p))}><b>{p.name}</b></Link> <span className="muted">{p.position} {p.team}</span></div>
                <button className="btn sm ghost" title="Take out of the comparison" onClick={() => onRemove(p.player_id)}>×</button>
              </div>
              <div className="small muted">{p.home ? "vs" : "@"} {p.opponent}{p.status ? <> · <span className={OUT.includes(p.status) ? "under" : "push"}>{p.status}</span></> : null}</div>
              {players.length >= 2 && <div className="start-share"><div className="bar"><div style={{ width: `${share * 100}%`, background: COLORS[i] }} /></div><span className="num">{Math.round(share * 100)}%</span></div>}
              <ul className="start-reasons">
                {r.up.map((x) => <li key={x} className="up">{x}</li>)}
                {r.down.map((x) => <li key={x} className="down">{x}</li>)}
                {!r.up.length && !r.down.length && <li className="muted">Nothing stands out either way.</li>}
              </ul>
            </div>
          );
        })}
      </div>

      {players.length >= 2 && (
        <div className="tbl-wrap" style={{ marginTop: 12 }}>
          <table className="tbl compact ss-table">
            <thead><tr><th className="left" />{players.map((p, i) => <th key={p.player_id} style={{ color: COLORS[i] }} title={p.name}>{p.name}</th>)}</tr></thead>
            <tbody>{metrics.filter((m) => !m.skip?.(players)).map((m) => { const b = bestOf(m); return (
              <tr key={m.label}>
                <td className="left ss-label">{m.label}{m.hint && <div className="faint tiny ss-hint">{m.hint}</div>}</td>
                {players.map((p) => { const v = m.get(p); return <td key={p.player_id} className={`num ${b !== null && v === b ? "over" : ""}`} style={{ background: m.tint?.(p) }}>{m.show(p)}</td>; })}
              </tr>
            ); })}</tbody>
          </table>
        </div>
      )}

      {players.length >= 2 && players.some((p) => (logs[p.player_id] ?? []).length > 0) && (
        <div style={{ marginTop: 12 }}>
          <div className="hint" style={{ marginBottom: 4 }}>{SCORING_LABEL[scoring]} points, last {N} regular-season games each</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chart} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid stroke={T.grid} vertical={false} />
              <XAxis dataKey="ago" tick={{ fill: T.tick, fontSize: 10.5 }} tickLine={false} axisLine={{ stroke: T.axis }} />
              <YAxis tick={{ fill: T.tick, fontSize: 10.5 }} tickLine={false} axisLine={false} width={40} />
              <Tooltip contentStyle={T.tooltip} formatter={(v: any, id: any) => [typeof v === "number" ? v.toFixed(1) : "–", players.find((p) => p.player_id === id)?.name ?? id]} />
              <Legend formatter={(id: any) => players.find((p) => p.player_id === id)?.name ?? id} wrapperStyle={{ fontSize: 12 }} />
              {players.map((p, i) => <Line key={p.player_id} dataKey={p.player_id} stroke={COLORS[i]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {players.length >= 2 && <div className="hint" style={{ marginTop: 6 }}>The percentages come from {SIMS.toLocaleString()} simulated weeks drawn around each projection, with players listed Out or Doubtful left out. Like the projections, it knows only what the recent games show.</div>}
    </div>
  );
}
