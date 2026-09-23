import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, apiFantasy, Board, FantasyPlayer, FantasyWeek, Player, ScheduleGame } from "../api";
import { TeamTag } from "../components/common";
import Spark from "../components/Spark";
import { bestLineup, DEFAULT_SLOTS, RosterEntry, rosterRows, SLOT_LABEL, Slots } from "../components/MyRoster";
import OmniSearch from "../components/OmniSearch";
import Tailor from "../components/Tailor";
import { Mode, SCORING_LABEL, useLens } from "../lib/profile";
import { readSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

// The front door. One search for anything with a page, a row of places to
// start, and underneath, the handful of things this person checks first,
// arranged for them: a fantasy player opens on their lineup, a bettor on what
// moved, someone following along on this week's games.

type ModuleKey = "myteam" | "topplays" | "favgame" | "slate" | "alerts" | "gamelines" | "continue" | "movers";

/** Which modules each mode leads with, in order. The first one gets the wide slot. */
const LAYOUT: Record<Mode, ModuleKey[]> = {
  fantasy: ["myteam", "topplays", "favgame", "movers", "continue"],
  betting: ["alerts", "gamelines", "favgame", "continue", "slate"],
  learn: ["favgame", "slate", "continue", "topplays"],
  default: ["slate", "favgame", "continue"],
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
  const modules = LAYOUT[lens.mode].filter((m) => (m === "myteam" ? lens.fantasy : m === "movers" ? lens.fantasy : m === "alerts" ? lens.betting && p?.betStyle !== "games" : m === "gamelines" ? lens.betting && p?.betStyle !== "props" : true));
  const greeting = { fantasy: "How's your team looking?", betting: "What's moving this week?", learn: "What do you want to dig into?", default: "Where would you like to start?" }[lens.mode];

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
        <div className="home-kicker">{meta ? `${meta.season} · week ${meta.week}` : ""}</div>
        <h1>{greeting}</h1>
        <OmniSearch autoFocus={lens.mode === "learn" || lens.mode === "default"} />
        <div className="home-tiles">
          {tiles.map((t) => (
            <Link key={t.to + t.title} to={t.to} className="home-tile">
              <b>{t.title}</b><span>{t.sub}</span>
            </Link>
          ))}
        </div>
        {!p && (
          <button className="home-tailor" onClick={() => setTailoring(true)}>
            <Spark size={16} /><span><b>Tailor the site to you.</b> A few quick questions and every page rearranges around what you actually check: fantasy, betting, or following the game.</span>
          </button>
        )}
      </section>

      <section className="home-grid">
        {modules.map((m, i) => <div key={m} className={`home-mod ${i === 0 ? "lead" : ""}`}>{render(m)}</div>)}
      </section>
      {tailoring && <Tailor onDone={() => setTailoring(false)} onCancel={() => setTailoring(false)} />}
    </div>
  );
}

function startTiles(mode: Mode, hasTeam: boolean, games: boolean, gamesFirst: boolean): { title: string; sub: string; to: string }[] {
  const all = {
    player: { title: "Look up a player", sub: "every game, every stat, since 1999", to: "/research" },
    fantasy: { title: "Fantasy week", sub: "rankings, matchups, roles, start / sit", to: "/fantasy" },
    board: { title: "Lines board", sub: "this week's props across books", to: "/board" },
    games: { title: "Game lines", sub: "spreads, totals, moneylines", to: "/games" },
    matchups: { title: "This week's games", sub: "scheme against scheme, who gets the ball", to: "/matchups" },
    teams: { title: hasTeam ? "Your team" : "Teams", sub: "tendencies and league ranks", to: "/teams" },
    coaches: { title: "Coaches", sub: "how each staff calls a game", to: "/coaches" },
  };
  const order: Record<Mode, (keyof typeof all)[]> = {
    fantasy: ["fantasy", "player", "matchups", "teams"],
    betting: games ? ["games", "board", "matchups", "player"] : ["board", "player", "matchups", "games"],
    learn: gamesFirst ? ["matchups", "teams", "player", "coaches"] : ["player", "matchups", "teams", "coaches"],
    default: ["player", "matchups", "teams", "fantasy", "board", "coaches"],
  };
  return order[mode].map((k) => all[k]);
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
        <div className="home-big"><span className="num">{total.toFixed(1)}</span><span className="muted small">projected, {SCORING_LABEL[scoring]}{lens.ceiling ? " (you play for ceilings: check the high end on the fantasy page)" : ""}</span></div>
        <table className="tbl compact"><tbody>
          {res.lineup.map((l, i) => (
            <tr key={i}>
              <td className="left slot">{SLOT_LABEL[l.slot]}</td>
              <td className="left">{l.row ? <Link to={`/research?player=${l.row.entry.player_id}`}>{l.row.entry.name}</Link> : <span className="under">empty</span>}
                {l.row?.p?.status && <span className={`pill ${OUT.includes(l.row.p.status) ? "under" : "warn"}`}>{l.row.p.status}</span>}</td>
              <td className="left small muted">{l.row?.p ? `${l.row.p.home ? "vs" : "@"} ${l.row.p.opponent}` : ""}</td>
              <td className="num"><b>{l.row?.proj?.toFixed(1) ?? "–"}</b></td>
            </tr>
          ))}
        </tbody></table>
        {empty.length > 0 && <div className="small" style={{ marginTop: 8 }}><span className="under">{empty.length} empty slot{empty.length === 1 ? "" : "s"}</span> ({[...new Set(empty)].join(", ")}). <Link to="/fantasy">Add players</Link> to fill them.</div>}
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
              {rows.map((p) => <div key={p.player_id} className="home-row"><Link to={`/research?player=${p.player_id}`}>{p.name}</Link><span className="muted small">{p.home ? "vs" : "@"} {p.opponent}</span><b className="num">{score(p).toFixed(1)}</b></div>)}
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
        <div key={p.player_id} className="home-row"><Link to={`/research?player=${p.player_id}`}>{p.name}</Link><span className="muted small">{p.position} {p.team}</span><span className="num over">{p.role!.before.toFixed(1)} → {p.role!.last3.toFixed(1)}</span></div>
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
        <div className="home-game-teams"><TeamTag abbr={g.away_team} name /><span className="muted">at</span><TeamTag abbr={g.home_team} name /></div>
        <div className="small muted">{dayOf(g.gameday)} {g.gameday?.slice(5)} {g.gametime}{note ? ` · ${note}` : ""}</div>
        {g.home_score !== null ? <div className="home-big"><span className="num">{g.away_score}-{g.home_score}</span><span className="muted small">final</span></div> : (
          <div className="tiles" style={{ marginTop: 8 }}>
            <div className="tile"><div className="k">Expected points</div><div className="v" style={{ fontSize: 16 }}>{ai !== null ? `${g.away_team} ${ai.toFixed(1)} · ${g.home_team} ${hi!.toFixed(1)}` : "–"}</div><div className="s">from the spread and total</div></div>
            <div className="tile"><div className="k">Total</div><div className="v">{g.total_line ?? "–"}</div><div className="s">points, both teams</div></div>
          </div>
        )}
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
