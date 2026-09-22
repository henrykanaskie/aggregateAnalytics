import { useEffect, useState } from "react";
import { describe, EMPTY_PROFILE, fits, FocusPos, Profile, Purpose, SCORING_LABEL, TABS } from "../lib/profile";
import { useMeta } from "../state";

// The "Tailor it to me" questions. A handful of one-screen questions whose
// answers become a Profile; every page reads that profile to decide what goes
// on it, what moves down into "More", and what words it uses.

type StepKey = "purpose" | "positions" | "defense" | "scoring" | "depth" | "team" | "review";

interface Opt<T> { v: T; label: string; sub: string }
const PURPOSES: Opt<Purpose>[] = [
  { v: "betting", label: "Betting props", sub: "Sportsbook lines, how often a player clears them, and where the books disagree." },
  { v: "fantasy", label: "Fantasy football", sub: "Fantasy points, usage and matchups, without a sportsbook line in sight." },
  { v: "learn", label: "Following the game", sub: "Stats, team tendencies and matchups, for the sake of knowing." },
];
const POSITIONS: Opt<FocusPos>[] = [
  { v: "QB", label: "Quarterbacks", sub: "" }, { v: "RB", label: "Running backs", sub: "" },
  { v: "WR", label: "Receivers", sub: "" }, { v: "TE", label: "Tight ends", sub: "" }, { v: "K", label: "Kickers", sub: "" },
];
const DEFENSE: Opt<Profile["defense"]>[] = [
  { v: "yes", label: "Yes, all of it", sub: "Team defense plus individual defenders: tackles, sacks, who covers whom." },
  { v: "some", label: "Only as the opponent", sub: "How a defense plays and what it allows, but no individual defender stats." },
  { v: "no", label: "Skip defense", sub: "Defensive stats and panels move out of the way." },
];
const SCORING: Opt<Profile["scoring"]>[] = [
  { v: "ppr", label: "PPR", sub: "A point per catch." }, { v: "half", label: "Half PPR", sub: "Half a point per catch." }, { v: "std", label: "Standard", sub: "Nothing for catches." },
];
const DEPTH: Opt<Profile["depth"]>[] = [
  { v: "quick", label: "Just the essentials", sub: "The main chart, the numbers that matter and the matchup. Deep splits go under \"More\"." },
  { v: "deep", label: "Everything", sub: "Every split, every chart, every table." },
];

function Choice<T>({ opts, on, pick, multi = false }: { opts: Opt<T>[]; on: (v: T) => boolean; pick: (v: T) => void; multi?: boolean }) {
  return (
    <div className={`tailor-opts ${opts.every((o) => !o.sub) ? "compact" : ""}`} role={multi ? "group" : "radiogroup"}>
      {opts.map((o) => (
        <button key={String(o.v)} type="button" className={`tailor-opt ${on(o.v) ? "on" : ""}`} role={multi ? "checkbox" : "radio"} aria-checked={on(o.v)} onClick={() => pick(o.v)}>
          <span className="tick">{on(o.v) ? "✓" : ""}</span>
          <span><b>{o.label}</b>{o.sub && <span className="sub">{o.sub}</span>}</span>
        </button>
      ))}
    </div>
  );
}

export default function Tailor({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { meta, settings, setSettings, teamByAbbr } = useMeta();
  const [p, setP] = useState<Profile>(() => settings.profile ?? EMPTY_PROFILE);
  const [i, setI] = useState(0);
  const steps: StepKey[] = ["purpose", "positions", "defense", ...(p.purposes.includes("fantasy") ? ["scoring" as const] : []), "depth", "team", "review"];
  const step = steps[Math.min(i, steps.length - 1)];
  const last = step === "review";
  const blocked = step === "purpose" && p.purposes.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () => { setSettings({ profile: p }); onDone(); };

  const teams = (meta?.teams ?? []).filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr)).sort((a, b) => a.team_name.localeCompare(b.team_name));
  const tucked = TABS.filter((t) => !fits(p, t.tags)).map((t) => t.label);
  const changes: string[] = [];
  if (tucked.length) changes.push(`${tucked.join(", ")} move${tucked.length === 1 ? "s" : ""} into the "More" menu in the top bar.`);
  if (!p.purposes.includes("betting")) changes.push("Charts compare each game with a benchmark you can set, not a sportsbook line. Books, line history and prop lists move down into \"More\".");
  if (p.purposes.includes("fantasy") && !p.purposes.includes("betting")) changes.push("The site opens on the Fantasy page: this week's players ranked by projected points, with matchups and who is gaining or losing a role.");
  if (p.purposes.includes("fantasy")) changes.push(`Player pages open on ${SCORING_LABEL[p.scoring]} fantasy points, with a fantasy snapshot at the top: points per game, floor and ceiling, boom and bust weeks, and how much comes from touchdowns.`);
  if (p.defense === "no") changes.push("Defensive stats leave the stat pickers, and defense panels move down into \"More\".");
  if (p.defense === "some") changes.push("Individual defenders (who covers whom, defensive props) move down into \"More\". Team defense stays.");
  if (p.depth === "quick") changes.push("Deep splits, mini charts and correlations move down into \"More\".");
  if (p.positions.length) changes.push(`Browsing players starts with ${p.positions.join(", ")}.`);
  if (p.team) changes.push(`Matchups and Teams open on ${teamByAbbr.get(p.team)?.team_name ?? p.team} when nothing else is picked.`);

  return (
    // A stray click outside would throw away every answer so far, so only
    // Cancel and Escape close this, unlike the welcome card.
    <div className="modal-veil">
      <div className="modal welcome tailor" role="dialog" aria-modal="true" aria-label="Tailor the dashboard">
        <div className="tailor-progress" aria-hidden>{steps.map((s, j) => <i key={s} className={j <= i ? "on" : ""} />)}</div>

        {step === "purpose" && <>
          <h1>What brings you here?</h1>
          <p className="muted">Pick as many as fit. The pages rearrange around it.</p>
          <Choice multi opts={PURPOSES} on={(v) => p.purposes.includes(v)} pick={(v) => set({ purposes: flip(p.purposes, v) })} />
        </>}
        {step === "positions" && <>
          <h1>Which positions do you follow most?</h1>
          <p className="muted">Leave them all off to treat every position the same.</p>
          <Choice multi opts={POSITIONS} on={(v) => p.positions.includes(v)} pick={(v) => set({ positions: flip(p.positions, v) })} />
        </>}
        {step === "defense" && <>
          <h1>How much do you care about defense?</h1>
          <p className="muted">Every matchup still shows what the other defense allows. This is about everything past that.</p>
          <Choice opts={DEFENSE} on={(v) => p.defense === v} pick={(v) => set({ defense: v })} />
        </>}
        {step === "scoring" && <>
          <h1>How does your league score?</h1>
          <p className="muted">Every fantasy number on the site uses this.</p>
          <Choice opts={SCORING} on={(v) => p.scoring === v} pick={(v) => set({ scoring: v })} />
        </>}
        {step === "depth" && <>
          <h1>How much do you want on a page?</h1>
          <p className="muted">Nothing is ever deleted. Whatever doesn't make the cut sits under "More" at the bottom of the page.</p>
          <Choice opts={DEPTH} on={(v) => p.depth === v} pick={(v) => set({ depth: v })} />
        </>}
        {step === "team" && <>
          <h1>Got a favorite team?</h1>
          <p className="muted">Optional. Matchups and Teams open on them when nothing else is picked.</p>
          <select className="input tailor-team" value={p.team ?? ""} onChange={(e) => set({ team: e.target.value || null })}>
            <option value="">No favorite</option>
            {teams.map((t) => <option key={t.team_abbr} value={t.team_abbr}>{t.team_name}</option>)}
          </select>
        </>}
        {step === "review" && <>
          <h1>Here's your layout</h1>
          <ul className="tailor-summary">{describe(p, p.team ? teamByAbbr.get(p.team)?.team_name : undefined).map((s) => <li key={s}>{s}</li>)}</ul>
          <h3 style={{ marginTop: 14 }}>What changes</h3>
          {changes.length ? <ul className="tailor-changes">{changes.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="muted small">Nothing moves. Every page stays laid out as it is.</p>}
        </>}

        <div className="welcome-actions">
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Back</button>}
          {last
            ? <button className="btn primary" onClick={save}>Use this layout</button>
            : <button className="btn primary" disabled={blocked} onClick={() => setI(i + 1)}>Next</button>}
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <span className="hint">{last ? "Change it any time from Settings or the Tailor button in the top bar." : blocked ? "Pick at least one." : `${i + 1} of ${steps.length}`}</span>
        </div>
      </div>
    </div>
  );
}
