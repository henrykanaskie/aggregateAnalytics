import React from "react";
import { useMeta } from "../state";

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="field"><span>{label}</span>{children}</label>
);
export const Spinner = () => <span className="spin" />;
export const Banner = ({ kind = "info", children }: { kind?: "info" | "warn" | "err"; children: React.ReactNode }) => (
  <div className={`banner ${kind}`}>{children}</div>
);
export function TeamTag({ abbr, name = false }: { abbr: string | null | undefined; name?: boolean }) {
  const { teamByAbbr } = useMeta();
  if (!abbr) return <span className="muted">–</span>;
  const t = teamByAbbr.get(abbr);
  return (
    <span className="teamtag" title={t?.team_name}>
      <span className="sw" style={{ background: t?.team_color ?? "#666" }} />
      {name ? t?.team_name ?? abbr : abbr}
    </span>
  );
}
export function Headshot({ src, size = 36 }: { src: string | null | undefined; size?: number }) {
  const [err, setErr] = React.useState(false);
  if (!src || err) return <span style={{ width: size, height: size * 0.73, borderRadius: 4, background: "var(--bg-2)", display: "inline-block" }} />;
  return <img src={src} onError={() => setErr(true)} style={{ width: size, height: size * 0.73, objectFit: "cover", borderRadius: 4, background: "var(--bg-2)" }} alt="" />;
}
export function SampleBanner({ sources }: { sources: string[] }) {
  if (!sources.includes("sample")) return null;
  return (
    <Banner kind="warn">
      <b>Sample lines.</b> These numbers are generated from last season's averages so the layout has something to show. Pull a real feed from
      Settings (ESPN is free) and they disappear for that week.
    </Banner>
  );
}
export const SourceNote = ({ sources, pulled }: { sources: string[]; pulled?: string | null }) => (
  <span className="hint">
    {sources.length ? `source: ${sources.map((s) => (s === "espn" ? "ESPN (DraftKings)" : s === "oddsapi" ? "The Odds API" : s)).join(", ")}` : "no lines"}
    {pulled ? ` · pulled ${new Date(pulled).toLocaleString()}` : ""}
  </span>
);
