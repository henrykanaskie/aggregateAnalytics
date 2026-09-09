import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildCast, Cast } from "../lib/tourcast";
import { useMeta } from "../state";

// A step says where to be, what to point at, and what to say about it. `where`
// builds a full url from the cast, so a step can open a real player or game
// rather than describing an empty page. A step whose target never renders falls
// back to the section's own tab, and then to a centred card.
interface Step {
  where?: (c: Cast) => string | null;
  sel?: string;
  title: string;
  body: (c: Cast) => React.ReactNode;
  /** Steps that are pointless until the cast is known wait for it. */
  needsCast?: boolean;
  /** Said instead of nothing when the page turns out to have no data to show. */
  ifEmpty?: string;
}

const say = (s: React.ReactNode): ((c: Cast) => React.ReactNode) => () => s;
const HIM = (c: Cast) => c.playerName ?? "this player";

const STEPS: Step[] = [
  {
    where: () => "/board",
    sel: '[data-tour="brand"]',
    title: "Everything is set to one week",
    body: say("The season and week you are looking at show up here. Every page opens on it, and you can move to another week wherever you see a week picker."),
  },
  {
    sel: '[data-tour="nav"]',
    title: "The tabs are the whole app",
    body: say("Nine sections, and each one stays where you left it. Wander off to the board and come back, and the player, team or game you were on is still up."),
  },
  {
    sel: '[data-tour="search"]',
    title: "Look up anyone",
    body: say("Type a name here to jump straight to that player. Anyone who has played since 1999 is in here, not only this week's starters."),
  },
  {
    where: () => "/board",
    sel: '[data-tour="board-filters"]',
    title: "Narrowing down the board",
    body: say("Filter by week, player, position, team or sportsbook, and pick the kinds of props you care about. Sensitivity decides how far off a book has to be before it gets flagged."),
  },
  {
    where: () => "/board",
    sel: '[data-tour="board-table"]',
    ifEmpty: "No lines have been pulled for this week yet, so the board is empty. Settings has a free one that takes about ten seconds.",
    title: "Reading the board",
    body: say("Each row is one prop, each column is one sportsbook. A green or red cell means that book is offering a noticeably different number than the rest. Click any row to dig into the player."),
  },
  {
    needsCast: true,
    where: (c) => (c.playerId ? `/research?player=${c.playerId}${c.market ? `&market=${c.market}` : ""}` : "/research"),
    sel: '[data-tour="research-player"]',
    ifEmpty: "Nobody could be opened automatically, so this is the empty page. Search a name and it fills in.",
    title: "Opening a player",
    body: (c) => (
      <>
        Here is {HIM(c)}, opened the same way you would by clicking a row on the board or searching a name.
        {c.fromLines ? " There is a line posted this week, which is what the rest of this page is measured against." : " No lines have been pulled yet, so this is one of last season's leading scorers instead."}
      </>
    ),
  },
  {
    needsCast: true,
    where: (c) => (c.playerId ? `/research?player=${c.playerId}${c.market ? `&market=${c.market}` : ""}` : "/research"),
    sel: '[data-tour="research-chart"]',
    title: "Every game against the line",
    body: (c) => <>Each dot is a game {HIM(c)} has played, and the flat line across it is this week's number. Green cleared it, red did not. The panels below carry on from here: how that compares with everyone else at the same position, what changes when a teammate sits, where the sportsbooks disagree, and who is hurt.</>,
  },
  {
    needsCast: true,
    where: (c) => (c.gameId ? `/matchups?game=${c.gameId}` : "/matchups"),
    sel: '[data-tour="matchup-top"]',
    ifEmpty: "No game could be opened for this week. Pick one from the row of games once a week's schedule is up.",
    title: "Opening a game",
    body: say("Pick a game from the slate and it opens like this: the spread, the total, the moneyline and the model's own call, side by side at the top."),
  },
  {
    needsCast: true,
    where: (c) => (c.gameId ? `/matchups?game=${c.gameId}` : "/matchups"),
    sel: '[data-tour="matchup-sides"]',
    title: "Both sides of it",
    body: say("Then each offense against the defense it is about to face, the places where two habits collide, who gets the ball, and who is banged up. Every prop posted for the game sits underneath."),
  },
  {
    where: () => "/games",
    sel: '[data-tour="games-grid"]',
    ifEmpty: "Nothing pulled for this week yet, so there is nothing to show. Settings fills it in.",
    title: "Spreads, totals and moneylines",
    body: say("The main game bets across sportsbooks, with the opening number next to the current one so you can see which way a line has moved."),
  },
  {
    needsCast: true,
    where: (c) => (c.team ? `/teams?team=${c.team}` : "/teams"),
    sel: '[data-tour="team-seasons"]',
    ifEmpty: "The team tendency table has not been built on this machine yet, so this page has nothing to draw.",
    title: "How a team actually plays",
    body: (c) => <>{c.team ?? "A team"} season by season: whether they throw or run, play fast or slow, what they do near the end zone and how they hold up on defense. The small number beside each one is where that ranked in the league. Leave the team blank and you get all 32 on a single measure instead.</>,
  },
  {
    needsCast: true,
    where: (c) => (c.coach ? `/coaches?coach=${encodeURIComponent(c.coach)}&role=HC` : "/coaches"),
    sel: '[data-tour="coach-profile"]',
    ifEmpty: "No coach could be opened automatically. Pick any name from the list on the left.",
    title: "The people calling it",
    body: (c) => <>The same habits followed by coach rather than by team. {c.coach ?? "A coach"} here, with every season on record and who got the ball each year. Useful when a team hires someone and you want to know what is about to change.</>,
  },
  {
    where: () => "/predictions",
    sel: '[data-tour="predictions-games"]',
    title: "What the model called",
    body: say("Its pick for each game next to the number the sportsbooks were offering. Every call is written down before kickoff, so nothing here can be quietly improved after the fact."),
  },
  {
    where: () => "/results",
    sel: '[data-tour="results-books"]',
    ifEmpty: "Nothing is graded yet this season: a line can only be checked once its game has been played. The page fills in as the weeks go by.",
    title: "Whether any of it worked",
    body: say("Old lines and old predictions checked against what actually happened. Which sportsbooks were soft, whether the trends meant anything, and how the model did. The misses are in here too, which is rather the point."),
  },
  {
    where: () => "/settings",
    sel: '[data-tour="settings-pull"]',
    title: "Where fresh numbers come from",
    body: say("Lines come in here. ESPN is free and needs nothing set up; the other source needs a key and gets you more sportsbooks. Your default sportsbook and how far back the history reaches are set here too."),
  },
  {
    title: "That is the tour",
    body: (c) => <>The ? up in the header brings it all back whenever you want it. Everything the tour opened is still loaded, so {c.playerName ? `${c.playerName}'s page` : "the research page"} and the rest are a click away.</>,
  },
];

interface Box { top: number; left: number; width: number; height: number }

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const CARD_W = 380;
const GAP = 16;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A panel can be several times taller than the window, and a ring drawn
 *  around the whole of it is a ring nobody can see. What gets lit is the part
 *  that is actually on screen, capped so the card still has somewhere to sit. */
function clip(b: Box): Box {
  const vh = window.innerHeight;
  let { top, height } = b;
  if (top < 12) { height += top - 12; top = 12; }
  height = Math.max(40, Math.min(height, vh * 0.55, vh - top - 24));
  return { ...b, top, height };
}

const EMPTY_CAST: Cast = { playerId: null, playerName: null, market: null, gameId: null, team: null, coach: null, fromLines: false };

/** True when the url the step wants is not the one on screen. Only the params
 *  the step names are compared, so anything a page adds for itself is left
 *  alone rather than being navigated away again a moment later. */
function needsNav(want: string, pathname: string, search: string): boolean {
  const [path, query] = want.split("?");
  if (pathname !== path) return true;
  const have = new URLSearchParams(search);
  for (const [k, v] of new URLSearchParams(query ?? "")) if (have.get(k) !== v) return true;
  return false;
}

export default function Tour({ onDone }: { onDone: () => void }) {
  const { meta, settings } = useMeta();
  const [i, setI] = useState(0);
  const [cast, setCast] = useState<Cast | null>(null);
  // The old target holds its place until the new one has been found, so the
  // ring glides across a page instead of blinking out in between.
  const [box, setBox] = useState<Box | null>(null);
  const [lit, setLit] = useState(false);
  const [cardH, setCardH] = useState(200);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(-1);
  const nav = useNavigate();
  const loc = useLocation();
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const next = () => (last ? onDone() : setI(i + 1));
  const back = () => setI((n) => Math.max(0, n - 1));

  // One pass at the start finds a player, game, team and coach worth opening.
  // It runs while the first few steps are being read, so by the time the tour
  // reaches Research it is usually already there.
  useEffect(() => {
    if (!meta) return;
    let live = true;
    buildCast(meta, settings).then((c) => live && setCast(c)).catch(() => live && setCast(EMPTY_CAST));
    return () => { live = false; };
  }, [meta]);

  const held = step.needsCast && !cast;
  const want = held ? null : step.where?.(cast ?? EMPTY_CAST) ?? null;

  // The route changes first: the element a step points at does not exist until
  // its page is mounted and its data has landed.
  useEffect(() => {
    if (want && needsNav(want, loc.pathname, loc.search)) nav(want);
  }, [want, loc.pathname, loc.search]);

  // Pages arrive from the network and tables settle after they paint, so the
  // target is re-measured for as long as the step is up. One timer covers late
  // content, scrolling and window resizes alike.
  useEffect(() => {
    if (!step.sel) { setLit(false); return; }
    // Crossing to another page: let the ring go rather than leaving it sitting
    // over whatever has taken the old element's place.
    if (want && loc.pathname !== want.split("?")[0]) setLit(false);
    const tick = () => {
      const el = document.querySelector(step.sel!);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (scrolled.current !== i) {
        scrolled.current = i;
        // Centring a panel taller than the window lands halfway down it, past
        // the part that says what it is.
        if (r.height > window.innerHeight - 120) window.scrollTo({ top: window.scrollY + r.top - 84, behavior: "smooth" });
        else el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const found = { top: r.top, left: r.left, width: r.width, height: r.height };
      setBox((prev) => (same(prev, found) ? prev : found));
      setLit(true);
    };
    tick();
    const timer = window.setInterval(tick, 80);
    return () => window.clearInterval(timer);
  }, [i, step.sel, want, loc.pathname]);

  // A page that never renders its target (nothing pulled for the week, say)
  // should still get its say: after a beat the tab it lives under is lit up
  // instead, and failing that the card is simply centred.
  const [gaveUp, setGaveUp] = useState(false);
  const [onTab, setOnTab] = useState(false);
  useEffect(() => {
    setGaveUp(false);
    setOnTab(false);
    const t = window.setTimeout(() => setGaveUp(true), 2500);
    return () => window.clearTimeout(t);
  }, [i]);
  useEffect(() => {
    if (!gaveUp || lit || !want) return;
    const tab = document.querySelector(`[data-tour="nav:${want.split("?")[0]}"]`);
    if (!tab) return;
    const r = tab.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    setLit(true);
    setOnTab(true);
  }, [gaveUp, lit, want]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Knowing the card's own height lets it be placed by its top edge in every
  // case, and a single animated property is what makes it slide rather than
  // jump when it flips to the other side of a target.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  const shown = box ? clip(box) : null;
  const target = lit ? shown : null;
  let top: number, left: number;
  if (target) {
    const below = target.top + target.height + GAP + cardH < window.innerHeight - 12;
    top = clamp(below ? target.top + target.height + GAP : target.top - GAP - cardH, 12, window.innerHeight - cardH - 12);
    left = clamp(target.left + target.width / 2 - CARD_W / 2, 12, window.innerWidth - CARD_W - 12);
  } else {
    top = Math.max(12, (window.innerHeight - cardH) / 2);
    left = Math.max(12, (window.innerWidth - CARD_W) / 2);
  }

  const waiting = !!step.sel && !lit;
  const pad = 6;
  return (
    <div className="tour" role="dialog" aria-label="Guided tour">
      <div className={`tour-veil ${target ? "" : "solid"}`} />
      <div
        className={`tour-ring ${target ? "" : "off"}`}
        style={shown ? { top: shown.top - pad, left: shown.left - pad, width: shown.width + pad * 2, height: shown.height + pad * 2 } : undefined}
      />
      <div ref={cardRef} className="tour-card" style={{ top, left, width: CARD_W }}>
        <div key={i} className="tour-body">
          <div className="tour-step">Step {i + 1} of {STEPS.length}</div>
          <h2>{step.title}</h2>
          <p>{step.body(cast ?? EMPTY_CAST)}</p>
        </div>
        {onTab && step.ifEmpty && <div className="tour-empty">{step.ifEmpty}</div>}
        {waiting && <div className="tour-wait"><span className="spin" /> {held ? "finding a live example" : "opening it"}…</div>}
        <div className="tour-actions">
          <button className="btn ghost sm" onClick={onDone}>Skip tour</button>
          <div className="spacer" />
          <button className="btn sm" onClick={back} disabled={i === 0}>Back</button>
          <button className="btn primary sm" onClick={next}>{last ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
