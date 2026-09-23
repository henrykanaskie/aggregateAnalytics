import React from "react";

// Line icons for the phone navigation, drawn on one 24px grid with one stroke
// weight so they read as a set. They take the text colour, so a lit tab and a
// dim one differ by colour alone.
const I = ({ children, size = 22 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  "/research": (p) => <I {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 20 20" /><path d="M7.5 12.5l2-2.5 1.8 1.6 2.2-3" /></I>,
  "/fantasy": (p) => <I {...p}><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" /><path d="M12 13v4M9 20h6M10 17h4" /></I>,
  "/board": (p) => <I {...p}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 9h17M3.5 14.5h17M9.5 9v11" /></I>,
  "/matchups": (p) => <I {...p}><path d="M5 5l6 6M5 11l6-6" /><path d="M13 13l6 6M13 19l6-6" /><circle cx="17.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /></I>,
  "/games": (p) => <I {...p}><ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-45 12 12)" /><path d="M9.5 14.5l5-5M10.5 11l2.5 2.5M12 9.5l2.5 2.5" /></I>,
  "/teams": (p) => <I {...p}><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6L12 3Z" /><path d="M9 12l2 2 4-4" /></I>,
  "/coaches": (p) => <I {...p}><rect x="5" y="4.5" width="14" height="16" rx="2" /><path d="M9 4.5V3.5h6v1" /><path d="M8.5 10h7M8.5 13.5h7M8.5 17h4" /></I>,
  "/predictions": (p) => <I {...p}><path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" /><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" /></I>,
  "/results": (p) => <I {...p}><circle cx="12" cy="12" r="8.5" /><path d="M8.2 12.2l2.6 2.6 5-5.3" /></I>,
  "/settings": (p) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></I>,
};

export const IconSearch = (p: { size?: number }) => <I {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></I>;
export const IconMore = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.8" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" /></I>;
export const IconMenu = (p: { size?: number }) => <I {...p}><circle cx="12" cy="5.5" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="18.5" r="1.3" fill="currentColor" /></I>;
export const IconSun = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></I>;
export const IconMoon = (p: { size?: number }) => <I {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></I>;
export const IconSliders = (p: { size?: number }) => <I {...p}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></I>;
export const IconHelp = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></I>;
export const IconClose = (p: { size?: number }) => <I {...p}><path d="M6 6l12 12M18 6L6 18" /></I>;
export const IconChevron = (p: { size?: number }) => <I {...p}><path d="M8 10l4 4 4-4" /></I>;
export const IconArrow = (p: { size?: number }) => <I {...p}><path d="M9 6l6 6-6 6" /></I>;
