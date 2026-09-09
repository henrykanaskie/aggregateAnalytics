import type { Player, ScheduleGame } from "../api";
import { Headshot, TeamTag } from "./common";

export default function PlayerHeader({ p, game }: { p: Player; game: ScheduleGame | null }) {
  const age = p.birth_date ? Math.floor((Date.now() - new Date(p.birth_date).getTime()) / (365.25 * 24 * 3600 * 1000)) : null;
  const opp = game ? (game.home_team === p.team ? `vs ${game.away_team}` : `@ ${game.home_team}`) : null;
  const spread = game ? (game.home_team === p.team ? -(game.spread_line ?? 0) : game.spread_line ?? 0) : null;
  return (
    <div className="phead">
      <Headshot src={p.headshot} size={84} />
      <div style={{ flex: 1 }}>
        <div className="name">{p.name} <span className="muted" style={{ fontWeight: 500, fontSize: 15 }}>{p.position}{p.jersey_number ? ` · #${p.jersey_number}` : ""}</span></div>
        <div className="sub">
          <TeamTag abbr={p.team} name />
          {age !== null && <span>{age} yrs</span>}
          {p.years_of_experience !== null && <span>exp {p.years_of_experience}</span>}
          {p.draft_year && <span>{p.draft_year} R{p.draft_round} #{p.draft_pick} ({p.draft_team})</span>}
          {!p.draft_year && p.rookie_season && <span>UDFA {p.rookie_season}</span>}
          {p.college_name && <span>{p.college_name}</span>}
          <span>{p.games} games · {p.first_season}–{p.last_season}</span>
        </div>
      </div>
      {game && (
        <div className="panel phead-game" style={{ padding: "8px 12px" }}>
          <div className="tiny muted">Week {game.week} · {game.gameday} {game.gametime}</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{opp}</div>
          <div className="small muted">spread <span className="num">{spread === null ? "–" : spread > 0 ? `+${spread}` : spread}</span> · total <span className="num">{game.total_line ?? "–"}</span>{game.total_line !== null && spread !== null ? <> · implied <span className="num">{((game.total_line - spread) / 2).toFixed(1)}</span></> : null}</div>
        </div>
      )}
    </div>
  );
}
