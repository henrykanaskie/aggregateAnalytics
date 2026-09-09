import { useMemo, useState } from "react";
import { LeagueTendencies, TeamMetric } from "../api";
import { fmtStat } from "../lib/format";
import { useMeta } from "../state";
import { Field } from "./common";
import ScatterPlot from "./ScatterPlot";
import { shownRank } from "../lib/rank";
import { describeQuadrants } from "../lib/quadrants";

const PRESETS: { label: string; x: string; y: string }[] = [
  { label: "Pace vs volume", x: "sec_per_play", y: "plays_pg" },
  { label: "Pass rate vs PROE", x: "pass_rate", y: "proe" },
  { label: "RB vs TE target share", x: "rb_target_share", y: "te_target_share" },
  { label: "Red zone: trips vs TD rate", x: "rz_trips_pg", y: "rz_td_rate" },
  { label: "Play action vs motion", x: "pa_rate", y: "motion_rate" },
  { label: "Defense: pass vs rush EPA allowed", x: "def_pass_epa", y: "def_rush_epa" },
  { label: "Defense: pressure vs blitz", x: "def_pressure_rate", y: "def_blitz_rate" },
  { label: "Defense: man rate vs two-high", x: "def_man_rate", y: "def_two_high_rate" },
  { label: "Offense EPA vs defense EPA", x: "epa_play", y: "def_epa_play" },
];

/** Every team as a logo on two tendencies. */
export default function TeamScatter({ league, highlight = [], onPick, defaultX = "sec_per_play", defaultY = "plays_pg" }: { league: LeagueTendencies; highlight?: string[]; onPick?: (team: string) => void; defaultX?: string; defaultY?: string }) {
  const { teamByAbbr } = useMeta();
  const [x, setX] = useState(defaultX);
  const [y, setY] = useState(defaultY);
  const mdef = (k: string): TeamMetric | undefined => league.metrics.find((m) => m.key === k);
  const mx = mdef(x), my = mdef(y);
  const dots = useMemo(() => league.teams.map((t) => ({
    id: t.team as string, label: t.team as string, x: t[x] as number | null, y: t[y] as number | null,
    image: teamByAbbr.get(t.team as string)?.team_logo_espn ?? null, sub: league.coaches[t.team as string],
    highlight: highlight.includes(t.team as string), muted: highlight.length > 0 && !highlight.includes(t.team as string),
    extra: { [`${mx?.label ?? x} rank`]: shownRank(t[`${x}_rank`] as number | null, t.n_teams, mx?.good), [`${my?.label ?? y} rank`]: shownRank(t[`${y}_rank`] as number | null, t.n_teams, my?.good) },
  })), [league, x, y, highlight, teamByAbbr, mx, my]);
  const f = (m?: TeamMetric) => (v: number) => fmtStat(v, (m?.fmt ?? "dec1") as any);
  const pace = (m?: TeamMetric) => (m?.key === "sec_per_play" ? " (higher = slower)" : "");
  // What each corner means, read against the league averages the dashed
  // lines mark (lib/quadrants.ts knows each metric's high and low side).
  const quads = describeQuadrants(x, y, mx?.label ?? x, my?.label ?? y);
  const opts = league.metrics;
  return (
    <div>
      <div className="controls" style={{ marginBottom: 6 }}>
        <Field label="Preset"><select className="input" value="" onChange={(e) => { const p = PRESETS.find((q) => q.label === e.target.value); if (p) { setX(p.x); setY(p.y); } }}><option value="">Choose…</option>{PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}</select></Field>
        <Field label="X axis"><select className="input" value={x} onChange={(e) => setX(e.target.value)}>{opts.map((m) => <option key={m.key} value={m.key}>{m.side === "def" ? "DEF · " : ""}{m.label}</option>)}</select></Field>
        <Field label="Y axis"><select className="input" value={y} onChange={(e) => setY(e.target.value)}>{opts.map((m) => <option key={m.key} value={m.key}>{m.side === "def" ? "DEF · " : ""}{m.label}</option>)}</select></Field>
        <span className="hint" style={{ alignSelf: "center" }}>{league.season} regular season · dashed lines are league averages · hover a logo</span>
      </div>
      <ScatterPlot dots={dots} xLabel={`${mx?.label ?? x}${pace(mx)}`} yLabel={`${my?.label ?? y}${pace(my)}`} xFmt={f(mx)} yFmt={f(my)} quadrants={quads} onPick={onPick} showLabels="all" imageSize={26} />
      {(mx?.note || my?.note) && <div className="hint">{mx?.note ? `${mx.label}: ${mx.note}. ` : ""}{my?.note ? `${my.label}: ${my.note}.` : ""}</div>}
    </div>
  );
}
