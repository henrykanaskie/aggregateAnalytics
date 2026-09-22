import { api7, TeamShares, ZoneKey } from "../api";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { ApplyField, Spinner } from "./common";
import { PieMode, Row, SharePie } from "./SharePies";

type Scope = "all" | ZoneKey;
const SCOPES: [Scope, string][] = [["all", "All plays"], ["rz", "Red zone"], ["i10", "Inside the 10"], ["gl", "Goal line"]];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The matchup page's who-got-the-ball pies over a team's whole regular
 *  season so far, each player next to his share with this team last season. */
export default function TeamSharePies({ team, current }: { team: string; current: number }) {
  const [season, setSeason] = useSticky<number | null>("teams.shareSeason", null);
  const [scope, setScope] = useSticky<Scope>("matchups.shareScope", "all");
  const { data, loading } = useQuery<TeamShares>(api7.teamShares.url(team, season ?? undefined));
  const head = (
    <div className="panel-head">
      <h3>Who got the ball · {team} {data?.season ?? ""}{data && data.weeks.length ? ` through week ${data.weeks[data.weeks.length - 1]}` : ""}</h3>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {data?.zones && <div className="chips">{SCOPES.map(([k, l]) => <button key={k} className={`chip ${scope === k ? "on" : ""}`} onClick={() => setScope(k)}>{l}</button>)}</div>}
        <ApplyField<number | ""> label="Season" value={(season ?? data?.season ?? "") as number | ""} onApply={(v) => { if (typeof v === "number" && v >= 1999) setSeason(v); }} show={(v) => String(v)}>{(d, set) => <input className="input num" type="number" min={1999} max={current} value={d ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />}</ApplyField>
      </div>
    </div>
  );
  if (!data) return <>{head}{loading ? <div className="empty"><Spinner /></div> : null}</>;
  if (!data.games || !data.carries || !data.targets) return <>{head}<div className="hint">No regular-season games for {team} in {data.season} yet.</div></>;
  const last = data.last;
  const lastLabel = String(last?.season ?? data.season - 1);
  const mode: PieMode = { games: true, color: "share", cmpLabel: lastLabel, cmpHint: `His share of ${team}'s in ${lastLabel}`,
    colorHint: `Green: 5 points or more above his ${lastLabel} share; red: 5 or more below`, empty: "None so far." };
  const sc: Scope = data.zones ? scope : "all";
  const z = sc === "all" ? null : data.zones![sc];
  const lz = sc === "all" ? null : last?.zones?.[sc];
  const cmp = (m: Record<string, number> | undefined, id: string) => (m ? m[id] ?? null : null);
  const allRows = (kind: "carries" | "targets"): Row[] => data[kind]!.map((r) => ({ ...r, cmp: cmp(last?.[kind], r.player_id),
    detail: kind === "carries" ? `${plural(r.n, "carry", "carries")}, ${r.yards ?? 0} yards, ${r.td} TD in ${plural(r.games, "game", "games")}` : `${r.receptions ?? 0} of ${r.n} for ${r.yards ?? 0} yards, ${r.td} TD in ${plural(r.games, "game", "games")}` }));
  const zoneRows = (kind: "carries" | "targets"): Row[] => (z?.[kind].rows ?? []).map((r) => ({ ...r, cmp: cmp(lz?.[kind], r.player_id),
    detail: `${kind === "carries" ? plural(r.n, "carry", "carries") : plural(r.n, "target", "targets")}${kind === "targets" ? `, ${r.ez ?? 0} into the end zone` : ""}, ${r.td} TD in ${plural(r.games, "game", "games")}` }));
  return (
    <>
      {head}
      <div className="small muted" style={{ marginBottom: 6 }}>{plural(data.games, "game", "games")}</div>
      {z ? (
        <div className="share-pair">
          <SharePie title={`${z.label} carries`} unit="car" total={z.carries.total} rest="others" extra={["td"]} mode={mode} rows={zoneRows("carries")} />
          <SharePie title={`${z.label} targets`} unit="tgt" total={z.targets.total} rest="others" extra={["ez", "td"]} mode={mode} rows={zoneRows("targets")} />
        </div>
      ) : (
        <div className="share-pair">
          <SharePie title="RB carry share" unit="car" total={data.team_carries!} rest="QB and others" mode={mode} rows={allRows("carries")} />
          <SharePie title="WR / TE target share" unit="tgt" total={data.team_targets!} rest="RBs and others" mode={mode} rows={allRows("targets")} />
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>
        Regular season only, every game {team} has played in {data.season}. {z
          ? <>From the play-by-play: plays snapped {z.yards} yards or fewer from the goal line, every position, with kneels, sacks and two-point tries left out. EZ = targets thrown into the end zone. </>
          : <>From the box score; slices are shares of the team's carries and targets. </>}
        G = games he played{z ? " with one there" : ""}. "{lastLabel}" is his share of {team}'s {z ? `${z.label.toLowerCase()} ` : ""}carries or targets that season; blank if he was not on the team or had none.
      </div>
    </>
  );
}
