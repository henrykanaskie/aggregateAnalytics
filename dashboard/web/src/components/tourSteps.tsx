import type { Cast } from "../lib/tourcast";
import { Lens, SCORING_LABEL, TABS } from "../lib/profile";

// What the tour says, page by page. Each page is a chapter: it opens with an
// overview of everything on the page, then stops on the parts that matter
// most. Which chapters a visitor gets, and in what order, follows their
// profile: the tabs they see, in the order they see them. Tour.tsx is the
// machinery that walks these.

export interface Ctx { c: Cast; lens: Lens; mobile: boolean }

export interface Step {
  where?: (x: Ctx) => string | null;
  /** What to light up. A function when the phone and desktop differ. */
  sel?: string | ((x: Ctx) => string);
  title: string | ((x: Ctx) => string);
  body: (x: Ctx) => React.ReactNode;
  /** Steps that are pointless until the cast is known wait for it. */
  needsCast?: boolean;
  /** Said instead of nothing when the page turns out to have no data to show. */
  ifEmpty?: string;
  /** A panel that may not be on the page (tucked under More, a finished game
   *  only, nothing to show): skipped quietly when it never turns up. */
  optional?: boolean;
  /** Left out entirely for profiles it does not apply to. */
  when?: (x: Omit<Ctx, "c">) => boolean;
  /** Put the page in the state the step describes (a tab, a view). Returns
   *  false while the control it needs is not there yet, and is retried. */
  prep?: () => boolean;
}

export interface Chapter { key: string; label: string; path?: string; steps: Step[] }

const HIM = (c: Cast) => c.playerName ?? "this player";
const tap = (m: boolean) => (m ? "Tap" : "Click");
const List = ({ items }: { items: React.ReactNode[] }) => <ul className="tour-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;

const research = ({ c, lens }: Ctx) =>
  !c.playerId ? "/research"
    // A fantasy page charts fantasy points; everyone else gets the line.
    : lens.mode === "fantasy" ? `/research?player=${c.playerId}&stat=${lens.fantasyKey}`
    : `/research?player=${c.playerId}${c.market ? `&market=${c.market}` : ""}`;
const game = ({ c }: Ctx) => (c.gameId ? `/matchups?game=${c.gameId}` : "/matchups");
const team = ({ c }: Ctx) => (c.team ? `/teams?team=${c.team}` : "/teams");
const coach = ({ c }: Ctx) => (c.coach ? `/coaches?coach=${encodeURIComponent(c.coach)}&role=HC` : "/coaches");
/** Press a tab-like button unless it is already the pressed one. */
const press = (sel: string, on: (el: Element) => boolean) => () => {
  const el = document.querySelector(sel);
  if (!el) return false;
  if (!on(el)) (el as HTMLElement).click();
  return true;
};
const fantasyView = (k: 1 | 2) => () => {
  const sw = document.querySelector('[data-tour="fantasy-views"]');
  // No switch at all: a best ball or DFS profile has no lineup to set.
  if (!sw) return !!document.querySelector('[data-tour="fantasy-table"], [data-tour="fantasy-myteam"]');
  return press(`[data-tour="fantasy-views"] button:nth-child(${k})`, (el) => el.classList.contains("on"))();
};

const HOME: Step[] = [
  {
    where: () => "/", sel: '[data-tour="home-hero"]',
    title: ({ lens }) => (lens.profile ? "Home, arranged for you" : "Start here"),
    body: ({ lens }) => ({
      fantasy: "The front door opens on your fantasy week: your lineup, the best plays at your positions, and whose role is growing. The logo in the top corner always brings you back.",
      betting: "The front door opens on the lines: what moved, where one book disagrees with the rest, and this week's spreads and totals. The logo in the top corner always brings you back.",
      learn: "The front door opens on this week's games and a search for anything. The logo in the top corner always brings you back.",
      default: "The front door: a search for anything with a page, places to start, and this week's games underneath. The logo in the top corner always brings you back.",
    }[lens.mode]),
  },
  {
    where: () => "/", sel: '[data-tour="home-search"]',
    title: "One box for anyone",
    body: ({ mobile }) => <>Every player since 1999, all 32 teams and every head coach. Pick one and their page opens. {mobile ? "The magnifier at the top of the screen finds players from any page." : "The box in the top bar finds players from any page."}</>,
  },
  {
    where: () => "/", sel: '[data-tour="home-brief"]',
    title: ({ lens }) => (lens.profile ? "Your week, in a few lines" : "Make it yours"),
    body: ({ lens }) => lens.profile
      ? <>Read off this week's numbers {lens.mode === "fantasy" ? "and your roster" : lens.mode === "betting" ? "and the board" : "and the schedule"}, not written by hand{lens.profile.team ? ", with your team's game at the bottom" : ""}. The links underneath change your answers or switch to the standard layout.</>
      : <>Say whether you are here for fantasy, betting or just following along, and every page rearranges: what comes first, which tabs are up front, even the words. It takes under a minute and you can switch it off again.</>,
  },
  {
    where: () => "/", sel: '[data-tour="home-tiles"]', optional: true,
    title: "Places to start",
    body: () => <>Shortcuts to the pages you are most likely to want first, in the order your profile puts them.</>,
  },
  {
    where: () => "/", sel: '[data-tour="home-cols"]', optional: true,
    title: "The rest of your week",
    body: ({ lens }) => ({
      fantasy: <>Your team (the best lineup from your roster, with anyone hurt or on bye flagged), the top projections at your positions, whose role is growing, your team's game, and the last player and game you opened.</>,
      betting: <>What moved on the board, this week's spreads and totals, the game of the week, the rest of the slate, and the last player and game you opened.</>,
      learn: <>Your team's game, or the week's biggest one, every game on the slate, the top fantasy plays, and the last player, game, team and coach you opened.</>,
      default: <>Every game on the slate, the game of the week, and the last player, game, team and coach you opened, waiting where you left them.</>,
    }[lens.mode]),
  },
];

const AROUND: Step[] = [
  {
    sel: '[data-tour="nav"]',
    title: ({ mobile }) => (mobile ? "Your sections, under your thumb" : "The tabs"),
    body: ({ mobile, lens }) => mobile
      ? <>The {lens.profile ? "four sections you reach for most" : "main sections"} sit along the bottom. More holds the rest, Settings included. Each one remembers the player, game or team you left it on, and tapping the one you are already in scrolls back to the top. The tour goes through each of them next.</>
      : <>{lens.profile ? "In the order you reach for them. Anything outside your interests waits under More rather than disappearing." : "Every section of the site."} Each tab remembers the player, game or team you left it on, so wandering off and coming back loses nothing. The tour goes through each of them next.</>,
  },
];

const RESEARCH: Step[] = [
  {
    needsCast: true, where: research, sel: '[data-tour="research-player"]',
    ifEmpty: "Nobody could be opened automatically, so this is the empty page. Search a name and it fills in.",
    title: "A player's page",
    body: ({ c, lens }) => <>
      Here is {HIM(c)}{c.fromRoster ? ", off your roster" : ""}. Top to bottom, this page is:
      <List items={[
        "who he is and this week's game",
        `what to chart, against which ${lens.words.line}, over which games`,
        "every game on a chart, then hit rates and the full game log",
        `where he ranks at his position, who else gets the ball${lens.betting ? ", and every book's number" : ""}`,
        "this week's matchup and injuries down the side",
      ]} />
      Anything outside your profile waits under More at the bottom.
    </>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-player"] .focus-toggle', optional: true,
    title: "Focus",
    body: () => <>Turns up the numbers that matter for this player and this stat, and dims the rest, across every panel on the page. Handy when a page this long is more than you need.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-markets"]',
    title: "What to chart, and against what",
    body: ({ lens }) => lens.betting
      ? <>This week's props for him sit up top as chips; a <b>!</b> means one book is well off the others. Pick any stat, chart it against the consensus, one book, or a line of your own, and narrow the games: last N, home or away, favorite or underdog, opponent, weather, starting QB, snap share, seasons. Everything below follows.</>
      : <>Pick any stat he has ever recorded and set a {lens.words.line} to measure it against. Game filters narrow what counts: last N, home or away, opponent, weather, starting QB, snap share, seasons. Everything below follows.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-chart"]',
    title: "Every game, against the number",
    body: ({ c, lens, mobile }) => <>Each bar is a game {HIM(c)} played and the dashed line across them is {lens.mode === "fantasy" || !lens.betting ? "your benchmark" : "this week's line"}: green {lens.words.over}, red {lens.words.under}. The solid line is his rolling average over 3, 5 or 10 games. {tap(mobile)} a game to mark it in the game log.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-tiles"]', optional: true,
    title: "How often he clears it",
    body: ({ lens }) => <>The share of games {lens.words.over} the {lens.words.line}: across the games you filtered, the last 5, the last 10 and the latest season, each with its record. Then the average and median, the range, the current streak, and how far the average sits from the {lens.words.line}.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-gamelog"]', optional: true,
    title: "The game log",
    body: () => <>Every game behind the chart, one row each: the opponent, result and score, the spread and total, his quarterback, the weather, and whichever stat columns you add from the chips above it. Sort by any column.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-fantasy"]', optional: true, when: ({ lens }) => lens.fantasy,
    title: "Fantasy snapshot",
    body: ({ lens }) => <>{SCORING_LABEL[lens.profile?.scoring ?? "ppr"]} points per game this season and last, the last five, a floor and a ceiling from his last 16, how often he booms or busts, and how much of it comes from touchdowns. Underneath: whether his snaps, targets and carries are rising or falling.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-books"]', optional: true, when: ({ lens }) => lens.betting,
    title: "Every book, and how the line moved",
    body: ({ mobile }) => <>Each sportsbook's number and price for the prop you picked. {tap(mobile)} one to chart against it instead of the consensus. Below, the line's history across every pull, so you can see which way it has moved.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-peers"]', optional: true,
    title: "Against his position",
    body: ({ c }) => <>{HIM(c)} among everyone at his position this season: the stat you are charting against the volume behind it. Up and to the right is production with the usage to back it; the dashed lines are the position's averages.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-teammates"]', optional: true,
    title: "With and without a teammate",
    body: ({ mobile }) => <>How he does when each teammate plays and when he sits. {tap(mobile)} a count and the whole page filters to just those games, which is the quickest way to see what an injury next to him changes.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-matchup"]', optional: true,
    title: "This week's matchup",
    body: () => <>His team's tendencies against this week's opponent, with a column projecting each number for this game, and what that defense allows to his position. The injury reports for both teams sit right below it.</>,
  },
  {
    needsCast: true, where: research, sel: '[data-tour="research-prediction"]', optional: true, when: ({ lens }) => lens.betting,
    title: "The projection",
    body: () => <>A baseline projection for this stat with its range and the chance of going over, plus anything the model has logged for him. A reference point, not a pick.</>,
  },
];

const FANTASY: Step[] = [
  {
    where: () => "/fantasy", sel: ".page-head",
    title: "The fantasy week",
    body: ({ lens }) => <>
      Everything for setting a lineup, in {SCORING_LABEL[lens.profile?.scoring ?? "ppr"]} scoring:
      <List items={[
        ...(lens.profile?.fantasyFormat && lens.profile.fantasyFormat !== "season" ? [] : ["This week and My team: the rankings, or your own roster"]),
        "filters for position, your roster, team, starters only, and who is hurt",
        "start or sit, up to four players side by side",
        "whose role is growing or shrinking, and the highest-scoring games",
        "every starter ranked, with a floor and a ceiling",
      ]} />
    </>,
  },
  {
    where: () => "/fantasy", sel: '[data-tour="fantasy-table"]', prep: fantasyView(1),
    title: ({ lens }) => (lens.ceiling ? "Every starter, ranked by ceiling" : "Every starter, ranked"),
    body: ({ mobile }) => <>
      Projected points for everyone playing this week, with a floor for a bad week and a ceiling for a good one. Beside each: how generous the defense is to the position, the points their team is expected to score, their last three, and whether their role is growing.
      {" "}{tap(mobile)} a row for their game-by-game points. The <b>+</b> adds a player to start or sit, up to four, and it shows who wins how often across simulated weeks.
    </>,
  },
  {
    where: () => "/fantasy", sel: '[data-tour="fantasy-decks"]', optional: true, prep: fantasyView(1),
    title: "Usage leads points",
    body: () => <>Targets plus carries a game, the last three against the dozen before: roles growing are the pickups, roles shrinking are the players to worry about. The highest totals on the slate are the games most likely to be full of points.</>,
  },
  {
    where: () => "/fantasy", sel: '[data-tour="fantasy-myteam"]', optional: true, prep: fantasyView(2),
    when: ({ lens }) => !lens.profile || !lens.fantasy || lens.profile.fantasyFormat === "season",
    title: "My team",
    body: ({ mobile }) => <>Add your roster once and this sets the best lineup by projection, benches anyone out or on bye, and lists the week's close calls and worries. {tap(mobile)} a starter and then a bench player to swap them, and set your league's lineup slots (or pick a preset) under Lineup at the top of Starters. Home picks it up too.</>,
  },
];

const BOARD: Step[] = [
  {
    where: () => "/board", sel: ".page-head",
    title: "The lines board",
    body: () => <>
      Every player prop posted this week, across sportsbooks:
      <List items={["alerts for lines that moved, books that disagree, and injuries", "filters to narrow it down", "the board itself, one row per prop"]} />
    </>,
  },
  {
    where: () => "/board", sel: '[data-tour="board-alerts"]', optional: true,
    title: "What changed",
    body: ({ mobile }) => <>Lines that moved, books well away from the rest, and injuries that touch a posted prop, biggest first. {tap(mobile)} one to open the player on that prop.</>,
  },
  {
    where: () => "/board", sel: '[data-tour="board-filters"]',
    title: "Narrowing it down",
    body: ({ mobile }) => <>{mobile ? "Folded into this bar until you tap it: " : ""}Week, player, position, teams, games, one book, markets. Sensitivity decides how far off a book has to be before it is flagged, and the L10 trend keeps only players who have cleared (or missed) the number most of their last ten.</>,
  },
  {
    where: () => "/board", sel: '[data-tour="board-table"]',
    ifEmpty: "No lines have been pulled for this week yet, so the board is empty. Settings has a free source that takes about ten seconds.",
    title: "Every prop, every book",
    body: ({ mobile }) => <>Each row is one prop: the consensus line, how often he cleared it lately, the projection and chance of the over, then each book's number. A coloured cell is a book noticeably off the rest. {mobile ? "Switch between cards and the table at the top; tap" : "Click"} a row to open the player.</>,
  },
];

const MATCHUPS: Step[] = [
  {
    needsCast: true, where: game, sel: ".page-head",
    title: "One game, both sides",
    body: ({ lens }) => <>
      Pick a game and it opens here. Top to bottom:
      <List items={[
        `the ${lens.betting ? "lines and the model's call" : "expected score"}, the venue and the weather`,
        "angles: where one side's habits collide with the other's",
        "each offense's tendencies, what the defense allows, and who gets the ball",
        `${lens.betting ? "every prop posted, " : ""}past meetings and injury reports`,
      ]} />
      Once a game is played, how the angles did goes on top.
    </>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-picker"]',
    title: "Picking a game",
    body: ({ c }) => <>Any week, any game on its slate. {c.favTeam ? "Your team's game opens on its own when you arrive with nothing picked." : "The game you left open stays open when you come back."}</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-top"]',
    ifEmpty: "No game could be opened for this week. Pick one from the row of games once a week's schedule is up.",
    title: ({ c }) => (c.favTeam ? "Your team's game" : "The game at a glance"),
    body: ({ lens }) => lens.betting
      ? <>The spread, total and moneyline with where they opened, the points each side is implied to score, and the model's own call with its edge on the spread. Above them: kickoff, the stadium, the surface and the weather.</>
      : <>The total and the points each side is expected to score (more points, more fantasy points), with kickoff, the stadium, the surface and the weather above.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-review"]', optional: true,
    title: "How the calls did",
    body: () => <>A finished game grades every angle it showed before kickoff: called it, missed, or never came up.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-angles"]',
    title: "Angles",
    body: ({ lens }) => <>Where a tendency on one side meets a matching one on the other: a team that throws deep against a defense that gives it up, a run game against a light box. Each says which way it points ({lens.betting ? "lean over or under" : "expect more or less"}), what it is about, and whether it is strong. The chip on the right is how that kind of angle has done this season, graded against what happened.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-player-angles"]', optional: true,
    title: "Player angles",
    body: () => <>The same idea for the key players: each one's own splits, such as against man or zone coverage or against pressure, lined up with what this defense does most. A receiver who beats man coverage against a team that plays a lot of it shows up here.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-tendencies"]',
    title: "How each offense plays",
    body: () => <>Thirty tendencies for the offense: pass rate, pace, personnel, where the targets go, the red zone. <b>Value</b> and <b>Rk</b> are its usual number and league rank. <b>Here</b> projects it for this game, because defenses play some offenses differently. <b>L4</b> is the last four games. The other defense's own tendencies sit alongside when your profile includes them.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-allows"]',
    title: "What the defense gives up",
    body: () => <>Passing, rushing and receiving yards, catches and fantasy points this defense allows a game to each position, with its rank. Green is generous, red is stingy.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-ball"]',
    title: "Who gets the ball",
    body: () => <>Each offense's players by share of the targets and carries, touches and fantasy points a game, with injury tags and anyone new to the team marked. When your profile follows defenders, who covers them is underneath: snap share, targets allowed, yards per target.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-props"]', optional: true, when: ({ lens }) => lens.betting,
    title: "Every prop for the game",
    body: ({ mobile }) => <>Every player prop posted for this game with the consensus line, his hit rate over the last 5, 10 and the season, and how far his average sits from the line. {tap(mobile)} one to open it.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-h2h"]', optional: true,
    title: "Every past meeting",
    body: () => <>Each time these two have played since 1999: the score, how it went against the spread and the total, the quarterbacks, and who starred.</>,
  },
  {
    needsCast: true, where: game, sel: '[data-tour="matchup-injuries"]',
    title: "Injury reports",
    body: () => <>This week's reports for both teams: who is out, doubtful or questionable, and who sat out or was limited in practice.</>,
  },
];

const GAMES: Step[] = [
  {
    where: () => "/games", sel: '[data-tour="games-grid"]',
    ifEmpty: "Nothing pulled for this week yet, so there is nothing to show. Settings fills it in.",
    title: "Spreads, totals and moneylines",
    body: () => <>One card per game: every book's spread, total and moneylines with their prices, the nflverse reference line on top, and the model's call underneath when it has logged one.</>,
  },
];

const TEAMS: Step[] = [
  {
    needsCast: true, where: team, sel: ".page-head",
    title: ({ c }) => (c.favTeam ? "How your team plays" : "How a team plays"),
    body: () => <>
      Every tendency built from play-by-play, so each number is something you could count:
      <List items={["pick a team and a side, offense or defense", "one tendency charted by season and by game", "every season in a table with league ranks", "who got the ball", "the whole league, as a scatter and a table"]} />
    </>,
  },
  {
    needsCast: true, where: team, sel: '[data-tour="team-controls"]',
    title: "Choosing what to look at",
    body: () => <>A team (or none, for the league alone), offense or defense, and the tendency to chart. Each tendency says what it measures right beside the picker.</>,
  },
  {
    needsCast: true, where: team, sel: '[data-tour="team-trend"]', optional: true,
    title: "The staff, and one number over time",
    body: () => <>The head coach and coordinators, each a link to their own page, then the tendency you picked season by season with its rank, and game by game for the last two seasons.</>,
  },
  {
    needsCast: true, where: team, sel: '[data-tour="team-seasons"]',
    ifEmpty: "The team tendency table has not been built on this machine yet, so this page has nothing to draw.",
    title: "Season by season",
    body: ({ c }) => <>{c.team ?? "A team"} across the years: pass or run, fast or slow, personnel, the red zone, how the defense holds up. The small number is the league rank, shaded so good and bad stand out.</>,
  },
  {
    needsCast: true, where: team, sel: '[data-tour="team-shares"]', optional: true,
    title: "Who got the ball",
    body: () => <>How the carries and targets were split this season, or in any single game. The quickest read on a backfield or a receiver room.</>,
  },
  {
    needsCast: true, where: team, sel: '[data-tour="team-scatter"]', optional: true,
    title: "The whole league",
    body: ({ mobile }) => <>Every team on two tendencies at once, then all 32 in a table you can sort by any column. {tap(mobile)} a team in either to open it.</>,
  },
];

const COACHES: Step[] = [
  {
    needsCast: true, where: coach, sel: ".page-head",
    title: "The people calling it",
    body: () => <>
      The same tendencies followed by coach instead of team, for head coaches and coordinators:
      <List items={["pick a role and a name on the left", "his record, teams and seasons", "a fingerprint of what he always does", "who got the ball under him each year", "every season as dots and as a table"]} />
    </>,
  },
  {
    needsCast: true, where: coach, sel: '[data-tour="coach-fingerprint"]', optional: true,
    title: "His fingerprint",
    body: ({ c }) => <>{c.coach ?? "A coach"}'s tendencies averaged across his seasons as a league percentile. Far from the middle is a habit he carries everywhere, which is what to expect when he takes over a new team.</>,
  },
  {
    needsCast: true, where: coach, sel: '[data-tour="coach-ball"]', optional: true,
    title: "Who got the ball under him",
    body: () => <>His lead running back, receiver and tight end every season, with their share of the carries and targets. Does he ride one back, spread it around, feed the tight end?</>,
  },
  {
    needsCast: true, where: coach, sel: '[data-tour="coach-dots"]', optional: true,
    title: "Every season, compared with himself",
    body: () => <>Each dot is one of his seasons on two tendencies you pick, against his own career averages. A tight cluster is an identity; a drift is a coach who changed. The full season-by-season table follows.</>,
  },
];

const PREDICTIONS: Step[] = [
  {
    where: () => "/predictions", sel: '[data-tour="predictions-games"]',
    title: "What the model called",
    body: () => <>Its pick for each game beside the number the books were offering, and below, its player prop predictions. Every call is written down before kickoff, so nothing here can be quietly improved after the fact.</>,
  },
];

const RESULTS: Step[] = [
  {
    where: () => "/results", sel: '[data-tour="results-strip"]',
    ifEmpty: "Nothing is graded yet this season: a line can only be checked once its game has been played. The page fills in as the weeks go by.",
    title: "Whether any of it worked",
    body: ({ mobile }) => <>
      Every call the site makes, checked against the box score. Each tile is a section:
      <List items={["matchup angles: how often each kind was right", "line signals: whether hot streaks and line moves meant anything", "books and markets: which were sharp, which leaned", "models: side hit rate against the line"]} />
      {tap(mobile)} any row in any of them to see the games behind the number.
    </>,
  },
  {
    where: () => "/results", sel: '[data-tour="results-angles"]', optional: true,
    prep: press('.res-tab', (el) => el.getAttribute("aria-selected") === "true"),
    title: "Which angles have worked",
    body: () => <>Every kind of angle with its record this season: team or player, sorted by most calls, best or worst, over the last few weeks or the whole season. Only five calls or more get a colour, so a 2-for-2 does not look like a sure thing.</>,
  },
  {
    where: () => "/results", sel: '[data-tour="results-called"]', optional: true,
    title: "What a right call looks like",
    body: () => <>The clearest recent hits, with the game they came from. Examples, not a hit rate: the table is the honest measure, misses included.</>,
  },
];

const SETTINGS: Step[] = [
  {
    where: () => "/settings", sel: '[data-tour="settings-pull"]',
    title: "Where fresh lines come from",
    body: () => <>Lines come in here. ESPN is free and needs nothing set up, and every pull is kept, which is what the line history is built from.</>,
  },
  {
    where: () => "/settings", sel: '[data-tour="settings-layout"]', optional: true, when: ({ lens }) => !!lens.profile,
    title: "Your layout",
    body: () => <>Your answers in plain words, and any panel you brought back up by hand from More. Remove one and your answers decide again.</>,
  },
  {
    where: () => "/settings", sel: '[data-tour="settings-defaults"]', optional: true,
    title: "Defaults",
    body: () => <>How far back the history reaches, how many games a page starts on, your preferred book, how touchy the outlier flags are, and whether sample lines fill in when nothing real has been pulled.</>,
  },
];

const WRAP: Step[] = [
  {
    sel: '[data-tour="tailor"]', when: ({ lens, mobile }) => !!lens.profile && !mobile,
    title: "Tailored, or the standard site",
    body: () => <>The Tailor button changes your answers, or switches to the standard layout everyone else sees and back again. Your answers are kept either way.</>,
  },
  {
    sel: ({ mobile }) => (mobile ? '[data-tour="menu"]' : '[data-tour="help"]'),
    title: "That's the tour",
    body: ({ c, mobile, lens }) => <>
      {mobile
        // On a phone the tailoring switch lives in this same menu, so it is
        // said here rather than lighting the same button twice.
        ? <>This menu brings the tour back under <b>Welcome and tour</b>{lens.profile ? <>, and it is where you change your answers or switch between your tailored layout and the standard one</> : null}. Opened from any page, the tour starts on that page.</>
        : <>The <b>?</b> up here brings this back whenever you want it. Opened from any page, the tour starts on that page.</>}
      {" "}Everything it opened is still loaded, so {c.playerName ? `${c.playerName}'s page` : "the player page"} and the rest are a {mobile ? "tap" : "click"} away.
    </>,
  },
];

const PAGES: Record<string, Step[]> = {
  "/research": RESEARCH, "/fantasy": FANTASY, "/board": BOARD, "/matchups": MATCHUPS, "/games": GAMES,
  "/teams": TEAMS, "/coaches": COACHES, "/predictions": PREDICTIONS, "/results": RESULTS,
};

/** The chapters this visitor gets: home, getting around, then every page they
 *  have a tab for, in their tab order, Settings last. Pages behind More are
 *  left out: the tour covers the site they actually see. */
export function chaptersFor(lens: Lens, mobile: boolean): Chapter[] {
  const keep = (s: Step) => !s.when || s.when({ lens, mobile });
  const label = (path: string) => TABS.find((t) => t.path === path)!.label;
  const pages = lens.tabOrder.filter((path) => path !== "/settings" && PAGES[path]).filter((path) => {
    const tab = TABS.find((t) => t.path === path);
    return !tab || lens.shows(`tab:${tab.path}`, tab.tags);
  });
  const all: Chapter[] = [
    { key: "home", label: "Home", path: "/", steps: HOME },
    { key: "around", label: "Getting around", steps: AROUND },
    ...pages.map((path) => ({ key: path, label: path === "/research" ? "Player pages" : label(path), path, steps: PAGES[path] })),
    { key: "/settings", label: "Settings", path: "/settings", steps: SETTINGS },
    { key: "wrap", label: "Done", steps: WRAP },
  ];
  return all.map((ch) => ({ ...ch, steps: ch.steps.filter(keep) })).filter((ch) => ch.steps.length);
}
