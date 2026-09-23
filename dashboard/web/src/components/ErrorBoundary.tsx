import { Component, ReactNode } from "react";

// Without this, any error while a page draws unmounts the whole app and leaves
// a blank screen with nothing to report. With it, the top bar stays usable,
// the page says what broke, and the message can be copied into a bug report.
// It sits inside the page wrapper that is keyed on the route, so moving to
// another page starts clean.
//
// One case fixes itself: after a deploy, a tab opened earlier can ask for a
// page file whose hashed name no longer exists. A single reload fetches the
// new ones, so that error reloads once instead of showing the message.

const RELOADED = "err.reloaded";
const isStaleChunk = (e: Error) => /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(e.message);

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    if (!isStaleChunk(error)) return;
    try {
      if (!sessionStorage.getItem(RELOADED)) { sessionStorage.setItem(RELOADED, "1"); window.location.reload(); }
    } catch { /* storage blocked: show the message instead */ }
  }

  componentDidMount() {
    try { sessionStorage.removeItem(RELOADED); } catch { /* nothing to clear */ }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel crash">
        <h2>This page hit an error</h2>
        <p className="muted">The rest of the site still works. Reloading usually clears it; if it keeps happening, send this message along with what you clicked:</p>
        <pre className="crash-msg">{error.message}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
          <button className="btn" onClick={() => { window.location.href = "/"; }}>Go home</button>
        </div>
      </div>
    );
  }
}
