import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, Meta, StatDef, MarketDef, Team } from "./api";
import { peek } from "./lib/cache";

export interface Settings {
  since: number;            // earliest season loaded into a game log
  nGames: number;           // default "last N" window
  preferredBook: string;    // "" = consensus
  thresholdScale: number;   // multiplies the per-market outlier threshold
  includeSample: boolean;   // show generated sample lines when no real feed exists
  showPlayoffs: boolean;
  theme: "dark" | "light";
  focus: boolean;
}
const DEFAULTS: Settings = { since: 2016, nGames: 10, preferredBook: "", thresholdScale: 1, includeSample: true, showPlayoffs: true, theme: "dark", focus: false };
const KEY = "props-dashboard-settings-v1";

function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return DEFAULTS; }
}

interface Ctx {
  meta: Meta | null; error: string | null; settings: Settings; setSettings: (s: Partial<Settings>) => void;
  statByKey: Map<string, StatDef>; marketByKey: Map<string, MarketDef>; teamByAbbr: Map<string, Team>; reloadMeta: () => void;
}
const C = createContext<Ctx>(null as any);

export function MetaProvider({ children }: { children: React.ReactNode }) {
  // Seeded from the cache so a refresh paints the header, teams and stat
  // catalog on the first frame instead of waiting on /api/meta.
  const [meta, setMeta] = useState<Meta | null>(() => peek<Meta>(api.meta.url()) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setS] = useState<Settings>(loadSettings);
  const reloadMeta = () => api.meta().then(setMeta).catch((e) => setError(String(e)));
  useEffect(() => { reloadMeta(); }, []);
  useEffect(() => { document.documentElement.setAttribute("data-theme", settings.theme); }, [settings.theme]);
  const setSettings = (p: Partial<Settings>) => setS((s) => { const n = { ...s, ...p }; localStorage.setItem(KEY, JSON.stringify(n)); return n; });
  const statByKey = useMemo(() => new Map((meta?.stats ?? []).map((s) => [s.key, s])), [meta]);
  const marketByKey = useMemo(() => new Map((meta?.markets ?? []).map((m) => [m.key, m])), [meta]);
  const teamByAbbr = useMemo(() => new Map((meta?.teams ?? []).map((t) => [t.team_abbr, t])), [meta]);
  return <C.Provider value={{ meta, error, settings, setSettings, statByKey, marketByKey, teamByAbbr, reloadMeta }}>{children}</C.Provider>;
}
export const useMeta = () => useContext(C);
