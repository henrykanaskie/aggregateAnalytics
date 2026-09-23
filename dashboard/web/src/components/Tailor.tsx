import { useEffect, useRef, useState } from "react";
import { describe, EMPTY_PROFILE, fits, FocusPos, modeOf, Profile, Purpose, SCORING_LABEL, Start, TABS } from "../lib/profile";
import { readSticky, writeSticky } from "../lib/sticky";
import { useMeta } from "../state";
import type { PlayerLite } from "../api";
import type { RosterEntry } from "./MyRoster";
import PlayerSearch from "./PlayerSearch";
import Spark from "./Spark";

// The "Tailor it to me" questions. Each screen asks one thing, or a few
// closely related things; a single-choice screen moves on as soon as it is
// answered. The answers become a Profile, and every page reads that profile
// to decide its layout (lib/layouts.ts), what goes under "More", and what
// words it uses.

type StepKey = "purpose" | "start" | "positions" | "defense" | "league" | "roster" | "betStyle" | "style" | "team" | "review";

interface Opt<T> { v: T; label: string; sub: string }
const PURPOSES: Opt<Purpose>[] = [
  { v: "betting", label: "Betting", sub: "Sportsbook lines, how often a player clears them, and where the books disagree." },
  { v: "fantasy", label: "Fantasy football", sub: "Fantasy points, usage and matchups, without a sportsbook line in sight." },
  { v: "learn", label: "Following the game", sub: "Stats, team tendencies and matchups, for the sake of knowing." },
];
const STARTS: (Opt<Start> & { needs?: Purpose })[] = [
  { v: "fantasy", label: "Check on my fantasy team", sub: "Home opens on your lineup and this week's rankings.", needs: "fantasy" },
  { v: "betting", label: "See what the lines are doing", sub: "Home opens on what moved and where the books disagree.", needs: "betting" },
  { v: "player", label: "Look up a player", sub: "Home opens on search, and player pages come first." },
  { v: "games", label: "See this week's games", sub: "Home opens on the slate and your team's game." },
];
const POSITIONS: Opt<FocusPos>[] = [
  { v: "QB", label: "Quarterbacks", sub: "" }, { v: "RB", label: "Running backs", sub: "" },
  { v: "WR", label: "Receivers", sub: "" }, { v: "TE", label: "Tight ends", sub: "" }, { v: "K", label: "Kickers", sub: "" }, { v: "DST", label: "Team defenses", sub: "" },
];
const DEFENSE: Opt<Profile["defense"]>[] = [
  { v: "yes", label: "Yes, all of it", sub: "Team defense plus individual defenders: tackles, sacks, who covers whom." },
  { v: "some", label: "Only as the opponent", sub: "How a defense plays and what it allows, but no individual defender stats." },
  { v: "no", label: "Skip defense", sub: "Defensive stats and panels move out of the way." },
];
const BET_STYLE: Opt<Profile["betStyle"]>[] = [
  { v: "props", label: "Player props", sub: "Yards, receptions, touchdowns: the lines board leads." },
  { v: "games", label: "Spreads and totals", sub: "Game lines lead, then matchups." },
  { v: "both", label: "Both", sub: "Props first, game lines one click away." },
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

/** A labelled row of small options, for screens that ask a few related things. */
function Pick<T extends string>({ label, value, opts, set }: { label: string; value: T; opts: [T, string][]; set: (v: T) => void }) {
  return (
    <div className="tailor-pick">
      <span>{label}</span>
      <div className="seg">{opts.map(([v, l]) => <button key={v} type="button" className={value === v ? "on" : ""} onClick={() => set(v)}>{l}</button>)}</div>
    </div>
  );
}

/** What the answers do to the site, in plain words, for the last screen. */
function changesFor(p: Profile, teamName: string | undefined, roster: number): string[] {
  const mode = modeOf(p);
  const out: string[] = [];
  const home: Record<string, string> = {
    fantasy: roster ? `Home opens on your lineup: ${roster} players, the best lineup by projection, and anyone hurt or on bye.` : "Home opens on your fantasy team (add your players on the Fantasy page) and this week's top plays at your positions.",
    betting: p.betStyle === "games" ? "Home opens on this week's spreads and totals, then what moved." : "Home opens on what moved on the board, then game lines.",
    learn: p.start === "games" ? "Home opens on this week's slate and your team's game." : "Home opens on search: any player, team or coach.",
  };
  out.push(home[mode === "default" ? "learn" : mode]);
  const research: Record<string, string> = {
    fantasy: "Player pages lead with the fantasy snapshot beside the matchup and injuries, then points game by game, then how the targets and carries are shared.",
    betting: "Player pages lead with every game against the line beside the books, then hit rates, then how often and when he clears it.",
    learn: "Player pages lead with his history beside where he ranks at his position, then situational splits and the full log.",
  };
  if (mode !== "default") out.push(research[mode] + (p.view === "tables" ? " Tables first: the game log takes the lead spot." : ""));
  const tucked = TABS.filter((t) => !fits(p, t.tags)).map((t) => t.label);
  if (tucked.length) out.push(`${tucked.join(", ")} move${tucked.length === 1 ? "s" : ""} into the "More" menu.`);
  if (p.purposes.includes("fantasy")) out.push(p.fantasyFormat === "season" ? `Everything fantasy is in ${SCORING_LABEL[p.scoring]} scoring.` : `Rankings sort by ceiling, the big week ${p.fantasyFormat === "dfs" ? "a DFS lineup" : "best ball"} is built on, in ${SCORING_LABEL[p.scoring]} scoring.`);
  if (!p.purposes.includes("betting")) out.push("Charts compare each game with a benchmark you set, not a sportsbook line.");
  if (p.defense !== "yes") out.push(p.defense === "no" ? "Defensive stats and panels move out of the way." : "Individual defenders move out of the way; team defense stays.");
  if (p.experience === "pro") out.push("Explanations under panel titles are dropped for a denser page.");
  if (p.depth === "quick") out.push("Deep splits and extra charts wait under \"More\".");
  if (p.team) out.push(`${teamName ?? p.team} is your team: their game and tendencies come up first.`);
  return out;
}

export default function Tailor({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { meta, settings, setSettings, teamByAbbr } = useMeta();
  const [p, setP] = useState<Profile>(() => ({ ...EMPTY_PROFILE, ...(settings.profile ?? {}) }));
  const [roster, setRoster] = useState<RosterEntry[]>(() => readSticky<RosterEntry[]>("fantasy.roster", []));
  const [i, setI] = useState(0);
  const fantasy = p.purposes.includes("fantasy"), betting = p.purposes.includes("betting");
  const steps: StepKey[] = ["purpose", "start", "positions", "defense",
    ...(fantasy ? ["league" as const] : []), ...(fantasy && p.fantasyFormat === "season" ? ["roster" as const] : []),
    ...(betting ? ["betStyle" as const] : []), "style", "team", "review"];
  const step = steps[Math.min(i, steps.length - 1)];
  const last = step === "review";
  const blocked = step === "purpose" && p.purposes.length === 0;
  const timer = useRef<number | undefined>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.clearTimeout(timer.current); };
  }, [onCancel]);
  // A start that no longer fits the purposes falls back to looking up a player.
  useEffect(() => {
    const s = STARTS.find((x) => x.v === p.start);
    if (s?.needs && !p.purposes.includes(s.needs)) setP((x) => ({ ...x, start: "player" }));
  }, [p.purposes]);

  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }));
  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // A single choice answers the screen: show the tick, then move on.
  const answer = (patch: Partial<Profile>) => { set(patch); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setI((n) => n + 1), 260); };
  const save = () => { setSettings({ profile: p }); if (fantasy) writeSticky("fantasy.roster", roster); onDone(); };
  const addPlayer = (pl: PlayerLite) => setRoster((r) => (r.some((x) => x.player_id === pl.player_id) ? r : [...r, { player_id: pl.player_id, name: pl.name, position: pl.position, team: pl.team }]));

  const teams = (meta?.teams ?? []).filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr)).sort((a, b) => a.team_name.localeCompare(b.team_name));

  return (
    // A stray click outside would throw away every answer so far, so only
    // Cancel and Escape close this, unlike the welcome card.
    <div className="modal-veil">
      <div className="modal welcome tailor" role="dialog" aria-modal="true" aria-label="Tailor the dashboard">
        <div className="tailor-eyebrow"><Spark size={15} /><span>Tailor</span><span className="step">{i + 1} / {steps.length}</span></div>
        <div className="tailor-progress" aria-hidden>{steps.map((s, j) => <i key={s} className={j <= i ? "on" : ""} />)}</div>

        <div className="tailor-step" key={step}>
        {step === "purpose" && <>
          <h1>What brings you here?</h1>
          <p className="muted">Pick as many as fit. Each one reshapes the pages differently.</p>
          <Choice multi opts={PURPOSES} on={(v) => p.purposes.includes(v)} pick={(v) => setP((x) => ({ ...x, purposes: flip(x.purposes, v) }))} />
        </>}
        {step === "start" && <>
          <h1>What do you usually do first?</h1>
          <p className="muted">This is what the home page opens on, and which pages come first in the menu.</p>
          <Choice opts={STARTS.filter((s) => !s.needs || p.purposes.includes(s.needs))} on={(v) => p.start === v} pick={(v) => answer({ start: v })} />
        </>}
        {step === "positions" && <>
          <h1>Which positions do you follow most?</h1>
          <p className="muted">They come first in rankings and top plays. Leave them all off to treat every position the same.</p>
          <Choice multi opts={POSITIONS} on={(v) => p.positions.includes(v)} pick={(v) => setP((x) => ({ ...x, positions: flip(x.positions, v) }))} />
        </>}
        {step === "defense" && <>
          <h1>How much do you care about defense?</h1>
          <p className="muted">Every matchup still shows what the other defense allows. This is about everything past that.</p>
          <Choice opts={DEFENSE} on={(v) => p.defense === v} pick={(v) => answer({ defense: v })} />
        </>}
        {step === "league" && <>
          <h1>Your fantasy league</h1>
          <p className="muted">Every fantasy number uses the scoring. The format decides whether rankings chase the safe week or the big one.</p>
          <Pick label="Scoring" value={p.scoring} opts={[["ppr", "PPR"], ["half", "Half PPR"], ["std", "Standard"]]} set={(v) => set({ scoring: v })} />
          <Pick label="Format" value={p.fantasyFormat} opts={[["season", "Season-long"], ["bestball", "Best ball"], ["dfs", "Daily (DFS)"]]} set={(v) => set({ fantasyFormat: v })} />
          <div className="hint" style={{ marginTop: 8 }}>{p.fantasyFormat === "season" ? "Season-long: you set a lineup every week, so the site builds the best one from your roster." : "Best ball and DFS reward the ceiling, so rankings and top plays sort by the big week, not the average one."}</div>
        </>}
        {step === "roster" && <>
          <h1>Add your team? <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>optional</span></h1>
          <p className="muted">With your players in, home shows your best lineup for the week, who is hurt or on bye, and the close calls. You can add or change them later on the Fantasy page.</p>
          <PlayerSearch onSelect={addPlayer} placeholder="Add a player…" />
          <div className="chips" style={{ marginTop: 10 }}>
            {roster.map((r) => <span key={r.player_id} className="chip on">{r.name} <span className="muted">{r.position}</span><button type="button" title="remove" onClick={() => setRoster(roster.filter((x) => x.player_id !== r.player_id))}>×</button></span>)}
            {roster.length === 0 && <span className="hint">No players yet. Skip this if you'd rather add them later.</span>}
          </div>
        </>}
        {step === "betStyle" && <>
          <h1>What do you bet?</h1>
          <p className="muted">It decides which lines lead, on home and in the menu.</p>
          <Choice opts={BET_STYLE} on={(v) => p.betStyle === v} pick={(v) => answer({ betStyle: v })} />
        </>}
        {step === "style" && <>
          <h1>How do you like a page?</h1>
          <p className="muted">These change the shape of each page, not just what is on it.</p>
          <Pick label="Lead with" value={p.view} opts={[["charts", "Charts"], ["tables", "Tables"]]} set={(v) => set({ view: v })} />
          <Pick label="Detail" value={p.depth} opts={[["quick", "Just the essentials"], ["deep", "Everything"]]} set={(v) => set({ depth: v })} />
          <Pick label="You are" value={p.experience} opts={[["new", "New to this"], ["pro", "Know my way around"]]} set={(v) => set({ experience: v })} />
          <div className="hint" style={{ marginTop: 8 }}>{p.experience === "new" ? "New: each page opens with a line on how to read it, and explanations stay under panel titles." : "Experienced: explanations are dropped so more fits on the screen."} {p.depth === "quick" ? "Essentials: deep splits and extra charts wait under \"More\"." : ""}</div>
        </>}
        {step === "team" && <>
          <h1>Got a favorite team?</h1>
          <p className="muted">Optional. Their game leads the home page, and Matchups and Teams open on them.</p>
          <select className="input tailor-team" value={p.team ?? ""} onChange={(e) => set({ team: e.target.value || null })}>
            <option value="">No favorite</option>
            {teams.map((t) => <option key={t.team_abbr} value={t.team_abbr}>{t.team_name}</option>)}
          </select>
        </>}
        {step === "review" && <>
          <h1>Here's your layout</h1>
          <ul className="tailor-summary">{describe(p, p.team ? teamByAbbr.get(p.team)?.team_name : undefined).map((s) => <li key={s}>{s}</li>)}</ul>
          <h3 style={{ marginTop: 14 }}>What changes</h3>
          <ul className="tailor-changes">{changesFor(p, p.team ? teamByAbbr.get(p.team)?.team_name : undefined, fantasy ? roster.length : 0).map((c) => <li key={c}>{c}</li>)}</ul>
        </>}
        </div>

        <div className="welcome-actions">
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Back</button>}
          {last
            ? <button className="btn primary" onClick={save}>Use this layout</button>
            : <button className="btn primary" disabled={blocked} onClick={() => setI(i + 1)}>{step === "roster" && roster.length === 0 ? "Skip" : "Next"}</button>}
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <span className="hint">{last ? "Change it any time from Settings or the Tailor button in the top bar." : blocked ? "Pick at least one." : ""}</span>
        </div>
      </div>
    </div>
  );
}
