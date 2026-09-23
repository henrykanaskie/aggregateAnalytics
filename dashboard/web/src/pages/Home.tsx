import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, apiFantasy, Board, FantasyPlayer, FantasyWeek, Player, ScheduleGame } from "../api";
import { TeamTag } from "../components/common";
import Spark from "../components/Spark";
import { bestLineup, DEFAULT_SLOTS, RosterEntry, rosterRows, SLOT_LABEL, Slots } from "../components/MyRoster";
import OmniSearch from "../components/OmniSearch";
import { ICONS } from "../components/Icons";
import Tailor from "../components/Tailor";
import { fantasyHref, Mode, SCORING_LABEL, useLens } from "../lib/profile";
import { readSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

// The front door. One search for anything with a page, a row of places to
// start, and underneath, the handful of things this person checks first,
// arranged for them: a fantasy player opens on their lineup, a bettor on what
// moved, someone following along on this week's games.

type ModuleKey = "myteam" | "topplays" | "favgame" | "slate" | "alerts" | "gamelines" | "continue" | "movers";

/** Where each mode puts its modules: a wide main column and a narrow side
 *  one, each stacked on its own so neither waits on the other's height. */
const LAYOUT: Record<Mode, { main: ModuleKey[]; side: ModuleKey[] }> = {
  fantasy: { main: ["myteam", "topplays"], side: ["favgame", "movers", "continue"] },
  betting: { main: ["alerts", "gamelines"], side: ["favgame", "slate", "continue"] },
  learn: { main: ["favgame", "slate"], side: ["continue", "topplays"] },
  default: { main: ["slate"], side: ["favgame", "continue"] },
};

const OUT = ["Out", "Doubtful", "IR"];
const dayOf = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }) : "");

export default function Home() {
  const { meta, settings } = useMeta();
  const lens = useLens();
  const p = lens.profile;
  const [tailoring, setTailoring] = useState(false);
  const week = meta?.week ?? null;
  const wantsFantasy = lens.fantasy || lens.mode === "learn";
  const { data: fw } = useQuery<FantasyWeek>(meta && week && wantsFantasy ? apiFantasy.fantasyWeek.url(meta.season, week) : null);
  const { data: sched } = useQuery<ScheduleGame[]>(meta && week ? api.schedule.url(meta.season, week) : null);
  const { data: board } = useQuery<Board>(meta && lens.betting && lens.profile ? api.board.url({ week: week ?? undefined, include_sample: settings.includeSample }) : null);

  const tiles = startTiles(lens.mode, !!p?.team, lens.betting && p?.betStyle !== "props", p?.start === "games");
  const fits = (m: ModuleKey) => (m === "myteam" || m === "movers" ? lens.fantasy : m === "alerts" ? lens.betting && p?.betStyle !== "games" : m === "gamelines" ? lens.betting && p?.betStyle !== "props" : true);
  const { main, side } = LAYOUT[lens.mode];
  const greeting = {
    fantasy: <>How's your <em className="mode-word">team</em> looking?</>,
    betting: <>What's <em className="mode-word">moving</em> this week?</>,
    learn: <>What do you want to <em className="mode-word">dig into</em>?</>,
    default: <>Where would you like to start?</>,
  }[lens.mode];
  const sub = { fantasy: "Your lineup, the week's best plays, and whose role is growing.", betting: "What moved on the board, the week's lines, and the games worth a look.", learn: "Search anyone, or start from this week's games.", default: "Search a player, a team or a coach, or pick a place to start." }[lens.mode];

  const render = (m: ModuleKey) => {
    switch (m) {
      case "myteam": return <MyTeam fw={fw ?? null} />;
      case "topplays": return <TopPlays fw={fw ?? null} />;
      case "favgame": return <FavGame games={sched ?? []} />;
      case "slate": return <Slate games={sched ?? []} />;
      case "alerts": return <Alerts board={board ?? null} />;
      case "gamelines": return <GameLines games={sched ?? []} />;
      case "continue": return <Continue />;
      case "movers": return <Movers fw={fw ?? null} />;
    }
  };

  return (
    <div className={`home home-${lens.mode}`}>
      <section className="home-hero">
        <div className="home-hero-main">
          <div className="home-kicker">{meta ? `${meta.season} season · week ${meta.week}` : "\u00a0"}</div>
          <h1>{greeting}</h1>
          <p className="home-lede">{sub}</p>
          <OmniSearch autoFocus={lens.mode === "learn" || lens.mode === "default"} />
        </div>
        {p ? <Briefing fw={fw ?? null} games={sched ?? []} board={board ?? null} onTailor={() => setTailoring(true)} />
           : <Setup onTailor={() => setTailoring(true)} />}
      </section>

      <nav className="home-tiles" data-n={tiles.length} style={{ ["--n" as string]: tiles.length }} aria-label="Places to start">
        {tiles.map((t) => {
          const Icon = ICONS[t.to];
          return (
            <Link key={t.to + t.title} to={t.to} className="home-tile">
              <span className="home-tile-icon">{Icon && <Icon size={20} />}</span>
              <span className="home-tile-text"><b>{t.title}</b><span>{t.sub}</span></span>
            </Link>
          );
        })}
      </nav>

      <section className="home-cols">
        <div className="home-col home-main">{main.filter(fits).map((m) => <div key={m}>{render(m)}</div>)}</div>
        <div className="home-col home-side">{side.filter(fits).map((m) => <div key={m}>{render(m)}</div>)}</div>
      </section>
      {tailoring && <Tailor onDone={() => setTailoring(false)} onCancel={() => setTailoring(false)} />}
    </div>
  );
}

function startTiles(mode: Mode, hasTeam: boolean, games: boolean, gamesFirst: boolean): { title: string; sub: string; to: string }[] {
  const all = {
    player: { title: "Look up a player", sub: "every game since 1999", to: "/research" },
    fantasy: { title: "Fantasy week", sub: "rankings and start / sit", to: "/fantasy" },
    board: { title: "Lines board", sub: "props across books", to: "/board" },
    games: { title: "Game lines", sub: "spreads and totals", to: "/games" },
    matchups: { title: "This week's games", sub: "scheme against scheme", to: "/matchups" },
    teams: { title: hasTeam ? "Your team" : "Teams", sub: "tendencies and ranks", to: "/teams" },
    coaches: { title: "Coaches", sub: "how each staff calls it", to: "/coaches" },
  };
  const order: Record<Mode, (keyof typeof all)[]> = {
    fantasy: ["fantasy", "player", "matchups", "teams"],
    betting: games ? ["games", "board", "matchups", "player"] : ["board", "player", "matchups", "games"],
    learn: gamesFirst ? ["matchups", "teams", "player", "coaches"] : ["player", "matchups", "teams", "coaches"],
    default: ["player", "matchups", "teams", "fantasy", "board", "coaches"],
  };
  return order[mode].map((k) => all[k]);
}

const ordinal = (n: number) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const spreadFor = (g: ScheduleGame, team: string) => {
  if (g.spread_line === null) return null;
  const v = g.home_team === team ? -g.spread_line : g.spread_line;   // spread_line is the home side's margin
  return v === 0 ? "PK" : v > 0 ? `+${v}` : `${v}`;
};

/** A few sentences about this visitor's week, read off their own data: their
 *  lineup and its matchups, what moved on the lines they bet, their team's
 *  game. Plain rules over live numbers, nothing more. */
function Briefing({ fw, games, board, onTailor }: { fw: FantasyWeek | null; games: ScheduleGame[]; board: Board | null; onTailor: () => void }) {
  const lens = useLens();
  const { teamByAbbr } = useMeta();
  const p = lens.profile!;
  const nick = (t: string) => teamByAbbr.get(t)?.team_nick ?? t;
  const lines: { key: string; node: React.ReactNode; tone?: "up" | "down" | "warn" }[] = [];
  const fav = p.team ? games.find((g) => g.home_team === p.team || g.away_team === p.team) : null;
  const open = games.filter((g) => g.home_score === null && g.total_line !== null);

  if (lens.mode === "fantasy") {
    const roster = readSticky<RosterEntry[]>("fantasy.roster", []);
    const scoring = p.scoring;
    if (fw && roster.length) {
      const rows = rosterRows(roster, fw, scoring);
      const { lineup } = bestLineup(rows, readSticky<Slots>("fantasy.slots", DEFAULT_SLOTS));
      const starters = lineup.filter((l) => l.row).map((l) => l.row!);
      const total = starters.reduce((a, r) => a + (r.proj ?? 0), 0);
      const empty = lineup.length - starters.length;
      lines.push({ key: "total", node: <>Your lineup projects <b>{total.toFixed(1)}</b> {SCORING_LABEL[scoring]} points{empty ? <>, with <b>{empty}</b> slot{empty === 1 ? "" : "s"} still open</> : null}.</> });
      const best = starters.filter((r) => r.p?.matchup_rank && ["QB", "RB", "WR", "TE"].includes(r.p.position)).sort((a, b) => a.p!.matchup_rank! - b.p!.matchup_rank!)[0];
      if (best?.p) lines.push({ key: "matchup", tone: "up", node: <><b>{best.entry.name}</b> has your best matchup: {nick(best.p.opponent)} give up the {ordinal(best.p.matchup_rank!)} most to {best.p.position}s.</> });
      const hurt = rows.filter((r) => r.p?.status).slice(0, 2);
      hurt.forEach((r) => lines.push({ key: `inj-${r.entry.player_id}`, tone: "warn", node: <><b>{r.entry.name}</b> is listed {r.p!.status}{OUT.includes(r.p!.status!) ? ", so he's out of your lineup" : ""}.</> }));
      const moved = rows.filter((r) => r.p?.role && r.p.role.before >= 3).map((r) => ({ r, d: (r.p!.role!.last3 - r.p!.role!.before) / r.p!.role!.before }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
      if (moved && Math.abs(moved.d) >= 0.25) lines.push({ key: "role", tone: moved.d > 0 ? "up" : "down", node: <><b>{moved.r.entry.name}</b>'s role is {moved.d > 0 ? "growing" : "shrinking"}: {moved.r.p!.role!.before.toFixed(1)} to {moved.r.p!.role!.last3.toFixed(1)} chances a game.</> });
    } else if (fw) {
      const want = (p.positions.filter((x) => x !== "K") as string[]).slice(0, 2);
      (want.length ? want : ["RB", "WR"]).forEach((pos) => {
        const top = fw.players.filter((x) => x.position === pos && x.proj[scoring] && !(x.status && OUT.includes(x.status))).sort((a, b) => (lens.ceiling ? b.proj[scoring]!.high - a.proj[scoring]!.high : b.proj[scoring]!.value - a.proj[scoring]!.value))[0];
        if (top) lines.push({ key: `top-${pos}`, node: <>Top {pos} {lens.ceiling ? "ceiling" : "play"}: <b>{top.name}</b> {top.home ? "vs" : "at"} {top.opponent}, {(lens.ceiling ? top.proj[scoring]!.high : top.proj[scoring]!.value).toFixed(1)} projected.</> });
      });
      lines.push({ key: "add", node: <>Add your roster on the <Link to="/fantasy">Fantasy page</Link> and this becomes your lineup.</> });
    }
  } else if (lens.mode === "betting") {
    const alert = (board?.alerts ?? []).slice().sort((a, b) => b.severity - a.severity)[0];
    if (alert) lines.push({ key: "move", node: <><b>Biggest move:</b> {alert.title}.</> });
    const off = (board?.rows ?? []).filter((r) => r.outliers.length > 0).length;
    if (board) lines.push({ key: "off", tone: off ? "up" : undefined, node: off ? <><b>{off}</b> prop{off === 1 ? " has" : "s have"} one book off the consensus.</> : <>Every book agrees with the consensus right now.</> });
  } else {
    const big = [...open].sort((a, b) => (b.total_line ?? 0) - (a.total_line ?? 0))[0];
    if (big) lines.push({ key: "big", node: <>Highest total on the slate: <b>{big.away_team} at {big.home_team}</b>, {big.total_line}.</> });
    const tight = [...open].filter((g) => g.spread_line !== null).sort((a, b) => Math.abs(a.spread_line!) - Math.abs(b.spread_line!))[0];
    if (tight) lines.push({ key: "tight", node: <>Closest on paper: <b>{tight.away_team} at {tight.home_team}</b>, {Math.abs(tight.spread_line!) === 0 ? "a pick'em" : `${Math.abs(tight.spread_line!)} points`}.</> });
  }
  if (fav && p.team) {
    const opp = fav.home_team === p.team ? fav.away_team : fav.home_team;
    const sp = spreadFor(fav, p.team);
    const hi = fav.spread_line !== null && fav.total_line !== null ? (fav.total_line + fav.spread_line) / 2 : null;
    const mine = hi === null ? null : fav.home_team === p.team ? hi : fav.total_line! - hi;
    lines.push({ key: "fav", node: fav.home_score !== null
      ? <>The <b>{nick(p.team)}</b> finished {fav.home_team === p.team ? `${fav.home_score}-${fav.away_score}` : `${fav.away_score}-${fav.home_score}`} against the {nick(opp)}.</>
      : <>The <b>{nick(p.team)}</b> {fav.home_team === p.team ? "host" : "visit"} the {nick(opp)} {dayOf(fav.gameday)}{sp ? <>, {sp}</> : null}{mine !== null ? <>, expected to score {mine.toFixed(1)}</> : null}.</> });
  } else if (p.team && games.length) {
    lines.push({ key: "bye", node: <>The <b>{nick(p.team)}</b> are on bye this week.</> });
  }

  const MODE = { fantasy: "fantasy", betting: "betting", learn: "following the game", default: "everything" }[lens.mode];
  return (
    <div className="home-brief">
      <div className="home-brief-head"><Spark size={16} /><span>Your week</span></div>
      {lines.length === 0 ? <div className="home-brief-line muted">Pulling your week together…</div> : (
        <ul className="home-brief-lines">
          {lines.slice(0, 4).map((l, i) => <li key={l.key} className={l.tone ?? ""} style={{ animationDelay: `${120 + i * 90}ms` }}>{l.node}</li>)}
        </ul>
      )}
      <div className="home-brief-foot"><span>Tailored for {MODE}</span><button className="linkish" onClick={onTailor}>Change answers</button></div>
    </div>
  );
}

/** The hero's right side before any tailoring: the invitation to it. A
 *  tailored visitor gets their briefing there instead. */
function Setup({ onTailor }: { onTailor: () => void }) {
  return (
    <button className="home-setup invite" onClick={onTailor}>
      <span className="home-setup-top"><Spark size={18} /><b>Tailor it to you</b></span>
      <span className="muted">A few quick questions, and every page rearranges around what you actually check: fantasy, betting, or following the game.</span>
      <span className="home-setup-cta">Start →</span>
    </button>
  );
}

// --- modules -------------------------------------------------------------------

function Card({ title, to, link, children }: { title: string; to?: string; link?: string; children: React.ReactNode }) {
  return (
    <div className="panel home-card">
      <div className="panel-head"><h3>{title}</h3>{to && <Link to={to} className="small">{link ?? "open"} →</Link>}</div>
      {children}
    </div>
  );
}

function MyTeam({ fw }: { fw: FantasyWeek | null }) {
  const lens = useLens();
  const scoring = lens.profile?.scoring ?? "ppr";
  const roster = readSticky<RosterEntry[]>("fantasy.roster", []);
  const slots = readSticky<Slots>("fantasy.slots", DEFAULT_SLOTS);
  const res = useMemo(() => (fw && roster.length ? bestLineup(rosterRows(roster, fw, scoring), slots) : null), [fw, roster.length, scoring]);
  if (!roster.length) {
    return (
      <Card title="Your fantasy team">
        <div className="home-empty">
          <p>Add your roster once and this becomes your week at a glance: the best lineup by projection, who is hurt or on bye, and the close calls worth a second look.</p>
          <Link to="/fantasy" className="btn primary">Add my players</Link>
        </div>
      </Card>
    );
  }
  if (!res) return <Card title="Your fantasy team"><div className="hint">Projecting your week…</div></Card>;
  const total = res.lineup.reduce((a, l) => a + (l.row?.proj ?? 0), 0);
  const empty = res.lineup.filter((l) => !l.row).map((l) => SLOT_LABEL[l.slot]);
  const trouble = [...roster.filter((r) => res.bench.some((b) => b.entry.player_id === r.player_id && b.why && b.why !== "too few games to project")).map((r) => `${r.name}: ${res.bench.find((b) => b.entry.player_id === r.player_id)!.why}`)];
  const questionable = res.lineup.filter((l) => l.row?.p?.status && !OUT.includes(l.row.p.status));
  return (
    <Card title="Your fantasy team" to="/fantasy" link="full lineup">
      <div className="home-myteam">
        <div className="home-big"><span className="num">{total.toFixed(1)}</span><span className="muted small">projected {SCORING_LABEL[scoring]} points{lens.ceiling ? ", but your format pays for ceilings" : ""}</span></div>
        <div className="home-lineup">
          {res.lineup.filter((l) => l.row).map((l, i) => (
            <div key={i} className="home-lineup-row">
              <span className="slot">{SLOT_LABEL[l.slot]}</span>
              <span className="who"><Link to={fantasyHref(l.row!.entry)}>{l.row!.entry.name}</Link>
                {l.row!.p?.status && <span className={`pill ${OUT.includes(l.row!.p.status) ? "under" : "warn"}`}>{l.row!.p.status}</span>}</span>
              <span className="opp">{l.row!.p ? `${l.row!.p.home ? "vs" : "@"} ${l.row!.p.opponent}` : ""}</span>
              <b className="num">{l.row!.proj?.toFixed(1)}</b>
            </div>
          ))}
          {empty.length > 0 && (
            <div className="home-lineup-row empty">
              <span className="slot">{empty.length} open</span>
              <span className="who">{empty.join(", ")}</span>
              <Link to="/fantasy" className="opp">add players →</Link>
            </div>
          )}
        </div>
        {(trouble.length > 0 || questionable.length > 0) && (
          <ul className="home-alerts">
            {trouble.map((t) => <li key={t} className="down">{t}</li>)}
            {questionable.map((l) => <li key={l.row!.entry.player_id} className="warn">{l.row!.entry.name} is {l.row!.p!.status}: have a backup ready.</li>)}
          </ul>
        )}
      </div>
    </Card>
  );
}

function TopPlays({ fw }: { fw: FantasyWeek | null }) {
  const lens = useLens();
  const scoring = lens.profile?.scoring ?? "ppr";
  const want = (lens.profile?.positions ?? []).filter((x) => x !== "K") as string[];
  const positions = want.length ? want : ["QB", "RB", "WR", "TE"];
  // Best ball and DFS play for the big week, so they rank by ceiling.
  const score = (p: FantasyPlayer) => (lens.ceiling ? p.proj[scoring]?.high : p.proj[scoring]?.value) ?? -1;
  const byPos = positions.map((pos) => [pos, (fw?.players ?? []).filter((p) => p.position === pos && p.proj[scoring] && !(p.status && OUT.includes(p.status))).sort((a, b) => score(b) - score(a)).slice(0, 4)] as const);
  return (
    <Card title={`Top ${lens.ceiling ? "ceilings" : "projections"} this week`} to="/fantasy" link="all rankings">
      {!fw ? <div className="hint">Loading the week…</div> : (
        <div className="home-top">
          {byPos.map(([pos, rows]) => (
            <div key={pos}>
              <div className="home-sub">{pos}</div>
              {rows.map((p) => <div key={p.player_id} className="home-row"><Link to={fantasyHref(p)}>{p.name}</Link><span className="muted small">{p.home ? "vs" : "@"} {p.opponent}</span><b className="num">{score(p).toFixed(1)}</b></div>)}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Movers({ fw }: { fw: FantasyWeek | null }) {
  const up = (fw?.players ?? []).filter((p) => p.role && p.role.before >= 3 && p.role.last3 >= 5 && p.position !== "QB")
    .map((p) => ({ p, d: (p.role!.last3 - p.role!.before) / p.role!.before })).filter((x) => x.d >= 0.3).sort((a, b) => b.d - a.d).slice(0, 5);
  return (
    <Card title="Roles growing" to="/fantasy" link="more">
      {up.length === 0 ? <div className="hint">No big jumps in role this week.</div> : up.map(({ p }) => (
        <div key={p.player_id} className="home-row"><Link to={fantasyHref(p)}>{p.name}</Link><span className="muted small">{p.position} {p.team}</span><span className="num over">{p.role!.before.toFixed(1)} → {p.role!.last3.toFixed(1)}</span></div>
      ))}
      <div className="hint" style={{ marginTop: 6 }}>Targets plus carries a game, last three against before. Usage leads points.</div>
    </Card>
  );
}

function FavGame({ games }: { games: ScheduleGame[] }) {
  const { settings, teamByAbbr } = useMeta();
  const fav = settings.profile?.team;
  const g = fav ? games.find((x) => x.home_team === fav || x.away_team === fav) : null;
  if (!fav) {
    // Without a favorite, the week's biggest game by total.
    const big = [...games].filter((x) => x.total_line !== null).sort((a, b) => (b.total_line ?? 0) - (a.total_line ?? 0))[0];
    return big ? <GameCard g={big} title="Game of the week" note="the highest total on the slate" /> : <Card title="Game of the week"><div className="hint">No games scheduled.</div></Card>;
  }
  if (!g) return <Card title={teamByAbbr.get(fav)?.team_name ?? fav}><div className="hint">{fav} is on bye this week.</div><Link to={`/teams?team=${fav}`} className="small">team tendencies →</Link></Card>;
  return <GameCard g={g} title={`${teamByAbbr.get(fav)?.team_nick ?? fav} this week`} />;
}

function GameCard({ g, title, note }: { g: ScheduleGame; title: string; note?: string }) {
  const hi = g.spread_line !== null && g.total_line !== null ? (g.total_line + g.spread_line) / 2 : null;
  const ai = hi !== null && g.total_line !== null ? g.total_line - hi : null;
  return (
    <Card title={title} to={`/matchups?game=${g.game_id}`} link="full matchup">
      <div className="home-game">
        <div className="home-game-teams"><TeamTag abbr={g.away_team} name /><span className="muted small">at</span><TeamTag abbr={g.home_team} name /></div>
        <div className="small muted">{dayOf(g.gameday)} {g.gameday?.slice(5).replace("-", "/")} · {g.gametime}{note ? ` · ${note}` : ""}</div>
        {g.home_score !== null ? <div className="home-big" style={{ marginTop: 10 }}><span className="num">{g.away_score}-{g.home_score}</span><span className="muted small">final</span></div> : ai !== null ? (
          <div className="home-split" title="Points each team is expected to score, from the betting spread and total">
            <div className="home-split-labels"><span><b className="num">{ai.toFixed(1)}</b> {g.away_team}</span><span className="muted small">expected points · total {g.total_line}</span><span>{g.home_team} <b className="num">{hi!.toFixed(1)}</b></span></div>
            <div className="home-split-bar"><i style={{ flex: ai, background: "var(--cat-1)" }} /><i style={{ flex: hi!, background: "var(--cat-3)" }} /></div>
          </div>
        ) : <div className="hint" style={{ marginTop: 8 }}>No betting line posted yet.</div>}
      </div>
    </Card>
  );
}

function Slate({ games }: { games: ScheduleGame[] }) {
  return (
    <Card title="This week's games" to="/matchups" link="matchups">
      {games.length === 0 ? <div className="hint">No games this week.</div> : (
        <div className="home-slate">
          {games.map((g) => (
            <Link key={g.game_id} to={`/matchups?game=${g.game_id}`} className="home-slate-game">
              <span><b>{g.away_team}</b> @ <b>{g.home_team}</b></span>
              <span className="muted small">{g.home_score !== null ? `${g.away_score}-${g.home_score}` : `${dayOf(g.gameday)} · ${g.total_line ?? "–"}`}</span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function GameLines({ games }: { games: ScheduleGame[] }) {
  const open = games.filter((g) => g.home_score === null && g.spread_line !== null);
  return (
    <Card title="Spreads and totals" to="/games" link="all books">
      {open.length === 0 ? <div className="hint">Nothing left to bet this week.</div> : (
        <table className="tbl compact"><thead><tr><th className="left">Game</th><th>Fav</th><th>Spread</th><th>Total</th></tr></thead><tbody>
          {open.map((g) => { const homeFav = (g.spread_line ?? 0) > 0; return (
            <tr key={g.game_id}><td className="left"><Link to={`/matchups?game=${g.game_id}`}>{g.away_team} @ {g.home_team}</Link></td>
              <td className="num">{homeFav ? g.home_team : g.away_team}</td><td className="num">-{Math.abs(g.spread_line ?? 0)}</td><td className="num">{g.total_line}</td></tr>
          ); })}
        </tbody></table>
      )}
      <div className="hint" style={{ marginTop: 6 }}>nflverse reference lines; the Games page has each book.</div>
    </Card>
  );
}

function Alerts({ board }: { board: Board | null }) {
  const alerts = (board?.alerts ?? []).slice().sort((a, b) => b.severity - a.severity).slice(0, 6);
  return (
    <Card title="What moved" to="/board" link="lines board">
      {!board ? <div className="hint">Loading the board…</div> : alerts.length === 0 ? <div className="hint">Nothing unusual on the board right now.</div> : alerts.map((a, i) => (
        <div key={i} className="home-row">
          {a.player_id ? <Link to={`/research?player=${a.player_id}${a.market ? `&market=${a.market}` : ""}`}>{a.title}</Link> : <span>{a.title}</span>}
          <span className="muted small">{a.detail}</span>
        </div>
      ))}
    </Card>
  );
}

/** Where each section was last left, from the nav's own memory. */
function Continue() {
  const last = readSticky<Record<string, string>>("nav.last", {});
  const param = (path: string, k: string) => { const u = last[path]; return u ? new URLSearchParams(u.split("?")[1] ?? "").get(k) : null; };
  const pid = param("/research", "player"), team = param("/teams", "team"), coach = param("/coaches", "coach"), game = param("/matchups", "game");
  const { data: player } = useQuery<Player>(pid ? api.player.url(pid) : null);
  const items = [
    pid && player ? { to: last["/research"], label: player.name, sub: `${player.position} · ${player.team}` } : null,
    game ? { to: last["/matchups"], label: game.split("_").slice(2).join(" @ "), sub: `week ${Number(game.split("_")[1])}` } : null,
    team ? { to: last["/teams"], label: team, sub: "team tendencies" } : null,
    coach ? { to: last["/coaches"], label: coach, sub: "coach profile" } : null,
  ].filter(Boolean) as { to: string; label: string; sub: string }[];
  return (
    <Card title="Pick up where you left off">
      {items.length === 0 ? <div className="hint">Nothing yet. The last player, game, team and coach you open will wait here.</div> : items.map((x) => (
        <Link key={x.to} to={x.to} className="home-row"><b>{x.label}</b><span className="muted small">{x.sub}</span></Link>
      ))}
    </Card>
  );
}
