import { api, api2, api3, api4, api5, apiGet, Meta, ScheduleGame } from "../api";
import { isFresh } from "./cache";
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
  window.setTimeout(drain, 500);   // let the current page get its own data first
}

async function drain(): Promise<void> {
  while (queue.length) {
    const url = queue.shift()!;
    if (isFresh(url)) continue;
    // A failure here is not the user's problem: they never asked for this page.
    // Whatever fails is simply fetched again when the page is opened.
    try { await apiGet(url); } catch {}
  }
  draining = false;
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
  urls.push(api.schedule.url(meta.season, week("matchups.week")));
  urls.push(api.games.url(undefined, week("games.week"), settings.includeSample));

  const player = lastParam("/research", "player");
  if (player) urls.push(api.player.url(player), api.gamelog.url(player, settings.since), api.playerLines.url(player, undefined, undefined, settings.includeSample));

  const game = lastParam("/matchups", "game");
  if (game) urls.push(api4.gameMatchup.url(game, settings.includeSample));

  const team = lastParam("/teams", "team");
  if (team) urls.push(api2.teamTendencies.url(team, readSticky("teams.since", 2012)));
  const leagueSeason = readSticky<number | null>("teams.leagueSeason", null) ?? meta.season - 1;
  urls.push(api2.league.url(leagueSeason));
  urls.push(api3.dvp.url("ALL", readSticky("dvp.pos", "RB"), leagueSeason));   // the table under the Teams page

  urls.push(api2.coaches.url());
  const coach = lastParam("/coaches", "coach");
  if (coach) urls.push(api2.coach.url(coach), api3.coachUsage.url(coach));

  urls.push(api.predictions.url(undefined, week("predictions.week")));
  urls.push(api5.gradeSummary.url(readSticky<number | null>("results.season", null) ?? undefined));
  urls.push(api.status.url());

  warm(urls);

  // Every game on the slate, so picking one is a render rather than a two
  // second wait. The schedule has to land first, since it is what says which
  // games exist; the request below is the same one already queued above, so it
  // attaches to that rather than making a second.
  const matchupWeek = week("matchups.week");
  apiGet<ScheduleGame[]>(api.schedule.url(meta.season, matchupWeek))
    .then((games) => warm(games.map((g) => api4.gameMatchup.url(g.game_id, settings.includeSample))))
    .catch(() => {});
}
