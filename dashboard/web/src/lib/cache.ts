// One process-wide cache for every GET the dashboard makes.
//
// Two problems this solves. Switching tabs unmounts the page and throws its
// data away, so coming back re-ran the whole query against the parquet store;
// and opening the dashboard started from nothing, which is minutes of waiting
// on a cold API. Entries live in memory for the life of the page and are
// mirrored into localStorage, so the last pull is still on screen when the
// browser is opened again. Anything past its freshness window paints from the
// mirror first and is replaced when the refetch lands.

export interface Entry<T = unknown> { data: T; at: number }

const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<any>>();

// A deploy can change the shape of a response, and a cache that outlives it
// would hand stale shapes to new code. This used to be keyed on the build
// timestamp, which was safe and far too blunt: every deploy emptied every
// visitor's cache, so the next visit refetched the whole site against a host
// that had usually gone to sleep. Most deploys do not touch a single response.
//
// So the key is a version that moves when the *responses* do, not when the
// bundle does.
//
//   BUMP THIS whenever an API response changes shape: a renamed or removed
//   field, a changed type, a different nesting. Adding a field that old code
//   simply ignores does not need it.
//
// Forgetting to bump it after a shape change means a returning visitor paints
// one stale frame from an old shape before the refetch lands, so bump it when
// in doubt: the cost is one slow visit, and the cost of not bumping is a
// render against data that no longer looks like the code expects.
const CACHE_VERSION = "1";
const PREFIX = `pdq.v${CACHE_VERSION}:`;
const MAX_ENTRY = 3_000_000;    // characters; bigger payloads stay memory-only
const MAX_AGE = 7 * 86_400_000;  // a mirrored entry older than this is dropped
const MINUTE = 60_000;

// How long a response counts as fresh. A fresh hit never touches the network,
// so tab switching costs nothing; past it the cached value still paints
// immediately while the refetch runs.
const TTL: [RegExp, number][] = [
  [/^\/api\/players\/[^/]+\/lines/, 5 * MINUTE],
  [/^\/api\/(odds|schedule|predictions|matchups|grading)\b/, 5 * MINUTE],
  [/^\/api\/meta\b/, 10 * MINUTE],
];
const DEFAULT_TTL = 60 * MINUTE;   // historical stats only move on ingest

// What to give up first when the mirror is full. Browsers disagree wildly on
// the localStorage ceiling: measured at 48MB in Chrome, a few MB in Safari. So
// rather than assume one number, mirror everything and let the views that are
// cheapest to rebuild be the first to go. A week of matchups is 3.3MB and the
// API rebuilds one in ~200ms once warm; the board is what the app opens on.
const CHEAP_TO_REBUILD = /^\/api\/matchups\//;
const rank = (url: string) => (CHEAP_TO_REBUILD.test(url) ? 0 : 1);
const ttlFor = (url: string) => TTL.find(([re]) => re.test(url))?.[1] ?? DEFAULT_TTL;

// --- localStorage mirror ----------------------------------------------------
// Values are stored as "<at>|<json>" so eviction can read a timestamp without
// parsing the payload. Every access is guarded: storage can be absent (private
// windows) or full.

function store(): Storage | null {
  try { const s = window.localStorage; s.getItem(PREFIX); return s; } catch { return null; }
}

function readMirror(url: string): Entry | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + url);
    if (!raw) return null;
    const cut = raw.indexOf("|");
    const at = Number(raw.slice(0, cut));
    if (!at || Date.now() - at > MAX_AGE) { s.removeItem(PREFIX + url); return null; }
    return { data: JSON.parse(raw.slice(cut + 1)), at };
  } catch { try { s.removeItem(PREFIX + url); } catch {} return null; }
}

// Mirroring a large board can cost a few milliseconds of JSON, so it waits for
// the browser to be idle rather than blocking the render that just landed.
const queued = new Map<string, Entry>();
let timer: number | null = null;

function mirror(url: string, e: Entry): void {
  if (!store()) return;
  queued.set(url, e);
  if (timer === null) timer = window.setTimeout(flush, 300);
}

function flush(): void {
  timer = null;
  const s = store();
  if (!s) { queued.clear(); return; }
  for (const [url, e] of queued) {
    let raw: string;
    try { raw = `${e.at}|${JSON.stringify(e.data)}`; } catch { continue; }
    if (raw.length > MAX_ENTRY) { try { s.removeItem(PREFIX + url); } catch {} continue; }
    try { s.setItem(PREFIX + url, raw); }
    catch { evict(s, raw.length * 2); try { s.setItem(PREFIX + url, raw); } catch {} }
  }
  queued.clear();
}

/** Make room for `need` characters, cheapest-to-rebuild and oldest first. */
function evict(s: Storage, need: number): void {
  const rows: { k: string; rank: number; at: number; size: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const raw = s.getItem(k) ?? "";
    rows.push({ k, rank: rank(k.slice(PREFIX.length)), at: Number(raw.split("|", 1)[0]) || 0, size: raw.length });
  }
  rows.sort((a, b) => a.rank - b.rank || a.at - b.at);
  let freed = 0;
  for (const r of rows) {
    try { s.removeItem(r.k); } catch {}
    freed += r.size;
    if (freed >= need) return;
  }
}

// Keys carry the version, so a bump would otherwise leave the previous one's
// entries sitting in a 5MB quota forever. This also clears the old
// timestamp-keyed entries from before the version existed.
function sweepOldVersions(): void {
  const s = store();
  if (!s) return;
  const kill: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith("pdq.") && !k.startsWith(PREFIX)) kill.push(k);
  }
  for (const k of kill) { try { s.removeItem(k); } catch {} }
}
sweepOldVersions();

// --- reads ------------------------------------------------------------------

function lookup(url: string): Entry | undefined {
  const hit = mem.get(url);
  if (hit) return hit;
  const m = readMirror(url);
  if (m) { mem.set(url, m); return m; }
  return undefined;
}

/** Whatever is cached for this URL, however old. Synchronous, for first paint. */
export function peek<T>(url: string): T | undefined {
  return lookup(url)?.data as T | undefined;
}

/** True when a cached value exists and is inside its freshness window. */
export function isFresh(url: string): boolean {
  const hit = lookup(url);
  return !!hit && Date.now() - hit.at < ttlFor(url);
}

/** Seed the cache from a response fetched some other way. */
export function prime<T>(url: string, data: T): void {
  const e: Entry<T> = { data, at: Date.now() };
  mem.set(url, e);
  mirror(url, e);
}

/**
 * A fresh hit resolves without touching the network. Otherwise the fetch runs,
 * deduplicated: concurrent callers for the same URL share one request.
 */
export function cached<T>(url: string, fetcher: (url: string) => Promise<T>): Promise<T> {
  if (isFresh(url)) return Promise.resolve(mem.get(url)!.data as T);
  const running = inflight.get(url);
  if (running) return running as Promise<T>;
  const p = fetcher(url)
    .then((d) => { prime(url, d); return d; })
    .finally(() => { if (inflight.get(url) === p) inflight.delete(url); });
  inflight.set(url, p);
  return p;
}

/** Is a request the user is waiting on in flight? Prefetching reads this so it
 *  can stay out of the way; see lib/prefetch.ts. */
export function busy(): boolean {
  return inflight.size > 0;
}

/** Forget everything matching, so the next read refetches. */
export function invalidate(match: RegExp): void {
  for (const url of [...mem.keys()]) if (match.test(url)) mem.delete(url);
  for (const url of [...inflight.keys()]) if (match.test(url)) inflight.delete(url);
  for (const url of [...queued.keys()]) if (match.test(url)) queued.delete(url);
  const s = store();
  if (!s) return;
  const kill: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(PREFIX) && match.test(k.slice(PREFIX.length))) kill.push(k);
  }
  for (const k of kill) { try { s.removeItem(k); } catch {} }
}
