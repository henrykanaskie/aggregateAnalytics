import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api6, ScatterRow } from "../api";
import { fmtStat, shortName } from "../lib/format";
import { useMeta } from "../state";
import { Field } from "./common";
import ScatterPlot from "./ScatterPlot";
import StatPicker from "./StatPicker";

const PAIR: Record<string, [string, string]> = {
  QB: ["attempts", "passing_yards"], RB: ["carries", "rushing_yards"], WR: ["targets", "receiving_yards"], TE: ["targets", "receiving_yards"],
};
const RELATED: Record<string, string> = {
  receiving_yards: "targets", receptions: "targets", targets: "snap_offense_pct", rushing_yards: "carries", carries: "snap_offense_pct",
  passing_yards: "attempts", passing_tds: "attempts", receiving_tds: "targets", rushing_tds: "carries", rush_rec_yards: "touches",
  yards_per_carry: "carries", yards_per_target: "targets", adot: "targets", target_share: "adot", catch_rate: "adot",
};

/** The player among position peers for a season: Y = the current stat, X = the volume behind it. */
export default function PlayerScatter({ playerId, position, statKey, season, name }: { playerId: string; position: string; statKey: string; season: number; name?: string }) {
  const { statByKey } = useMeta();
  const nav = useNavigate();
  const pos = ["FB", "HB"].includes(position) ? "RB" : ["QB", "RB", "WR", "TE"].includes(position) ? position : null;
  const [rows, setRows] = useState<ScatterRow[] | null>(null);
  const [yr, setYr] = useState(season);
  const [x, setX] = useState<string>(RELATED[statKey] ?? PAIR[pos ?? "WR"]?.[0] ?? "targets");
  const [y, setY] = useState<string>(statKey);
  const [minG, setMinG] = useState(6);
  useEffect(() => { setY(statKey); setX(RELATED[statKey] ?? PAIR[pos ?? "WR"]?.[0] ?? "targets"); }, [statKey, pos]);
  // Fetched unfiltered and cut by games below, because this player has to be on
  // the chart whether or not he clears the bar. It is 87KB more than the
  // filtered call and one cached response serves every player at the position,
  // where asking the server to keep him would mean a copy of the field per
  // player. Moving the cut here also makes the games control instant.
  useEffect(() => { if (pos) api6.scatterPlayers(yr, pos, 1).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [pos, yr]);
  const sx = statByKey.get(x), sy = statByKey.get(y);
  const perGame = (k: string) => statByKey.get(k)?.fmt === "int" || ["passing_epa", "rushing_epa", "receiving_epa", "fantasy_points", "fantasy_points_ppr"].includes(k);
  const PEERS = 50;    // the field drawn, and what the average lines are read against
  // Named on the chart; the rest name themselves on hover. Naming all fifty
  // put forty of the labels on top of another, which is why this is a count
  // and not everything. Ten rather than more because the labels sit above the
  // dot with no collision avoidance and the crowding grows with the number:
  // measured here, ten leaves two pairs touching and twelve leaves four.
  // Lowering it further does not reach zero, because two players with nearly
  // the same season are two dots in the same place whatever the count is.
  const LABELS = 10;

  // Two problems with charting the whole position. It is 188 receivers, so 188
  // remote headshots and an unreadable cloud of faces; and most of them are
  // bench players whose presence drags the "position average" down to a number
  // no starter is ever measured against. So the field is the 50 most-used at
  // the position, ranked by fantasy points because that cohort should not move
  // when the axes do.
  //
  // All fifty are drawn. An earlier cut to the top 32 by the charted stat kept
  // the labels apart, but it also meant the dots and the dashed averages were
  // different populations: the lines said "the field" while the chart showed
  // its upper half, so every average looked low against what was on screen.
  // Plus this player wherever he lands, and every dot is named: only he keeps
  // a face, since finding him is what the chart is for.
  const { dots, avg, me, missing, gaps } = useMemo(() => {
    const plottable = (r: ScatterRow) => r[x] !== null && r[y] !== null;
    const all = rows ?? [];
    const eligible = all.filter((r) => (r.games as number) >= minG && plottable(r));
    const used = [...eligible].sort((a, b) => ((b.fantasy_points_ppr as number) ?? -Infinity) - ((a.fantasy_points_ppr as number) ?? -Infinity));
    const field = used.slice(0, PEERS);
    const mean = (k: string) => (field.length ? field.reduce((a, r) => a + (r[k] as number), 0) / field.length : null);
    // Sorted by the charted stat so the draw order is stable, not to cut it.
    const top = [...field].sort((a, b) => ((b[y] as number) ?? -Infinity) - ((a[y] as number) ?? -Infinity));
    // Whoever the page is about is on the chart, top of the field or not, over
    // the games bar or not. Searching a player and not finding him is the one
    // outcome this chart must never produce.
    const mine = all.find((r) => r.player_id === playerId);
    const shown = !!mine && plottable(mine);
    if (mine && shown && !top.includes(mine)) top.push(mine);
    return {
      avg: { x: mean(x), y: mean(y), n: field.length },
      me: shown ? mine : null,
      // The two cases no amount of including can fix: he did not play that
      // season, or one of the chosen axes has nothing for him. Say so rather
      // than leaving a hole where the reader expects him.
      missing: rows === null ? null : !mine ? "season" : !shown ? "stat" : null,
      // Which axis actually has nothing for him, so the note names the one to change.
      gaps: mine && !shown ? [x, y].filter((k) => mine[k] === null) : [],
      dots: top.map((r, i) => ({
        // `top` is sorted by the charted stat, so these are the leaders in it.
        id: r.player_id, label: shortName(r.name), labelled: i < LABELS, x: r[x] as number | null, y: r[y] as number | null,
        image: r.player_id === playerId ? r.headshot : null,
        sub: `${r.team} · ${r.games} g`, highlight: r.player_id === playerId,
      })),
    };
  }, [rows, x, y, playerId, minG]);
  if (!pos) return <div className="hint">Peer scatter is available for QB, RB, WR and TE.</div>;
  const fx = (v: number) => fmtStat(v, sx?.fmt), fy = (v: number) => fmtStat(v, sy?.fmt);
  const axis = (k: string, s?: { label: string }) => `${s?.label ?? k}${perGame(k) ? " per game" : ""}`;
  return (
    <div>
      <div className="controls" style={{ marginBottom: 6 }}>
        <Field label="Season"><input className="input num" type="number" value={yr} min={1999} max={season} onChange={(e) => setYr(Number(e.target.value))} /></Field>
        <Field label="X axis"><StatPicker value={x} onChange={setX} position={pos} /></Field>
        <Field label="Y axis"><StatPicker value={y} onChange={setY} position={pos} /></Field>
        <Field label="Min games"><input className="input num" type="number" min={1} max={20} value={minG} onChange={(e) => setMinG(Number(e.target.value))} /></Field>
        <span className="hint" style={{ alignSelf: "center" }}>the {avg.n} most-used {pos}s{dots.length > avg.n ? ", plus this one" : ""} · dashed lines average the same {avg.n} · the top {LABELS} are named, hover any dot for the rest · counting stats are per game, rates from season totals · click a dot to open that player</span>
      </div>
      {missing === "season" && <div className="banner info">{name ?? "This player"} has no {yr} season on record, so there is nothing to place on this chart. Pick another season.</div>}
      {missing === "stat" && <div className="banner info">{name ?? "This player"} has no {gaps.map((k) => statByKey.get(k)?.label ?? k).join(" and no ")} recorded for {yr}, so there is no point to place. Change that axis to see him.</div>}
      {me && (me.games as number) < minG && <div className="hint" style={{ marginBottom: 6 }}>Shown despite {me.games as number} games, under the {minG}-game minimum: the minimum trims the field, never the player you are looking at.</div>}
      {rows === null ? <div className="hint">loading…</div> : <ScatterPlot dots={dots} xLabel={axis(x, sx)} yLabel={axis(y, sy)} xFmt={fx} yFmt={fy} xAvg={avg.x} yAvg={avg.y} onPick={(id) => nav(`/research?player=${id}`)} showLabels="some" imageSize={24} height={400} />}
    </div>
  );
}
