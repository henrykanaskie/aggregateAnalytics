import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildCast, Cast, EMPTY_CAST } from "../lib/tourcast";
import { useMeta } from "../state";
import { Lens, Mode, SCORING_LABEL, TABS, useLens } from "../lib/profile";
import { readSticky } from "../lib/sticky";
import { useMobile } from "../lib/useMobile";
import type { RosterEntry } from "./MyRoster";
import { ICONS, IconClose } from "./Icons";
import Spark from "./Spark";

// The tour walks the site the visitor actually has. A tailored fantasy player
// is shown their lineup and their own player, a bettor the board and the
// books, someone following along the games and the teams; untailored, a
// sampler of each. Every step says where to be, what to point at, and what to
// say, and `where` builds a real url from the cast, so a step opens a real
// player or game rather than describing an empty page. A step whose target
// never renders falls back to the tab it lives under, and then to a centred
// card.

interface Ctx { c: Cast; lens: Lens; mobile: boolean }

interface Step {
  /** Short label for the part of the site the step is in. */
  chapter: string;
  /** The tab whose icon sits beside the chapter, when there is one. */
  icon?: string;
  where?: (x: Ctx) => string | null;
  /** What to light up. A function when the phone and desktop differ. */
  sel?: string | ((x: Ctx) => string);
  title: string | ((x: Ctx) => string);
  body: (x: Ctx) => React.ReactNode;
  /** Steps that are pointless until the cast is known wait for it. */
  needsCast?: boolean;
  /** Said instead of nothing when the page turns out to have no data to show. */
  ifEmpty?: string;
}

const HIM = (c: Cast) => c.playerName ?? "this player";
const text = (v: string | ((x: Ctx) => string), x: Ctx) => (typeof v === "string" ? v : v(x));
const research = ({ c, lens }: Ctx) =>
  !c.playerId ? "/research"
    // A fantasy page charts fantasy points; everyone else gets the line.
    : lens.mode === "fantasy" ? `/research?player=${c.playerId}&stat=${lens.fantasyKey}`
    : `/research?player=${c.playerId}${c.market ? `&market=${c.market}` : ""}`;

const LIB: Record<string, Step> = {
  home: {
    chapter: "Home", where: () => "/", sel: '[data-tour="home-hero"]',
    title: ({ lens }) => (lens.profile ? "Home, arranged for you" : "Start here"),
    body: ({ lens }) => ({
      fantasy: "The front door opens on your fantasy week: your lineup, the best plays at your positions, and whose role is growing. The logo in the top corner always brings you back.",
      betting: "The front door opens on the lines: what moved, where one book disagrees with the rest, and this week's spreads and totals. The logo in the top corner always brings you back.",
      learn: "The front door opens on this week's games and a search for anything. The logo in the top corner always brings you back.",
      default: "The front door: a search for anything with a page, a row of places to start, and this week's games underneath. The logo in the top corner always brings you back.",
    }[lens.mode]),
  },
  search: {
    chapter: "Home", where: () => "/", sel: '[data-tour="home-search"]',
    title: "One box for anyone",
    body: ({ mobile }) => <>Every player since 1999, all 32 teams and every head coach. Pick one and their page opens. {mobile ? "The magnifier at the top of the screen does the same from any page." : "The box in the top bar finds players from any page."}</>,
  },
  brief: {
    chapter: "Home", where: () => "/", sel: '[data-tour="home-brief"]',
    title: ({ lens }) => (lens.profile ? "Your week, in a few lines" : "Make it yours"),
    body: ({ lens }) => lens.profile
      ? <>Read off this week's numbers {lens.mode === "fantasy" ? "and your roster" : lens.mode === "betting" ? "and the board" : "and the schedule"}, not written by hand{lens.profile.team ? ", with your team's game at the bottom" : ""}. The links underneath change your answers or switch to the standard layout.</>
      : <>Say whether you are here for fantasy, betting or just following along, and every page rearranges: what comes first, which tabs are up front, even the words. It takes under a minute and you can switch it off again.</>,
  },
  nav: {
    chapter: "Getting around", sel: '[data-tour="nav"]',
    title: ({ mobile }) => (mobile ? "Your sections, under your thumb" : "The tabs"),
    body: ({ mobile, lens }) => mobile
      ? <>The {lens.profile ? "four sections you reach for most" : "main sections"} sit along the bottom. More holds the rest, Settings included. Each one remembers the player, game or team you left it on, and tapping the one you are already in scrolls back to the top.</>
      : <>{lens.profile ? "In the order you reach for them. Anything outside your interests waits under More rather than disappearing." : "Every section of the site."} Each tab remembers the player, game or team you left it on, so wandering off and coming back loses nothing.</>,
  },
  "fantasy-table": {
    chapter: "Fantasy", icon: "/fantasy", where: () => "/fantasy", sel: '[data-tour="fantasy-table"]',
    title: ({ lens }) => (lens.ceiling ? "Every starter, ranked by ceiling" : "Every starter, ranked"),
    body: ({ lens, mobile }) => <>
      Projected {SCORING_LABEL[lens.profile?.scoring ?? "ppr"]} points for everyone playing this week, with a floor for a bad week and a ceiling for a good one. Beside each: how generous the defense is to the position, the points their team is expected to score, and whether their role is growing.
      {" "}{mobile ? "Tap" : "Click"} a row for their game-by-game points, or the + to line up to four players side by side for start or sit.
    </>,
  },
  "fantasy-team": {
    chapter: "Fantasy", icon: "/fantasy", where: () => "/fantasy", sel: '[data-tour="fantasy-views"]',
    title: "Your own team",
    body: () => <>Add your roster once under My team and the site sets the best lineup for the week by projection, benches anyone hurt or on bye, and points out the close calls. Home picks it up too.</>,
  },
  "board-table": {
    chapter: "Lines board", icon: "/board", where: () => "/board", sel: '[data-tour="board-table"]',
    ifEmpty: "No lines have been pulled for this week yet, so the board is empty. Settings has a free source that takes about ten seconds.",
    title: "Every prop, every book",
    body: ({ mobile }) => <>Each row is one prop and each column one sportsbook. A green or red cell is a book offering a noticeably different number from the rest, so you are not hunting for it. The filters above narrow it by player, team, market or book. {mobile ? "Tap" : "Click"} a row to open the player.</>,
  },
  "research-player": {
    chapter: "Player pages", icon: "/research", needsCast: true, where: research, sel: '[data-tour="research-player"]',
    ifEmpty: "Nobody could be opened automatically, so this is the empty page. Search a name and it fills in.",
    title: "Opening a player",
    body: ({ c }) => <>
      Here is {HIM(c)}{c.fromRoster ? ", off your roster," : ""} opened the same way a search or a click on any row would open him.
      {c.fromRoster ? "" : c.fromLines ? " He has a line posted this week, which the rest of the page is measured against." : " No lines have been pulled yet, so this is one of last season's leading scorers instead."}
    </>,
  },
  "research-chart": {
    chapter: "Player pages", icon: "/research", needsCast: true, where: research, sel: '[data-tour="research-chart"]',
    title: "Every game, against a number",
    body: ({ c, lens }) => <>
      Each dot is a game {HIM(c)} has played, and the flat line across it is {lens.mode === "fantasy" ? "a benchmark you can move" : lens.betting ? "this week's line" : "a benchmark you can move"}. Green cleared it, red did not.
      {" "}Further down: where he ranks at his position, what changes when a teammate sits, {lens.betting ? "where the books disagree, " : ""}and who is hurt.
    </>,
  },
  "matchup-top": {
    chapter: "Matchups", icon: "/matchups", needsCast: true,
    where: ({ c }) => (c.gameId ? `/matchups?game=${c.gameId}` : "/matchups"), sel: '[data-tour="matchup-top"]',
    ifEmpty: "No game could be opened for this week. Pick one from the row of games once a week's schedule is up.",
    title: ({ c }) => (c.favTeam ? "Your team's game" : "Opening a game"),
    body: ({ lens }) => <>Pick a game from the slate and it opens like this: the spread, the total and {lens.betting ? "the model's own call" : "the points each side is expected to score"} at the top, then each offense against the defense it is about to face, who gets the ball, and who is banged up.</>,
  },
  "matchup-sides": {
    chapter: "Matchups", icon: "/matchups", needsCast: true,
    where: ({ c }) => (c.gameId ? `/matchups?game=${c.gameId}` : "/matchups"), sel: '[data-tour="matchup-sides"]',
    title: "Where two habits collide",
    body: () => <>Each offense's tendencies set against what the other defense allows, so a team that loves to throw deep meets a secondary that gives it up, or does not.</>,
  },
  "games-grid": {
    chapter: "Game lines", icon: "/games", where: () => "/games", sel: '[data-tour="games-grid"]',
    ifEmpty: "Nothing pulled for this week yet, so there is nothing to show. Settings fills it in.",
    title: "Spreads, totals and moneylines",
    body: () => <>The main game bets across sportsbooks, with the opening number next to the current one so you can see which way a line has moved.</>,
  },
  "team-seasons": {
    chapter: "Teams", icon: "/teams", needsCast: true,
    where: ({ c }) => (c.team ? `/teams?team=${c.team}` : "/teams"), sel: '[data-tour="team-seasons"]',
    ifEmpty: "The team tendency table has not been built on this machine yet, so this page has nothing to draw.",
    title: ({ c }) => (c.favTeam ? "How your team plays" : "How a team actually plays"),
    body: ({ c }) => <>{c.team ?? "A team"} season by season: pass or run, fast or slow, what they do near the end zone and how the defense holds up, each with its league rank beside it. Leave the team blank for all 32 on one measure.</>,
  },
  "coach-profile": {
    chapter: "Coaches", icon: "/coaches", needsCast: true,
    where: ({ c }) => (c.coach ? `/coaches?coach=${encodeURIComponent(c.coach)}&role=HC` : "/coaches"), sel: '[data-tour="coach-profile"]',
    ifEmpty: "No coach could be opened automatically. Pick any name from the list.",
    title: "The people calling it",
    body: ({ c }) => <>The same habits followed by coach instead of team. {c.coach ?? "A coach"} here, every season on record and who got the ball each year. Handy when a team hires someone and you want to know what is about to change.</>,
  },
  predictions: {
    chapter: "Predictions", icon: "/predictions", where: () => "/predictions", sel: '[data-tour="predictions-games"]',
    title: "What the model called",
    body: () => <>Its pick for each game beside the number the books were offering. Every call is written down before kickoff, so nothing here can be quietly improved after the fact.</>,
  },
  results: {
    chapter: "Results", icon: "/results", where: () => "/results", sel: '[data-tour="results-strip"]',
    ifEmpty: "Nothing is graded yet this season: a line can only be checked once its game has been played. The page fills in as the weeks go by.",
    title: "Whether any of it worked",
    body: ({ mobile }) => <>Old lines and old predictions checked against what actually happened. Each tile opens a section: the matchup angles, the hit-rate trends, the sportsbooks, the model. {mobile ? "Tap" : "Click"} any row to see the games behind the number, misses included, which is rather the point.</>,
  },
  settings: {
    chapter: "Settings", icon: "/settings", where: () => "/settings", sel: '[data-tour="settings-pull"]',
    title: "Where fresh lines come from",
    body: () => <>Lines come in here. ESPN is free and needs nothing set up. Your default sportsbook and how far back the history reaches live here too.</>,
  },
  tailor: {
    chapter: "Getting around", sel: ({ mobile }) => (mobile ? '[data-tour="menu"]' : '[data-tour="tailor"]'),
    title: ({ lens }) => (lens.profile ? "Tailored, or the standard site" : "Tailor it any time"),
    body: ({ mobile, lens }) => lens.profile
      ? <>{mobile ? "This menu" : "The Tailor button"} changes your answers, or switches to the standard layout everyone else sees and back again. Your answers are kept either way.{mobile ? " Light and dark live here too." : ""}</>
      : <>{mobile ? "This menu" : "This button"} starts the questions whenever you like.{mobile ? " Light and dark live here too." : ""}</>,
  },
  end: {
    chapter: "Done", sel: ({ mobile }) => (mobile ? '[data-tour="menu"]' : '[data-tour="help"]'),
    title: "That's the tour",
    body: ({ c, mobile, lens }) => <>
      {mobile
        // On a phone the tailoring switch lives in this same menu, so it is
        // said here rather than lighting the same button twice.
        ? <>This menu brings the tour back under <b>Welcome and tour</b>{lens.profile ? <>, and it is where you change your answers or switch between your tailored layout and the standard one</> : null}.</>
        : <>The <b>?</b> up here brings this back whenever you want it.</>}
      {" "}Everything the tour opened is still loaded, so {c.playerName ? `${c.playerName}'s page` : "the player page"} and the rest are a {mobile ? "tap" : "click"} away.
    </>,
  },
};

/** Which steps each kind of visitor gets, in order. Untailored is a sampler of
 *  all three so nobody is shown only half the site before they have said what
 *  they are here for. */
function recipe(lens: Lens, mobile: boolean): string[] {
  const p = lens.profile;
  const open: Record<Mode, string[]> = {
    fantasy: ["fantasy-table", ...(p?.fantasyFormat === "season" ? ["fantasy-team"] : []), "research-player", "research-chart", "matchup-top"],
    betting: p?.betStyle === "games"
      ? ["games-grid", "matchup-top", "matchup-sides", "board-table", "research-chart", "predictions", "results"]
      : ["board-table", "research-player", "research-chart", ...(p?.betStyle === "both" ? ["games-grid"] : []), "matchup-top", "predictions", "results"],
    learn: ["research-player", "research-chart", "matchup-top", "matchup-sides", "team-seasons", "coach-profile"],
    default: ["research-player", "research-chart", "fantasy-table", "board-table", "matchup-top", "team-seasons", "results"],
  };
  return ["home", "search", "brief", "nav", ...open[lens.mode], ...(p && !mobile ? ["tailor"] : []), "end"];
}

interface Box { top: number; left: number; width: number; height: number }

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const CARD_W = 400;
const GAP = 16;
/** Room the phone's pinned header takes at the top of the screen. */
const PHONE_TOP = 66;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A panel can be several times taller than the window, and a ring drawn
 *  around the whole of it is a ring nobody can see. What gets lit is the part
 *  that is actually on screen, stopping short of wherever the card sits. */
function clip(b: Box, floor: number, cap: number): Box {
  let { top, height } = b;
  if (top < 12) { height += top - 12; top = 12; }
  height = Math.max(36, Math.min(height, cap, floor - top));
  return { ...b, top, height };
}

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
  const lens = useLens();
  const mobile = useMobile();
  const [i, setI] = useState(0);
  const [cast, setCast] = useState<Cast | null>(null);
  // The old target holds its place until the new one has been found, so the
  // ring glides across a page instead of blinking out in between.
  const [box, setBox] = useState<Box | null>(null);
  const [lit, setLit] = useState(false);
  const [cardH, setCardH] = useState(220);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const scrolled = useRef(-1);
  const nav = useNavigate();
  const loc = useLocation();
  // Steps on a page the profile moved behind "More" are dropped: a fantasy
  // player does not need the lines board explained. Fixed for the length of
  // the tour, so the count does not shift under the reader.
  const [STEPS] = useState(() => recipe(lens, mobile).map((k) => LIB[k]).filter((s) => {
    const path = s.icon;
    const tab = TABS.find((t) => t.path === path);
    return !tab || lens.shows(`tab:${tab.path}`, tab.tags);
  }));
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const ctx: Ctx = { c: cast ?? EMPTY_CAST, lens, mobile };
  const sel = step.sel ? (typeof step.sel === "string" ? step.sel : step.sel(ctx)) : null;

  const next = () => (last ? onDone() : setI((n) => Math.min(STEPS.length - 1, n + 1)));
  const back = () => setI((n) => Math.max(0, n - 1));

  // One pass at the start finds a player, game, team and coach worth opening,
  // the visitor's own where they have told us. It runs while the home steps are
  // being read, so by the time the tour opens a player it is already there.
  useEffect(() => {
    if (!meta) return;
    let live = true;
    const prefer = { team: lens.profile?.team ?? null, roster: lens.fantasy ? readSticky<RosterEntry[]>("fantasy.roster", []) : [] };
    buildCast(meta, settings, prefer).then((c) => live && setCast(c)).catch(() => live && setCast(EMPTY_CAST));
    return () => { live = false; };
  }, [meta]);

  const held = step.needsCast && !cast;
  const want = held ? null : step.where?.(ctx) ?? null;

  // The route changes first: the element a step points at does not exist until
  // its page is mounted and its data has landed.
  useEffect(() => {
    if (want && needsNav(want, loc.pathname, loc.search)) nav(want);
  }, [want, loc.pathname, loc.search]);

  // Pages arrive from the network and tables settle after they paint, so the
  // target is re-measured for as long as the step is up. One timer covers late
  // content, scrolling and window resizes alike.
  useEffect(() => {
    if (!sel) { setLit(false); return; }
    // Crossing to another page: let the ring go rather than leaving it sitting
    // over whatever has taken the old element's place.
    if (want && loc.pathname !== want.split("?")[0]) setLit(false);
    const tick = () => {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (scrolled.current !== i) {
        scrolled.current = i;
        const fixed = getComputedStyle(el).position === "fixed" || !!el.closest(".topbar, .tabbar");
        // On a phone the card owns the bottom of the screen, so the target is
        // brought up under the header instead of into the middle. Centring a
        // panel taller than the window lands halfway down it, past the part
        // that says what it is, so those go to the top on desktop too.
        if (!fixed) {
          if (mobile || r.height > window.innerHeight - 120) window.scrollTo({ top: window.scrollY + r.top - (mobile ? PHONE_TOP : 84), behavior: "smooth" });
          else el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      const found = { top: r.top, left: r.left, width: r.width, height: r.height };
      setBox((prev) => (same(prev, found) ? prev : found));
      setLit(true);
    };
    tick();
    const timer = window.setInterval(tick, 80);
    return () => window.clearInterval(timer);
  }, [i, sel, want, loc.pathname, mobile]);

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
    if (!gaveUp || lit) return;
    const path = want?.split("?")[0];
    const tab = path && document.querySelector(`[data-tour="nav:${path}"]`);
    if (!tab) { setOnTab(true); return; }
    const r = tab.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    setLit(true);
    setOnTab(true);
  }, [gaveUp, lit, want]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Enter and Space press whatever has focus, and Next is what should have it.
  useEffect(() => { nextRef.current?.focus({ preventScroll: true }); }, [i]);

  // Knowing the card's own height lets it be placed by its top edge in every
  // case, and a single animated property is what makes it slide rather than
  // jump when it flips to the other side of a target.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  // A sideways swipe on the card turns the page, the way a phone expects.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : back)();
  };

  const vh = window.innerHeight, vw = window.innerWidth;
  let place: React.CSSProperties, dock: "top" | "bottom" | null = null;
  let shown: Box | null = null;
  if (mobile) {
    // On a phone the card is a sheet along the bottom, where the thumb is,
    // and moves to the top only when what it describes is down there itself.
    // The stylesheet places it, so the safe areas are its to account for.
    // Targets are scrolled up under the header, so one that still starts in
    // the lower half is fixed down there (the tab bar) and wants the top.
    dock = box && box.top > vh * 0.5 ? "top" : "bottom";
    shown = box ? clip(box, dock === "bottom" ? vh - cardH - 28 : vh - 12, vh) : null;
    place = {};
  } else {
    let top: number, left: number;
    shown = box ? clip(box, vh - 24, vh * 0.55) : null;
    // A wide panel with no room above or below it would end up under the
    // card, so less of it is lit and the card sits beneath what is.
    if (shown && shown.top + shown.height + GAP + cardH > vh - 12 && shown.top - GAP - cardH < 12) {
      const room = vh - 12 - cardH - GAP - shown.top;
      if (room >= 90) shown = { ...shown, height: room };
    }
    const cardW = Math.min(CARD_W, vw - 24);
    const target = lit ? shown : null;
    if (target) {
      const below = target.top + target.height + GAP + cardH <= vh - 12;
      top = clamp(below ? target.top + target.height + GAP : target.top - GAP - cardH, 12, vh - cardH - 12);
      left = clamp(target.left + target.width / 2 - cardW / 2, 12, vw - cardW - 12);
    } else {
      top = Math.max(12, (vh - cardH) / 2);
      left = Math.max(12, (vw - cardW) / 2);
    }
    place = { top, left, width: cardW };
  }
  // The ring is kept inside the screen: a bar that runs edge to edge would
  // otherwise lose its sides.
  if (shown) {
    const l = Math.max(shown.left, 8), r = Math.min(shown.left + shown.width, vw - 8);
    const t = Math.max(shown.top, 8), b = Math.min(shown.top + shown.height, vh - 8);
    shown = { top: t, left: l, width: Math.max(0, r - l), height: Math.max(0, b - t) };
  }
  const target = lit ? shown : null;

  const waiting = !!sel && !lit;
  const pad = 6;
  const Icon = step.icon ? ICONS[step.icon] : null;
  const empty = onTab && step.ifEmpty;
  return (
    <div className={`tour ${mobile ? "phone" : ""}`} role="dialog" aria-modal="true" aria-label="Guided tour">
      <div className={`tour-veil ${target ? "" : "solid"}`} />
      <div
        className={`tour-ring ${target ? "" : "off"}`}
        style={shown ? { top: shown.top - pad, left: shown.left - pad, width: shown.width + pad * 2, height: shown.height + pad * 2 } : undefined}
      />
      <div ref={cardRef} className={`tour-card ${dock ? `dock-${dock}` : ""}`} style={place} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="tour-top">
          <span className="tour-chapter">{Icon ? <Icon size={15} active /> : <Spark size={14} />}{step.chapter}</span>
          <span className="tour-count">{i + 1} / {STEPS.length}</span>
          <button className="tour-x" aria-label="End the tour" onClick={onDone}><IconClose size={16} /></button>
        </div>
        <div className="tour-progress" aria-hidden="true"><i style={{ transform: `scaleX(${(i + 1) / STEPS.length})` }} /></div>
        <div key={i} className="tour-body" aria-live="polite">
          <h2>{text(step.title, ctx)}</h2>
          <p>{step.body(ctx)}</p>
        </div>
        {empty && <div className="tour-empty">{step.ifEmpty}</div>}
        {waiting && !empty && <div className="tour-wait"><span className="spin" /> {held ? "finding a live example" : "opening it"}…</div>}
        <div className="tour-actions">
          {i === 0
            ? <button className="btn ghost" onClick={onDone}>Skip tour</button>
            : <button className="btn" onClick={back}>Back</button>}
          <div className="spacer" />
          {!mobile && <span className="tour-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></span>}
          <button ref={nextRef} className="btn primary" onClick={next}>{last ? "Finish" : i === 0 ? "Show me" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
