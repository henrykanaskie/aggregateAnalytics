import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import type { GameShares, MatchupSideFull, ZoneKey } from "../api";
import { fmtPct } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { TeamTag } from "./common";

// Past five named slices the colours stop being told apart, so the rest go
// into the grey slice with everyone else.
const NAMED = 5;
const OTHER = "var(--border-2)";

type Scope = "all" | ZoneKey;
const SCOPES: [Scope, string][] = [["all", "All plays"], ["rz", "Red zone"], ["i10", "Inside the 10"], ["gl", "Goal line"]];

/** One player's slice, whichever scope it came from. */
type Row = { player_id: string; name: string; position: string; n: number; usual: number | null; usualTitle?: string; td?: number; ez?: number | null; detail: string };
type Slice = { key: string; label: string; n: number; color: string; row?: Row };

/** One played game: how each backfield split the carries and how the targets
 *  went among wide receivers and tight ends, next to each player's share
 *  before kickoff. The red zone, inside the 10 and the goal line count every
 *  position, since that is where the quarterback sneak and the back's target
 *  decide who scores. */
export function SharePies({ shares, sides, usageSeason, score }: { shares: Record<string, GameShares>; sides: MatchupSideFull[]; usageSeason: number; score: string }) {
  const [scope, setScope] = useSticky<Scope>("matchups.shareScope", "all");
  const teams = sides.map((s) => s.offense).filter((t) => shares[t]);
  if (teams.length === 0) return null;
  // The play-by-play can land after the box score; until it does there is
  // only the all-plays view.
  const hasZones = teams.some((t) => shares[t].zones);
  const sc: Scope = hasZones ? scope : "all";
  const zone = sc === "all" ? null : teams.map((t) => shares[t].zones?.[sc]).find(Boolean) ?? null;
  const zoneLabel = zone?.label ?? "";
  return (
    <div className="panel" data-tour="matchup-shares">
      <div className="panel-head">
        <h3>Who got the ball · final {score}</h3>
        {hasZones && <div className="chips">{SCOPES.map(([k, l]) => <button key={k} className={`chip ${sc === k ? "on" : ""}`} onClick={() => setScope(k)}>{l}</button>)}</div>}
      </div>
      <div className="grid grid-2">
        {teams.map((t) => {
          const s = shares[t];
          const usual = new Map(sides.find((x) => x.offense === t)!.offense_personnel.map((p) => [p.player_id, p]));
          const z = sc === "all" ? null : s.zones?.[sc];
          return (
            <div key={t}>
              <div className="small" style={{ marginBottom: 6 }}><TeamTag abbr={t} name /></div>
              {sc !== "all" ? (
                <div className="share-pair">
                  <SharePie title={`${zoneLabel} carries`} unit="car" total={z?.carries.total ?? 0} rest="others" extra={["td"]}
                    rows={(z?.carries.rows ?? []).map((r) => ({ ...r, usualTitle: usualTitle(r.usual_n, "carries", zoneLabel), detail: `${r.n} ${r.n === 1 ? "carry" : "carries"}, ${r.td} TD` }))} />
                  <SharePie title={`${zoneLabel} targets`} unit="tgt" total={z?.targets.total ?? 0} rest="others" extra={["ez", "td"]}
                    rows={(z?.targets.rows ?? []).map((r) => ({ ...r, usualTitle: usualTitle(r.usual_n, "targets", zoneLabel), detail: `${r.n} ${r.n === 1 ? "target" : "targets"}, ${r.ez ?? 0} into the end zone, ${r.td} TD` }))} />
                </div>
              ) : (
                <div className="share-pair">
                  <SharePie title="RB carry share" unit="car" total={s.team_carries} rest="QB and others"
                    rows={s.carries.map((r) => ({ ...r, usual: usual.get(r.player_id)?.carry_share ?? null, detail: `${r.n} carries, ${r.yards ?? 0} yards` }))} />
                  <SharePie title="WR / TE target share" unit="tgt" total={s.team_targets} rest="RBs and others"
                    rows={s.targets.map((r) => ({ ...r, usual: usual.get(r.player_id)?.target_share ?? null, detail: `${r.receptions ?? 0} of ${r.n} for ${r.yards ?? 0} yards` }))} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {sc === "all"
          ? <>From the box score. Slices are shares of the team's carries and targets. "Usual" is the player's {usageSeason} share of his team's carries or targets as it stood before this game (the same numbers as Who gets the ball below; for a player who changed teams, his share with the old one); blank when there is nothing to go on.</>
          : <>From the play-by-play: plays snapped {zone?.yards} yards or fewer from the goal line, every position, with kneels, sacks and two-point tries left out. EZ = targets thrown into the end zone. "Usual" is his share of his team's {zoneLabel.toLowerCase()} carries or targets in {usageSeason}, the season Who gets the ball reads, counting only games before this one (with his old team if he moved; hover for the count). Small numbers: one play moves these a long way.</>}
      </div>
    </div>
  );
}

const usualTitle = (n: number | null, what: string, zone: string) => (n === null ? undefined : `${n} ${zone.toLowerCase()} ${what} before this game`);

function SharePie({ title, unit, total, rows, rest, extra = [] }: { title: string; unit: "car" | "tgt"; total: number; rows: Row[]; rest: string; extra?: ("td" | "ez")[] }) {
  if (total === 0) return <div><div className="small" style={{ fontWeight: 600 }}>{title}</div><div className="hint">None in this game.</div></div>;
  const named = rows.slice(0, NAMED);
  const slices: Slice[] = named.map((r, i) => ({ key: r.player_id, label: r.name, n: r.n, color: `var(--cat-${i + 1})`, row: r }));
  const left = total - named.reduce((a, r) => a + r.n, 0);
  if (left > 0) slices.push({ key: "rest", label: rows.length > NAMED ? `${rest} (${rows.length - NAMED} more)` : rest, n: left, color: OTHER });
  return (
    <div className="share-pie">
      <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{title} <span className="muted num" style={{ fontWeight: 400 }}>· {total} team {unit === "car" ? (total === 1 ? "carry" : "carries") : (total === 1 ? "target" : "targets")}</span></div>
      <div className="share-row">
        <PieChart width={120} height={120}>
          <Pie data={slices} dataKey="n" nameKey="label" innerRadius={32} outerRadius={56} startAngle={90} endAngle={-270} stroke="var(--panel)" strokeWidth={2} isAnimationActive={false}>
            {slices.map((sl) => <Cell key={sl.key} fill={sl.color} />)}
          </Pie>
          <Tooltip content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const sl = payload[0].payload as Slice;
            return <div className="tooltip"><div className="t">{sl.label}</div><div className="num">{sl.n} {unit} · {fmtPct(sl.n / total)}</div>{sl.row && <div className="muted">{sl.row.detail}</div>}</div>;
          }} />
        </PieChart>
        <table className="tbl compact tight">
          <thead><tr><th className="left">Player</th><th>{unit === "car" ? "Car" : "Tgt"}</th>{extra.includes("ez") && <th title="Thrown into the end zone">EZ</th>}{extra.includes("td") && <th>TD</th>}<th>Share</th><th title="Share before this game">Usual</th></tr></thead>
          <tbody>{slices.map((sl) => (
            <tr key={sl.key} title={sl.row?.detail}>
              <td className="left"><span className="sw-dot" style={{ background: sl.color }} />{sl.row ? <><Link to={`/research?player=${sl.row.player_id}`}>{sl.label}</Link> <span className="muted">{sl.row.position}</span></> : <span className="muted">{sl.label}</span>}</td>
              <td className="num">{sl.n}</td>
              {extra.includes("ez") && <td className="num muted">{sl.row ? sl.row.ez ?? 0 : ""}</td>}
              {extra.includes("td") && <td className="num">{sl.row ? (sl.row.td ? <b>{sl.row.td}</b> : <span className="faint">0</span>) : ""}</td>}
              <td className={`num ${moved(sl, total)}`} title={sl.row?.usual != null ? "Green: 5 points or more above his usual share; red: 5 or more below" : undefined}><b>{fmtPct(sl.n / total)}</b></td>
              <td className="num muted" title={sl.row?.usualTitle}>{sl.row?.usual != null ? fmtPct(sl.row.usual) : "–"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// Coloured only where the game moved five points or more off his usual share.
const moved = (sl: Slice, total: number) => {
  if (!sl.row || sl.row.usual == null) return "";
  const d = sl.n / total - sl.row.usual;
  return d >= 0.05 ? "over" : d <= -0.05 ? "under" : "";
};
