import { useEffect, useState } from "react";
import { useMeta } from "../state";
import { TABS, useLens } from "../lib/profile";
import { useMobile } from "../lib/useMobile";
import { ICONS, IconArrow, IconClose } from "./Icons";
import Spark from "./Spark";

// First load lands here, and the ? in the header brings it back. It has three
// jobs: say in one breath what the site is for, say what the numbers are and
// are not, and hand over to tailoring or the tour without making either a toll
// gate. Someone who has already tailored is offered the tour of their layout
// first; someone who has not is offered the questions first, which lead on into
// the tour.

const FEATURES: { icon: string; title: string; body: string }[] = [
  { icon: "/research", title: "Anyone, every game", body: "Every player since 1999, each game charted against this week's number, with the splits behind it." },
  { icon: "/fantasy", title: "Your fantasy week", body: "Projections with a floor and a ceiling, the matchup, whose role is growing, and your own lineup set for you." },
  { icon: "/board", title: "Lines across books", body: "Props and game lines side by side, with the book that disagrees with the rest coloured in." },
  { icon: "/matchups", title: "Both sides of a game", body: "Each offense against the defense it faces, who gets the ball, and who is hurt." },
];

const NOTES: [string, string][] = [
  ["Not betting advice.", "Nothing here tells you what to bet, and nothing here knows what is going to happen."],
  ["Numbers go stale.", "Lines move by the minute and stats get corrected for days. Check the sportsbook before acting on anything."],
  ["A streak is usually just a streak.", "Ten games is a small sample, and plenty of what looks like a pattern is not one."],
  ["Some lines are stand-ins.", "Until real lines are pulled from Settings, a few pages show sample numbers under an orange banner."],
];

export default function Welcome({ here = "/", onTour, onTailor, onSkip }: { here?: string; onTour: () => void; onTailor: () => void; onSkip: () => void }) {
  const { meta, settings } = useMeta();
  const lens = useLens();
  const mobile = useMobile();
  const tailored = !!lens.profile;
  const hasAnswers = !!settings.profile;
  // The small print folds away on a phone, where it would push the buttons
  // off the first screen, but it is one tap from open and starts open on a
  // desktop.
  const [notes, setNotes] = useState(!mobile);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onSkip(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  // Opened again from a page, the tour starts there, and the button says so.
  const page = TABS.find((t) => t.path === here && t.path !== "/settings");
  const tourSub = page ? `Starts on ${page.label}, then any page you like` : "Every page, a stop at a time. Skip or jump between pages any time";

  return (
    <div className="modal-veil" onClick={onSkip}>
      <div className="modal welcome wl" role="dialog" aria-modal="true" aria-labelledby="wl-title" onClick={(e) => e.stopPropagation()}>
        <button className="wl-x" aria-label="Close" onClick={onSkip}><IconClose size={18} /></button>
        <header className="wl-hero">
          <div className="wl-kicker"><span className="dot" />{meta ? `${meta.season} season · week ${meta.week}` : "Aggregate Analytics"}</div>
          <h1 id="wl-title">{tailored ? <>Welcome back to <em className="mode-word">Aggregate Analytics</em></> : <>Welcome to <em>Aggregate Analytics</em></>}</h1>
          <p className="wl-lede">NFL stats, fantasy projections and sportsbook lines in one place, with the history behind every number. Look up a player, a team, a coach or a single game and see what has actually happened.</p>
        </header>

        <div className="wl-feats">
          {FEATURES.map((f, k) => {
            const Icon = ICONS[f.icon];
            return (
              <div key={f.icon} className="wl-feat" style={{ animationDelay: `${80 + k * 50}ms` }}>
                <span className="wl-feat-icon"><Icon size={20} /></span>
                <div><b>{f.title}</b><span>{f.body}</span></div>
              </div>
            );
          })}
        </div>

        <div className={`wl-notes ${notes ? "open" : ""}`}>
          <button className="wl-notes-head" aria-expanded={notes} onClick={() => setNotes(!notes)}>
            <span>Worth knowing before you read too much into it</span>
            <span className="wl-caret"><IconArrow size={14} /></span>
          </button>
          {notes && (
            <ul>
              {NOTES.map(([b, t]) => <li key={b}><b>{b}</b> {t}</li>)}
              <li className="wl-help"><b>Bet only what you can afford to lose.</b> If it stops being fun, help is free and confidential at <a href="tel:18005224700">1-800-522-4700</a>.</li>
            </ul>
          )}
        </div>

        <div className="wl-actions">
          {tailored ? <>
            <button className="wl-cta" onClick={onTour} autoFocus>
              <span><b>{page ? `Show me around ${page.label}` : "Show me around"}</b><span>{tourSub}</span></span><IconArrow size={18} />
            </button>
            <button className="btn" onClick={onTailor}>Change my answers</button>
          </> : <>
            <button className="wl-cta" onClick={onTailor} autoFocus>
              <Spark size={18} />
              <span><b>{hasAnswers ? "Switch tailoring back on" : "Tailor it to me"}</b><span>{hasAnswers ? "Your answers are kept; check them, then a tour" : "A few quick questions, then a tour of your layout"}</span></span>
              <IconArrow size={18} />
            </button>
            <button className="btn" onClick={onTour}>{page ? `Tour ${page.label}` : "Just show me around"}</button>
          </>}
          <button className="btn ghost" onClick={onSkip}>{mobile ? "Not now" : "Skip for now"}</button>
        </div>
        <div className="wl-foot">{mobile ? "Both live in the ⋮ menu at the top." : "Both live in the top bar: Tailor, and the ? beside it."}</div>
      </div>
    </div>
  );
}
