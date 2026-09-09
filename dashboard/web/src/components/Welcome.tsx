import { useEffect } from "react";

// First load lands here. Two things it has to do: say what the numbers on the
// other side are and are not, and offer the tour without making it a toll gate.
export default function Welcome({ onTour, onSkip }: { onTour: () => void; onSkip: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onSkip(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div className="modal-veil" onClick={onSkip}>
      <div className="modal welcome" role="dialog" aria-modal="true" aria-label="Welcome" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-head">
          <div className="brand"><span className="dot" /></div>
          <div>
            <h1>Welcome to Aggregate Analytics</h1>
            <p className="muted">Every NFL player prop on one screen, with the history sitting right behind each number. Look up a player, a team, a coach or a single game, and see what has actually happened the last few hundred times.</p>
          </div>
        </div>

        <div className="welcome-notes">
          <div className="note">
            <h3>Every line, side by side</h3>
            <p>The board lays this week's props out across sportsbooks at once. When one book is offering a number the others are not, it gets coloured in, so you are not hunting for it.</p>
          </div>
          <div className="note">
            <h3>The story behind a number</h3>
            <p>Click a player and you get every game they have played, with the line drawn across it. How often they cleared it, who they did it against, and what changes when a teammate sits out.</p>
          </div>
          <div className="note">
            <h3>Stand-in numbers at first</h3>
            <p>Until real lines are fetched from Settings, the pages fill in with placeholder numbers so nothing is blank. An orange banner appears anywhere that is what you are looking at.</p>
          </div>
        </div>

        <div className="welcome-disc">
          <h3>Worth knowing before you read too much into it</h3>
          <ul>
            <li><b>This is not betting advice.</b> Nothing here is telling you what to bet, and nothing here knows what is going to happen.</li>
            <li><b>Numbers go out of date.</b> Lines move by the minute and stats get corrected for days after a game. Check the sportsbook itself before acting on anything you see here.</li>
            <li><b>A hot streak is usually just a streak.</b> Ten games is a small number of games. Plenty of what looks like a pattern on these pages is not one.</li>
            <li><b>Bet only what you can afford to lose.</b> If it stops being fun, help is free and confidential at 1-800-522-4700.</li>
          </ul>
        </div>

        <div className="welcome-actions">
          <button className="btn primary" onClick={onTour}>Show me around</button>
          <button className="btn ghost" onClick={onSkip}>Skip for now</button>
          <span className="hint">The tour takes about a minute. The <b>?</b> in the header brings it back any time.</span>
        </div>
      </div>
    </div>
  );
}
