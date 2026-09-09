/** Chart colours read from the CSS variables, so Recharts follows the theme. */
const cssVar = (name: string) => (typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());
export const chartTheme = () => ({
  grid: cssVar("--border"), axis: cssVar("--border-2"), tick: cssVar("--muted"), text: cssVar("--text"),
  accent: cssVar("--accent"), over: cssVar("--over"), under: cssVar("--under"), push: cssVar("--push"), muted: cssVar("--muted"),
  tooltip: { background: cssVar("--panel-2"), border: `1px solid ${cssVar("--border-2")}`, borderRadius: 8, fontSize: 12, color: cssVar("--text") } as React.CSSProperties,
});
export type ChartTheme = ReturnType<typeof chartTheme>;
