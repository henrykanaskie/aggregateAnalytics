import { useEffect, useState } from "react";

// The same width the stylesheet switches at, so a component that renders
// something different on a phone never disagrees with the CSS around it.
export const PHONE = "(max-width: 760px)";

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [query]);
  return on;
}

export const useMobile = () => useMedia(PHONE);
