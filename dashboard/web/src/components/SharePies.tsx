import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import type { BoxShares, GameShares, MatchupSideFull, ZoneKey, ZoneRow } from "../api";
import { fmtPct } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { TeamTag } from "./common";

// Past five named slices the colours stop being told apart, so the rest go
// into the grey slice with everyone else.
const NAMED = 5;
const OTHER = "var(--border-2)";

type Scope = "all" | ZoneKey;
type Span = "game" | "season";
const SCOPES: [Scope, string][] = [["all", "All plays"], ["rz", "Red zone"], ["i10", "Inside the 10"], ["gl", "Goal line"]];

/** One player's slice, whichever scope and span it came from. ``cmp`` is the
 *  share it is read against: his usual one for a game, this game's for the
 *  season. */
type Row = { player_id: string; name: string; position: string; n: number; games?: number; td?: number; ez?: number | null; cmp: number | null; cmpTitle?: string; detail: string };
type Slice = { key: string; label: string; n: number; color: string; row?: Row };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One played game, or the team's season through that game's week: how each
 *  backfield split the carries and how the targets went among wide receivers
 *  and tight ends. The red zone, inside the 10 and the goal line count every
 *  position, since that is where the quarterback sneak and the back's target
 *  decide who scores. */
export function SharePies({ shares, sides, usageSeason, season, week, score }: { shares: Record<string, GameShares>; sides: MatchupSideFull[]; usageSeason: number; season: number; week: number; score: string }) {
  const [scope, setScope] = useSticky<Scope>("matchups.shareScope", "all");
  const [span, setSpan] = useSticky<Span>("matchups.shareSpan", "game");
  const teams = sides.map((s) => s.offense).filter((t) => shares[t]);
  if (teams.length === 0) return null;
  const hasSeason = teams.every((t) => shares[t].season);
  const sp: Span = hasSeason ? span : "game";
  const pick = (t: string): BoxShares => (sp === "season" ? shares[t].season! : shares[t]);
  // The play-by-play can land after the box score; until it does there is
  // only the all-plays view.
  const hasZones = teams.some((t) => pick(t).zones);
  const sc: Scope = hasZones ? scope : "all";
  const zone = sc === "all" ? null : teams.map((t) => pick(t).zones?.[sc]).find(Boolean) ?? null;
  const zoneLabel = zone?.label ?? "";
  const cmpLabel = sp === "game" ? "Usual" : `Wk ${week}`;
  return (
    <div className="panel" data-tour="matchup-shares">
      <div className="panel-head">
        <h3>Who got the ball · {sp === "game" ? `final ${score}` : `${season} through week ${week}`}</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {hasSeason && <div className="chips">{([["game", "This game"], ["season", `Season thru wk ${week}`]] as [Span, string][]).map(([k, l]) => <button key={k} className={`chip ${sp === k ? "on" : ""}`} onClick={() => setSpan(k)}>{l}</button>)}</div>}
          {hasZones && <div className="chips">{SCOPES.map(([k, l]) => <button key={k} className={`chip ${sc === k ? "on" : ""}`} onClick={() => setScope(k)}>{l}</button>)}</div>}
        </div>
      </div>
      <div className="grid grid-2">
        {teams.map((t) => {
          const s = pick(t);
          const game = shares[t];
          const usual = new Map(sides.find((x) => x.offense === t)!.offense_personnel.map((p) => [p.player_id, p]));
          // The season view reads each player against this game; the game view
          // against his usual share before it.
          const gameShare = (rows: { player_id: string; n: number }[], total: number) => (id: string) => { const r = rows.find((x) => x.player_id === id); return total ? (r ? r.n / total : 0) : null; };
          const z = sc === "all" ? null : s.zones?.[sc];
          const gz = sc === "all" ? null : game.zones?.[sc];
          const zoneRows = (rows: ZoneRow[], kind: "carries" | "targets"): Row[] => {
            const g = gz ? gameShare(gz[kind].rows, gz[kind].total) : () => null;
            return rows.map((r) => ({ ...r,
              cmp: sp === "game" ? r.usual : g(r.player_id),
              cmpTitle: sp === "game" ? (r.usual_n === null ? undefined : `${r.usual_n} ${zoneLabel.toLowerCase()} ${kind} before this game`) : `Share in week ${week}`,
              detail: `${kind === "carries" ? plural(r.n, "carry", "carries") : plural(r.n, "target", "targets")}${kind === "targets" ? `, ${r.ez ?? 0} into the end zone` : ""}, ${r.td} TD${sp === "season" ? ` in ${plural(r.games, "game", "games")}` : ""}` }));
          };
          const gc = gameShare(game.carries, game.team_carries), gt = gameShare(game.targets, game.team_targets);
          return (
            <div key={t}>
              <div className="small" style={{ marginBottom: 6 }}><TeamTag abbr={t} name />{sp === "season" && <span className="muted"> · {plural(s.games, "game", "games")}</span>}</div>
              {sc !== "all" ? (
                <div className="share-pair">
                  <SharePie title={`${zoneLabel} carries`} unit="car" total={z?.carries.total ?? 0} rest="others" extra={["td"]} span={sp} cmpLabel={cmpLabel} rows={zoneRows(z?.carries.rows ?? [], "carries")} />
                  <SharePie title={`${zoneLabel} targets`} unit="tgt" total={z?.targets.total ?? 0} rest="others" extra={["ez", "td"]} span={sp} cmpLabel={cmpLabel} rows={zoneRows(z?.targets.rows ?? [], "targets")} />
                </div>
              ) : (
                <div className="share-pair">
                  <SharePie title="RB carry share" unit="car" total={s.team_carries} rest="QB and others" span={sp} cmpLabel={cmpLabel}
                    rows={s.carries.map((r) => ({ ...r, cmp: sp === "game" ? usual.get(r.player_id)?.carry_share ?? null : gc(r.player_id), cmpTitle: sp === "season" ? `Share in week ${week}` : undefined,
                      detail: `${plural(r.n, "carry", "carries")}, ${r.yards ?? 0} yards, ${r.td} TD${sp === "season" ? ` in ${plural(r.games, "game", "games")}` : ""}` }))} />
                  <SharePie title="WR / TE target share" unit="tgt" total={s.team_targets} rest="RBs and others" span={sp} cmpLabel={cmpLabel}
                    rows={s.targets.map((r) => ({ ...r, cmp: sp === "game" ? usual.get(r.player_id)?.target_share ?? null : gt(r.player_id), cmpTitle: sp === "season" ? `Share in week ${week}` : undefined,
                      detail: `${r.receptions ?? 0} of ${r.n} for ${r.yards ?? 0} yards, ${r.td} TD${sp === "season" ? ` in ${plural(r.games, "game", "games")}` : ""}` }))} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {sc === "all"
          ? <>From the box score. Slices are shares of the team's carries and targets. </>
          : <>From the play-by-play: plays snapped {zone?.yards} yards or fewer from the goal line, every position, with kneels, sacks and two-point tries left out. EZ = targets thrown into the end zone. Small numbers: one play moves these a long way. </>}
        {sp === "game"
          ? (sc === "all"
            ? <>"Usual" is the player's {usageSeason} share of his team's carries or targets as it stood before this game (the same numbers as Who gets the ball below; for a player who changed teams, his share with the old one); blank when there is nothing to go on.</>
            : <>"Usual" is his share of his team's {zoneLabel.toLowerCase()} carries or targets in {usageSeason}, the season Who gets the ball reads, counting only games before this one (with his old team if he moved; hover for the count).</>)
          : <>Season = this team's {season} games through week {week}, this one included and nothing after it, so an older game shows the season as it stood then. G = games he played (in the zone views, games he got one there). "Wk {week}" is his share in this game.</>}
      </div>
    </div>
  );
}

function SharePie({ title, unit, total, rows, rest, span, cmpLabel, extra = [] }: { title: string; unit: "car" | "tgt"; total: number; rows: Row[]; rest: string; span: Span; cmpLabel: string; extra?: ("td" | "ez")[] }) {
  if (total === 0) return <div><div className="small" style={{ fontWeight: 600 }}>{title}</div><div className="hint">None {span === "game" ? "in this game" : "so far"}.</div></div>;
  const named = rows.slice(0, NAMED);
  const slices: Slice[] = named.map((r, i) => ({ key: r.player_id, label: r.name, n: r.n, color: `var(--cat-${i + 1})`, row: r }));
  const left = total - named.reduce((a, r) => a + r.n, 0);
  if (left > 0) slices.push({ key: "rest", label: rows.length > NAMED ? `${rest} (${rows.length - NAMED} more)` : rest, n: left, color: OTHER });
  const season = span === "season";
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
          <thead><tr><th className="left">Player</th><th>{unit === "car" ? "Car" : "Tgt"}</th>{season && <th title="Games played">G</th>}{extra.includes("ez") && <th title="Thrown into the end zone">EZ</th>}{extra.includes("td") && <th>TD</th>}<th>Share</th><th title={season ? "His share in this game" : "Share before this game"}>{cmpLabel}</th></tr></thead>
          <tbody>{slices.map((sl) => (
            <tr key={sl.key} title={sl.row?.detail}>
              <td className="left"><span className="sw-dot" style={{ background: sl.color }} />{sl.row ? <><Link to={`/research?player=${sl.row.player_id}`}>{sl.label}</Link> <span className="muted">{sl.row.position}</span></> : <span className="muted">{sl.label}</span>}</td>
              <td className="num">{sl.n}</td>
              {season && <td className="num muted">{sl.row?.games ?? ""}</td>}
              {extra.includes("ez") && <td className="num muted">{sl.row ? sl.row.ez ?? 0 : ""}</td>}
              {extra.includes("td") && <td className="num">{sl.row ? (sl.row.td ? <b>{sl.row.td}</b> : <span className="faint">0</span>) : ""}</td>}
              <td className={`num ${season ? "" : moved(sl, total)}`} title={!season && sl.row?.cmp != null ? "Green: 5 points or more above his usual share; red: 5 or more below" : undefined}><b>{fmtPct(sl.n / total)}</b></td>
              <td className={`num ${season ? moved(sl, total, true) : "muted"}`} title={sl.row?.cmpTitle}>{sl.row?.cmp != null ? fmtPct(sl.row.cmp) : "–"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// Coloured only where the two shares sit five points or more apart: the game
// against his usual share, or this game against his season.
const moved = (sl: Slice, total: number, flip = false) => {
  if (!sl.row || sl.row.cmp == null) return "";
  const d = (sl.n / total - sl.row.cmp) * (flip ? -1 : 1);
  return d >= 0.05 ? "over" : d <= -0.05 ? "under" : "";
};
