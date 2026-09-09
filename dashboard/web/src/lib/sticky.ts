import { useCallback, useState } from "react";
import { freeSpace } from "./cache";

// Page controls (week, filters, sort) are component state, so they reset every
// time a tab is left and come back. These keep them across tab switches,
// refreshes and browser restarts, without touching the saved Settings.

const KEY = "pdui1:";
const mem = new Map<string, unknown>();

export function readSticky<T>(key: string, fallback: T): T {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = window.localStorage.getItem(KEY + key);
    if (raw !== null) { const v = JSON.parse(raw) as T; mem.set(key, v); return v; }
  } catch {}
  return fallback;
}

function write(key: string, v: unknown): void {
  mem.set(key, v);
  const raw = JSON.stringify(v);
  try { window.localStorage.setItem(KEY + key, raw); return; } catch {}
  // Out of room, most likely: the same storage mirrors whole API responses,
  // and a board is megabytes. Dropping one of those to keep a filter is the
  // right trade, and swallowing the failure is not — it leaves the panel to
  // come back on the next visit in a state nobody left it in.
  try { freeSpace(raw.length * 2); window.localStorage.setItem(KEY + key, raw); } catch {}
}

export function writeSticky(key: string, v: unknown): void { write(key, v); }

export function clearSticky(key: string): void {
  mem.delete(key);
  try { window.localStorage.removeItem(KEY + key); } catch {}
}

export function useSticky<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(() => readSticky(key, initial));
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setV((prev) => { const n = typeof next === "function" ? (next as (p: T) => T)(prev) : next; write(key, n); return n; });
  }, [key]);
  return [v, set];
}
