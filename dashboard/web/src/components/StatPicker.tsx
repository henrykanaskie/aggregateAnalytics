import { useMeta } from "../state";

/** Grouped <select> over the stat catalog. `available` hides stats the player has no data for. */
export default function StatPicker({ value, onChange, available, position, className = "input", important }: { value: string; onChange: (k: string) => void; available?: Record<string, number>; position?: string | null; className?: string; important?: Set<string> | null }) {
  const { meta } = useMeta();
  if (!meta) return null;
  const groups = meta.stat_groups;
  const stats = meta.stats.filter((s) => !available || (available[s.key] ?? 0) > 0 || s.key === value);
  const ordered = [...groups].sort((a, b) => score(b, position) - score(a, position));
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {important && important.size > 0 && (
        <optgroup label="★ Important for this prop">{stats.filter((s) => important.has(s.key)).map((s) => <option key={"imp-" + s.key} value={s.key}>{s.label}</option>)}</optgroup>
      )}
      {ordered.map((g) => {
        const items = stats.filter((s) => s.group === g);
        if (!items.length) return null;
        return <optgroup key={g} label={g}>{items.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</optgroup>;
      })}
    </select>
  );
}
function score(group: string, pos?: string | null): number {
  const p = pos ?? "";
  const pref: Record<string, string[]> = { QB: ["Passing", "Rushing", "Next Gen", "PFR"], RB: ["Rushing", "Receiving", "Combined", "Usage"], WR: ["Receiving", "Usage", "Next Gen", "Expected"], TE: ["Receiving", "Usage", "Expected"], K: ["Kicking"] };
  const list = pref[p] ?? (["LB", "DE", "DT", "CB", "S", "SS", "FS", "OLB", "ILB", "MLB", "NT", "DB"].includes(p) ? ["Defense", "Usage"] : []);
  const i = list.indexOf(group);
  return i === -1 ? 0 : 100 - i;
}
