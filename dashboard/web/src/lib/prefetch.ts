import { api, api2, api3, api4, api5, apiGet, Meta, ScheduleGame } from "../api";
import { busy, isFresh } from "./cache";
import { readSticky } from "./sticky";
import type { Settings } from "../state";

// Warming the cache at startup so a tab is already loaded by the time it is
// opened. The queue is drained one request at a time: these endpoints scan
// parquet, and firing fifteen at once would starve the page the user is
// actually looking at.

const queue: string[] = [];
let draining = false;

export function warm(urls: (string | null)[]): void {
  for (const u of urls) if (u && !isFresh(u) && !queue.includes(u)) queue.push(u);
  if (draining || !queue.length) return;
  draining = true;
  window.setTimeout(drain, 500);
}

/** Wait until nothing the user asked for is in flight.
 *
 *  This queue used to start on a flat timer, which meant twenty-odd background
 *  requests began while the board the visitor was actually staring at was
 *  still being built. On one small container that is the same CPU three times
 *  over, and the page they wanted came last. The drain now yields to every
 *  real request: by the time this is checked the previous prefetch has already
 *  resolved, so anything still in flight is a page waiting to paint. */
function whenFree(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (busy() ? window.setTimeout(check, 200) : resolve());
    check();
  });
}

async function drain(): Promise<void> {
  while (queue.length) {
    await whenFree();
    const url = queue.shift()!;
    if (isFresh(url)) continue;
    // A failure here is not the user's problem: they never asked for this page.
    // Whatever fails is simply fetched again when the page is opened.
    try { await apiGet(url); } catch {}
  }
  draining = false;
}

/** A game id is `<season>_<week>_<away>_<home>`, so it says on its face
 *  whether it belongs to the week being played. */
function isLive(gameId: string, meta: Meta): boolean {
  const [season, wk] = gameId.split("_");
  return Number(season) === meta.season && Number(wk) === meta.week;
}

// The query string is where each page keeps what it is showing, and the nav
// remembers it, so the last coach / team / game / player gets warmed too.
function lastParam(section: string, key: string): string | null {
  const last = readSticky<Record<string, string>>("nav.last", {});
  const raw = last[section];
  if (!raw) return null;
  return new URLSearchParams(raw.split("?")[1] ?? "").get(key);
}

/** Every view the user can reach in one click, in the order they are likely to want them. */
export function warmAll(meta: Meta, settings: Settings): void {
  const urls: (string | null)[] = [];
  const week = (key: string) => readSticky<number | null>(key, null) ?? meta.week;

  urls.push(api.board.url({ week: week("board.week"), include_sample: settings.includeSample, scale: readSticky("board.scale", settings.thresholdScale) }));
  // The schedule the tab will render, plus this week's if it was left on an
  // earlier one. Both are cheap; it is the games behind them that are not.
  urls.push(api.schedule.url(meta.season, week("matchups.week")));
  urls.push(api.schedule.url(meta.season, meta.week));
  urls.push(api.games.url(undefined, week("games.week"), settings.includeSample));

  const player = lastParam("/research", "player");
  if (player) urls.push(api.player.url(player), api.gamelog.url(player, settings.since), api.playerLines.url(player, undefined, undefined, settings.includeSample));

  const game = lastParam("/matchups", "game");
  if (game && isLive(game, meta)) urls.push(api4.gameMatchup.url(game, settings.includeSample));

  const team = lastParam("/teams", "team");
  if (team) urls.push(api2.teamTendencies.url(team, readSticky("teams.since", 2012)));
  const leagueSeason = readSticky<number | null>("teams.leagueSeason", null) ?? meta.season - 1;
  urls.push(api2.league.url(leagueSeason));
  urls.push(api3.dvp.url("ALL", readSticky("dvp.pos", "RB"), leagueSeason));   // the table under the Teams page

  // The tab remembers which role it was left on, so warm that list rather than
  // always the head coaches.
  const role = lastParam("/coaches", "role") ?? "HC";
  urls.push(api2.coaches.url(role));
  const coach = lastParam("/coaches", "coach");
  if (coach) urls.push(api2.coach.url(coach, role), role === "DC" ? null : api3.coachUsage.url(coach, role));

  urls.push(api.predictions.url(undefined, week("predictions.week")));
  urls.push(api5.gradeSummary.url(readSticky<number | null>("results.season", null) ?? undefined));
  urls.push(api.status.url());

  warm(urls);

  // This week's games, so picking one off the live slate is a render rather
  // than a wait. Only this week's: an earlier week is played and settled, and
  // warming those sixteen is sixteen requests nobody asked for, ahead of the
  // ones they did. Opening an old game still loads it, on the click.
  // The schedule has to land first, since it is what says which games exist;
  // it is queued above too, so this attaches rather than making a second.
  apiGet<ScheduleGame[]>(api.schedule.url(meta.season, meta.week))
    .then((games) => warm(games.map((g) => api4.gameMatchup.url(g.game_id, settings.includeSample))))
    .catch(() => {});
}
