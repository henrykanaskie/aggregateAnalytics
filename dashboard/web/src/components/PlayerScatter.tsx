import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api6, ScatterRow } from "../api";
import { fmtStat } from "../lib/format";
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
export default function PlayerScatter({ playerId, position, statKey, season }: { playerId: string; position: string; statKey: string; season: number }) {
  const { statByKey } = useMeta();
  const nav = useNavigate();
  const pos = ["FB", "HB"].includes(position) ? "RB" : ["QB", "RB", "WR", "TE"].includes(position) ? position : null;
  const [rows, setRows] = useState<ScatterRow[] | null>(null);
  const [yr, setYr] = useState(season);
  const [x, setX] = useState<string>(RELATED[statKey] ?? PAIR[pos ?? "WR"]?.[0] ?? "targets");
  const [y, setY] = useState<string>(statKey);
  const [minG, setMinG] = useState(6);
  useEffect(() => { setY(statKey); setX(RELATED[statKey] ?? PAIR[pos ?? "WR"]?.[0] ?? "targets"); }, [statKey, pos]);
  useEffect(() => { if (pos) api6.scatterPlayers(yr, pos, minG).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [pos, yr, minG]);
  const sx = statByKey.get(x), sy = statByKey.get(y);
  const perGame = (k: string) => statByKey.get(k)?.fmt === "int" || ["passing_epa", "rushing_epa", "receiving_epa", "fantasy_points", "fantasy_points_ppr"].includes(k);
  const dots = useMemo(() => (rows ?? []).map((r) => ({
    id: r.player_id, label: r.name.split(" ").slice(-1)[0], x: r[x] as number | null, y: r[y] as number | null, image: r.headshot,
    sub: `${r.team} · ${r.games} g`, highlight: r.player_id === playerId,
  })), [rows, x, y, playerId]);
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
        <span className="hint" style={{ alignSelf: "center" }}>{rows?.length ?? 0} {pos}s · counting stats are per game, rates from season totals · click a face to open that player</span>
      </div>
      {rows === null ? <div className="hint">loading…</div> : <ScatterPlot dots={dots} xLabel={axis(x, sx)} yLabel={axis(y, sy)} xFmt={fx} yFmt={fy} onPick={(id) => nav(`/research?player=${id}`)} showLabels="highlight" imageSize={24} height={400} />}
    </div>
  );
}
