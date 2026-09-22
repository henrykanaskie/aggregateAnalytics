import { api7, TeamShares, ZoneKey } from "../api";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { ApplyField, Field, Spinner } from "./common";
import { PieMode, Row, SharePie } from "./SharePies";

type Scope = "all" | ZoneKey;
const SCOPES: [Scope, string][] = [["all", "All plays"], ["rz", "Red zone"], ["i10", "Inside the 10"], ["gl", "Goal line"]];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The matchup page's who-got-the-ball pies over a team's regular season, or
 *  over any single game of it, each player next to the share the charts are
 *  read against: his with this team last season, or his over the season the
 *  game belongs to. */
export default function TeamSharePies({ team, current, highlight, stickyKey = "teams.shareSeason" }: { team: string; current: number; highlight?: string; stickyKey?: string }) {
  const [season, setSeason] = useSticky<number | null>(stickyKey, null);
  // null = the whole season. A week picked for one team is kept for the next:
  // "how did week 2 go" is a question about the week, not about the team.
  const [week, setWeek] = useSticky<number | null>(`${stickyKey}.week`, null);
  const [scope, setScope] = useSticky<Scope>("matchups.shareScope", "all");
  const { data, loading } = useQuery<TeamShares>(api7.teamShares.url(team, season ?? undefined, week ?? undefined));
  const sched = data?.schedule ?? [];
  const g = data?.game ?? null;
  const gameLabel = (x: { week: number; opponent: string; game_id: string }) =>
    `W${x.week} ${x.game_id.endsWith(`_${team}`) ? "vs" : "@"} ${x.opponent}`;
  const head = (
    <div className="panel-head">
      <h3>Who got the ball · {team} {data?.season ?? ""}{g ? ` · ${gameLabel(g)}` : data && data.weeks.length ? ` through week ${data.weeks[data.weeks.length - 1]}` : ""}</h3>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {data?.zones && <div className="chips">{SCOPES.map(([k, l]) => <button key={k} className={`chip ${scope === k ? "on" : ""}`} onClick={() => setScope(k)}>{l}</button>)}</div>}
        <Field label="Games">
          <select className="input" value={week ?? ""} onChange={(e) => setWeek(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Whole season</option>
            {sched.map((x) => <option key={x.week} value={x.week}>{gameLabel(x)}</option>)}
          </select>
        </Field>
        <ApplyField<number | ""> label="Season" value={(season ?? data?.season ?? "") as number | ""} onApply={(v) => { if (typeof v === "number" && v >= 1999) { setSeason(v); setWeek(null); } }} show={(v) => String(v)}>{(d, set) => <input className="input num" type="number" min={1999} max={current} value={d ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />}</ApplyField>
      </div>
    </div>
  );
  if (!data) return <>{head}{loading ? <div className="empty"><Spinner /></div> : null}</>;
  if (!data.games || !data.carries || !data.targets) {
    return <>{head}<div className="hint">{week ? `${team} has no week ${week} game in ${data.season}.` : `No regular-season games for ${team} in ${data.season} yet.`}</div></>;
  }
  const last = data.last;
  const lastLabel = last?.label ?? String(data.season - 1);
  const one = week !== null;
  const mode: PieMode = { games: !one, cmpLabel: lastLabel,
    cmpHint: one ? `His share over ${team}'s ${data.season} season, and the change from it` : `His share of ${team}'s in ${lastLabel}, and the change since`,
    empty: one ? "None in this game." : "None so far." };
  const sc: Scope = data.zones ? scope : "all";
  const z = sc === "all" ? null : data.zones![sc];
  const lz = sc === "all" ? null : last?.zones?.[sc];
  const cmp = (m: Record<string, number> | undefined, id: string) => (m ? m[id] ?? null : null);
  const games = (n: number) => (one ? "" : ` in ${plural(n, "game", "games")}`);
  const allRows = (kind: "carries" | "targets"): Row[] => data[kind]!.map((r) => ({ ...r, cmp: cmp(last?.[kind], r.player_id),
    detail: kind === "carries" ? `${plural(r.n, "carry", "carries")}, ${r.yards ?? 0} yards, ${r.td} TD${games(r.games)}` : `${r.receptions ?? 0} of ${r.n} for ${r.yards ?? 0} yards, ${r.td} TD${games(r.games)}` }));
  const zoneRows = (kind: "carries" | "targets"): Row[] => (z?.[kind].rows ?? []).map((r) => ({ ...r, cmp: cmp(lz?.[kind], r.player_id),
    detail: `${kind === "carries" ? plural(r.n, "carry", "carries") : plural(r.n, "target", "targets")}${kind === "targets" ? `, ${r.ez ?? 0} into the end zone` : ""}, ${r.td} TD${one ? "" : ` in ${r.games_here} of ${plural(r.games, "game", "games")}`}` }));
  return (
    <>
      {head}
      <div className="small muted" style={{ marginBottom: 6 }}>{one ? gameLabel(g!) : plural(data.games, "game", "games")}</div>
      {z ? (
        <div className="share-pair">
          <SharePie title={`${z.label} carries`} unit="car" total={z.carries.total} rest="others" extra={["td"]} mode={mode} highlight={highlight} rows={zoneRows("carries")} />
          <SharePie title={`${z.label} targets`} unit="tgt" total={z.targets.total} rest="others" extra={["ez", "td"]} mode={mode} highlight={highlight} rows={zoneRows("targets")} />
        </div>
      ) : (
        <div className="share-pair">
          <SharePie title="Carry share" unit="car" total={data.team_carries!} rest="others" mode={mode} highlight={highlight} rows={allRows("carries")} />
          <SharePie title="Target share" unit="tgt" total={data.team_targets!} rest="others" mode={mode} highlight={highlight} rows={allRows("targets")} />
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>
        {one ? <>{team}'s week {week} game, {data.season}. </> : <>Regular season only, every game {team} has played in {data.season}. </>}
        {z
          ? <>From the play-by-play: plays snapped {z.yards} yards or fewer from the goal line, every position, with kneels, sacks and two-point tries left out. EZ = targets thrown into the end zone. </>
          : <>From the box score; every position is in both pies, as a share of the team's carries or targets. </>}
        {!one && <>G = games he played{z ? ", with the games he had one here in the hover" : ""}. </>}
        "{lastLabel}" is {one ? <>his share over the whole {data.season} season</> : <>his share of {team}'s {z ? `${z.label.toLowerCase()} ` : ""}carries or targets that season</>}, with the change beside it: green where this is the bigger share by five points or more, red where it is smaller. Blank where there is nothing to compare with.
      </div>
    </>
  );
}
