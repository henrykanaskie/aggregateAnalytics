import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// A step points at one thing on one page. The route is switched first, then the
// element is looked for; a step whose target never turns up falls back to a
// centred card rather than dropping out of the tour.
interface Step {
  path?: string;
  sel?: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    path: "/board",
    sel: '[data-tour="brand"]',
    title: "Everything is set to one week",
    body: "The season and week you are looking at show up here. Every page opens on it, and you can move to another week wherever you see a week picker.",
  },
  {
    sel: '[data-tour="nav"]',
    title: "The tabs are the whole app",
    body: "Nine sections, and each one stays where you left it. Wander off to the board and come back, and the player, team or game you were on is still up.",
  },
  {
    sel: '[data-tour="search"]',
    title: "Look up anyone",
    body: "Type a name here to jump straight to that player. Anyone who has played since 1999 is in here, not only this week's starters.",
  },
  {
    path: "/board",
    sel: '[data-tour="board-filters"]',
    title: "Narrowing down the board",
    body: "Filter by week, player, position, team or sportsbook, and pick the kinds of props you care about. Sensitivity decides how far off a book has to be before it gets flagged.",
  },
  {
    path: "/board",
    sel: '[data-tour="board-table"]',
    title: "Reading the board",
    body: "Each row is one prop, each column is one sportsbook. A green or red cell means that book is offering a noticeably different number than the rest. Click any row to dig into the player.",
  },
  {
    path: "/research",
    sel: '[data-tour="nav:/research"]',
    title: "One player, every game",
    body: "The big chart is every game a player has played, with this week's line drawn across it, so you can see how often they have cleared it and who they did it against. Around it: how they stack up at their position, what changes when a teammate sits, where the sportsbooks disagree, and who is hurt.",
  },
  {
    path: "/matchups",
    sel: '[data-tour="nav:/matchups"]',
    title: "One game, both sides",
    body: "Pick a game and see how each offense holds up against the other defense, who gets the ball, who is banged up, how these two have gone in the past, and every prop posted for it.",
  },
  {
    path: "/games",
    sel: '[data-tour="nav:/games"]',
    title: "Spreads, totals and moneylines",
    body: "The main game bets across sportsbooks, with the opening number sitting next to the current one so you can see which way a line has moved.",
  },
  {
    path: "/teams",
    sel: '[data-tour="nav:/teams"]',
    title: "How teams actually play",
    body: "Whether they throw or run, play fast or slow, what they do near the end zone and how they hold up on defense, ranked against the rest of the league. Pick one team for its history, or compare all 32 on a single thing.",
  },
  {
    path: "/coaches",
    sel: '[data-tour="nav:/coaches"]',
    title: "The people calling it",
    body: "The same habits, followed by coach rather than by team, plus who they fed the ball to each year. Useful when a team hires someone new and the roster is the only thing that stayed put.",
  },
  {
    path: "/predictions",
    sel: '[data-tour="nav:/predictions"]',
    title: "What the model called",
    body: "Its pick for each game next to the number the sportsbooks were offering. Every call is written down before kickoff, so nothing here can be quietly improved after the fact.",
  },
  {
    path: "/results",
    sel: '[data-tour="nav:/results"]',
    title: "Whether any of it worked",
    body: "Old lines and old predictions checked against what actually happened. Which books were soft, whether the trends meant anything, and how the model did. The misses are in here too, which is rather the point.",
  },
  {
    path: "/settings",
    sel: '[data-tour="nav:/settings"]',
    title: "Where fresh numbers come from",
    body: "Lines come in here. ESPN is free and needs nothing set up; the other source needs a key and gets you more sportsbooks. Your default sportsbook and how far back the history reaches are set here too.",
  },
  {
    title: "That is the tour",
    body: "The ? up in the header brings all of this back whenever you want it. Nothing you passed through just now was changed.",
  },
];

interface Box { top: number; left: number; width: number; height: number }

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const CARD_W = 380;
const GAP = 16;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export default function Tour({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  // The old target stays put until the new one has been found, so the ring
  // glides from one to the next instead of blinking out in between.
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

  // The route has to change first: the element a step points at does not exist
  // until its page is mounted.
  useEffect(() => {
    if (step.path && loc.pathname !== step.path) nav(step.path);
  }, [i, step.path, loc.pathname]);

  // Pages arrive from the network and tables settle after they paint, so the
  // target is re-measured for as long as the step is up. One timer covers late
  // content, scrolling and window resizes alike.
  useEffect(() => {
    if (!step.sel) { setLit(false); return; }
    const tick = () => {
      const el = document.querySelector(step.sel!);
      if (!el) return;
      if (scrolled.current !== i) { scrolled.current = i; el.scrollIntoView({ block: "center", behavior: "smooth" }); }
      const r = el.getBoundingClientRect();
      const found = { top: r.top, left: r.left, width: r.width, height: r.height };
      setBox((prev) => (same(prev, found) ? prev : found));
      setLit(true);
    };
    tick();
    const timer = window.setInterval(tick, 80);
    // A page that never renders the target should not leave the ring sitting on
    // the last step's element.
    const giveUp = window.setTimeout(() => { if (!document.querySelector(step.sel!)) setLit(false); }, 1500);
    return () => { window.clearInterval(timer); window.clearTimeout(giveUp); };
  }, [i, step.sel]);

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

  const target = lit ? box : null;
  let top: number, left: number;
  if (target) {
    const below = target.top + target.height + GAP + cardH < window.innerHeight - 12;
    top = below ? target.top + target.height + GAP : target.top - GAP - cardH;
    top = clamp(top, 12, window.innerHeight - cardH - 12);
    left = clamp(target.left + target.width / 2 - CARD_W / 2, 12, window.innerWidth - CARD_W - 12);
  } else {
    top = Math.max(12, (window.innerHeight - cardH) / 2);
    left = Math.max(12, (window.innerWidth - CARD_W) / 2);
  }

  const pad = 6;
  return (
    <div className="tour" role="dialog" aria-label="Guided tour">
      <div className={`tour-veil ${target ? "" : "solid"}`} />
      <div
        className={`tour-ring ${target ? "" : "off"}`}
        style={box ? { top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 } : undefined}
      />
      <div ref={cardRef} className="tour-card" style={{ top, left, width: CARD_W }}>
        <div key={i} className="tour-body">
          <div className="tour-step">Step {i + 1} of {STEPS.length}</div>
          <h2>{step.title}</h2>
          <p>{step.body}</p>
        </div>
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
