import type { StatDef } from "../api";

export function fmtStat(v: number | null | undefined, fmt: StatDef["fmt"] | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  switch (fmt) {
    case "pct": return `${(v * 100).toFixed(0)}%`;
    case "dec1": return v.toFixed(1);
    case "dec2": return v.toFixed(2);
    default: return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
}
export const fmtNum = (v: number | null | undefined, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(d));
export const fmtPct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(d)}%`);
export const fmtOdds = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v > 0 ? `+${v}` : String(v));
export const fmtLine = (v: number | null | undefined) => (v === null || v === undefined ? "–" : Number.isInteger(v) ? v.toFixed(1) : String(v));
export const fmtSpread = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v > 0 ? `+${v}` : v === 0 ? "PK" : String(v));
export const fmtDelta = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "" : v > 0 ? `+${v.toFixed(d)}` : v.toFixed(d));
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export const impliedProb = (american: number | null | undefined) => {
  if (american === null || american === undefined) return null;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
};
export const gameLabel = (r: { season: number; week: number; opponent: string; home: boolean; season_type?: string }) =>
  `${r.season_type === "POST" ? "P" : "W"}${r.week} ${r.home ? "vs" : "@"} ${r.opponent}`;
