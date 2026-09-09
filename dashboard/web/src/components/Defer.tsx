import { useEffect, useRef, useState } from "react";

/** Render children only once they are near the viewport.
 *
 * Opening one player fired 166 requests, and the heaviest of them belong to
 * panels well below the fold: splits (338ms), correlations (205ms), the peer
 * scatter (133ms), teammates (111ms). On a host with a fraction of a CPU those
 * queue up behind the three the page actually needs to paint, so the answer to
 * "why is this slow" was work nobody had scrolled to yet.
 *
 * Mounting is what starts a panel's fetch, so not mounting it is the whole
 * mechanism. `rootMargin` gives it a screen of warning, which is enough to
 * have loaded by the time it is scrolled into view.
 */
export default function Defer({ children, minHeight = 160, rootMargin = "600px", delay = 1200, when = true }:
  { children: React.ReactNode; minHeight?: number; rootMargin?: string; delay?: number; when?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  // `when` false holds the panel back even in view and even past the timer:
  // a research page fires sixteen requests at once, and on a small host the
  // three it needs to paint were queuing behind the heavy ones below. The
  // page passes "the game log is in", so those start once there is a page.
  useEffect(() => {
    if (shown || !when) return;
    const el = ref.current;
    // Scrolling to it is the fast path, not the only path. An observer that
    // never fires -- no IntersectionObserver, a tab rendered offscreen, a panel
    // that simply sits below a short page -- would leave the panel permanently
    // blank, which is a worse bug than the slow load this exists to fix. So a
    // timer loads it anyway, once the requests the page needs to paint have
    // had the floor to themselves.
    const timer = window.setTimeout(() => setShown(true), delay);
    if (!el || typeof IntersectionObserver === "undefined") {
      return () => window.clearTimeout(timer);
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); };
  }, [shown, rootMargin, delay, when]);

  return <div ref={ref} style={shown ? undefined : { minHeight }}>{shown ? children : null}</div>;
}
