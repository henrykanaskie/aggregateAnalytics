/** What a corner of a scatter chart means in words.
 *
 * An axis title says what is measured; it does not say what "high on this
 * and low on that" is. Each metric gets a reading for its high side and its
 * low side, and a quadrant is the two readings joined. The pairings the
 * charts open on get a hand-written line as well, because "fast and few
 * plays" is only interesting once you know it means three-and-outs.
 *
 * Quadrants are handed back in the order ScatterPlot draws them: top-left,
 * top-right, bottom-left, bottom-right, so top-left is low X and high Y. */

interface Reading { high: string; low: string; highMeans?: string; lowMeans?: string }

const TEAM: Record<string, Reading> = {
  plays_pg: { high: "runs a lot of plays", low: "few snaps a game", highMeans: "more snaps, so everyone's counting stats have more room", lowMeans: "fewer snaps, so volume props are fighting the clock" },
  pass_rate: { high: "throws more than most", low: "leans on the run", highMeans: "passing volume is the plan; receivers eat, backs get carries only with a lead", lowMeans: "the run game carries the offense; receivers need efficiency, not volume" },
  proe: { high: "passes more than the situations call for", low: "runs more than the situations call for", highMeans: "the passing lean is a choice and survives a lead", lowMeans: "the run lean is a choice and survives a deficit" },
  early_down_pass_rate: { high: "throws on early downs", low: "runs on early downs", highMeans: "receivers get early-down volume, not just third-down scraps", lowMeans: "backs get the early downs; receivers wait for obvious passing downs" },
  neutral_pass_rate: { high: "throws even when the game is close", low: "runs when the game is close", highMeans: "they throw when the score is close, so passing volume does not depend on trailing", lowMeans: "they run when the score is close, so passing volume needs a deficit" },
  shotgun_rate: { high: "lives in shotgun", low: "under center often", highMeans: "a spread, pass-first look; expect more dropbacks", lowMeans: "under-center looks that favour play action and the run" },
  no_huddle_rate: { high: "goes no-huddle a lot", low: "huddles", highMeans: "tempo stresses the defense and adds snaps late in halves", lowMeans: "they let the clock run between snaps" },
  sec_per_play: { high: "plays slow", low: "plays fast", highMeans: "a slow clock shortens the game for both sides", lowMeans: "a fast clock lengthens the game for both sides" },
  fourth_go_rate: { high: "goes for it on 4th and short", low: "kicks on 4th and short", highMeans: "drives get extended; fewer punts, more red-zone chances and touchdowns", lowMeans: "drives end in kicks; field goals and punts, fewer touchdowns" },
  epa_play: { high: "efficient offense", low: "inefficient offense", highMeans: "the offense sustains drives and scores; the total leans over", lowMeans: "drives stall; points and player volume suffer" },
  success_rate: { high: "stays on schedule", low: "falls behind the chains", highMeans: "they stay ahead of the chains, so drives last and possessions are long", lowMeans: "they face third-and-long, so drives end quickly" },
  pass_epa: { high: "efficient passing game", low: "passing game that loses value", highMeans: "the quarterback's yards come efficiently; receivers hit their lines", lowMeans: "passing yards come hard; receiving props lean under" },
  rush_epa: { high: "efficient run game", low: "run game that loses value", highMeans: "the run game moves the ball; the lead back's yards are safe", lowMeans: "runs go nowhere; carries do not turn into yards" },
  ypp: { high: "gains a lot per snap", low: "gains little per snap", highMeans: "chunk gains mean yards on fewer touches", lowMeans: "yards need volume, because each touch is short" },
  explosive_rate: { high: "generates big plays", low: "few big plays", highMeans: "big plays inflate yardage and long-play props", lowMeans: "yardage has to be earned in small pieces" },
  adot: { high: "throws deep", low: "throws short", highMeans: "deep targets: boom-or-bust yardage", lowMeans: "short targets: catches over yards" },
  rz_trips_pg: { high: "reaches the red zone often", low: "rarely reaches the red zone", highMeans: "they get inside the 20 often, so touchdown chances are plentiful", lowMeans: "they seldom reach the 20; scoring props are thin" },
  rz_td_rate: { high: "finishes drives with touchdowns", low: "stalls in the red zone", highMeans: "trips become touchdowns, so scorer props hit and kickers wait", lowMeans: "trips become field goals, so kicker props hit and scorers wait" },
  rz_pass_rate: { high: "throws in the red zone", low: "runs in the red zone", highMeans: "goal-line targets go to receivers and tight ends", lowMeans: "goal-line work goes to the backs" },
  gtg_rush_rate: { high: "pounds it in from goal-to-go", low: "throws from goal-to-go", highMeans: "the back gets the touchdown chances from close range", lowMeans: "close-range scores go through the air" },
  rb_target_share: { high: "throws to the backs", low: "backs rarely targeted", highMeans: "the back is a receiver too; his catches and yards add up", lowMeans: "the back's props are carries only" },
  wr_target_share: { high: "receivers get the targets", low: "receivers share targets with backs and tight ends", highMeans: "the receivers own the targets, so their lines are well supported", lowMeans: "targets leak to backs and tight ends, thinning the receivers' volume" },
  te_target_share: { high: "tight end is a primary target", low: "tight ends rarely targeted", highMeans: "the tight end is a real target; his catch and yardage lines are live", lowMeans: "the tight end is a blocker; his props are long shots" },
  rb_carry_share: { high: "backs take nearly every carry", low: "quarterback carries a lot of the rushing", highMeans: "the backs get every carry; rushing props are theirs", lowMeans: "the quarterback takes carries off the backs" },
  lead_rb_share: { high: "one back carries the load", low: "committee backfield", highMeans: "one back owns the backfield and its touches", lowMeans: "a committee splits the touches, capping each back" },
  rb_touch_pg: { high: "backs touch it a lot", low: "backs touch it little", highMeans: "the backfield is fed; touches support the props", lowMeans: "the backfield is thin on touches" },
  qb_rush_rate: { high: "quarterback runs often", low: "quarterback stays in the pocket", highMeans: "quarterback rushing props are live and he steals red-zone scores", lowMeans: "quarterback rushing is a non-factor" },
  sack_rate_taken: { high: "takes a lot of sacks", low: "keeps the quarterback clean", highMeans: "drives die to sacks; passing yards and points suffer", lowMeans: "the quarterback gets his throws off" },
  int_rate: { high: "throws picks", low: "protects the ball", highMeans: "turnovers hand the other side short fields and points", lowMeans: "drives are not thrown away" },
  third_down_conv: { high: "converts third downs", low: "stalls on third down", highMeans: "drives keep going, so possessions run long", lowMeans: "drives end at the third down, so possessions are short" },
  fga_pg: { high: "kicks a lot of field goals", low: "few field goal tries", highMeans: "the kicker is busy; his points line is well fed", lowMeans: "the kicker sees little work" },
  rz_rb_target_share: { high: "backs targeted near the goal line", low: "backs ignored near the goal line", highMeans: "the back is thrown to near the goal line: receiving scores", lowMeans: "the back is not a red-zone target" },
  rz_wr_target_share: { high: "receivers targeted near the goal line", low: "receivers share red-zone looks", highMeans: "receivers get the scoring targets", lowMeans: "receivers are bypassed near the goal line" },
  rz_te_target_share: { high: "tight ends targeted near the goal line", low: "tight ends ignored near the goal line", highMeans: "the tight end is the red-zone target: touchdown props are live", lowMeans: "the tight end is not a red-zone target" },
  deep_rate: { high: "takes deep shots", low: "rarely throws deep", highMeans: "shot plays: boom-or-bust yardage and long-reception props", lowMeans: "few shots downfield; yardage comes from volume" },
  pa_rate: { high: "heavy play action", low: "little play action", highMeans: "play action opens intermediate throws for receivers and tight ends", lowMeans: "little play action; the passing game is straightforward" },
  motion_rate: { high: "motions before the snap", low: "static before the snap", highMeans: "motion creates free releases and easier targets for receivers", lowMeans: "receivers win one-on-one or not at all" },
  rpo_rate: { high: "runs a lot of RPOs", low: "few RPOs", highMeans: "quick throws off run looks: catches for slot receivers and backs", lowMeans: "few quick-game freebies" },
  screen_rate: { high: "throws a lot of screens", low: "few screens", highMeans: "screens pad catches and yards after the catch for backs and receivers", lowMeans: "few cheap catches" },
  box_faced: { high: "sees stacked boxes", low: "sees light boxes", highMeans: "defenses load the box, so the run game is hard and the pass is open", lowMeans: "light boxes invite the run" },
  p11_rate: { high: "three receivers nearly always", low: "heavier personnel than most", highMeans: "three receivers on the field almost always; the third receiver has a role", lowMeans: "heavier sets, so the third receiver sits and tight ends play" },
  p12_rate: { high: "two tight ends often", low: "rarely two tight ends", highMeans: "two tight ends on the field; the second one has snaps", lowMeans: "one tight end at a time" },
  p21_rate: { high: "uses a fullback", low: "no fullback", highMeans: "a fullback on the field: a run-heavy identity", lowMeans: "no fullback; lighter, more spread" },
  under_center_rate: { high: "under center a lot", low: "shotgun nearly always", highMeans: "under-center looks: play action and the run", lowMeans: "shotgun looks: dropbacks" },
  def_epa_play: { high: "gives up a lot per play", low: "gives up little per play", highMeans: "opposing offenses move the ball; their players' props lean over", lowMeans: "opposing offenses are stuck; their props lean under" },
  def_success_rate: { high: "lets offenses stay on schedule", low: "gets offenses off schedule", highMeans: "opponents stay on schedule and sustain drives", lowMeans: "opponents fall behind the chains and punt" },
  def_pass_epa: { high: "beaten through the air", low: "stout against the pass", highMeans: "opposing passers and receivers produce", lowMeans: "passing yards come hard against them" },
  def_rush_epa: { high: "beaten on the ground", low: "stout against the run", highMeans: "opposing backs produce", lowMeans: "rushing yards come hard against them" },
  def_ypp: { high: "gives up yards in chunks", low: "gives up little per snap", highMeans: "yards come in chunks against them", lowMeans: "every yard is earned against them" },
  def_explosive_rate: { high: "gives up big plays", low: "caps big plays", highMeans: "they give up the big play: long-play props are live", lowMeans: "they take away the big play" },
  def_pass_rate_faced: { high: "opponents throw on them", low: "opponents run on them", highMeans: "opponents throw on them, so passing volume is up", lowMeans: "opponents run on them, so rushing volume is up" },
  def_sack_rate: { high: "gets to the quarterback", low: "rarely sacks", highMeans: "they end drives with sacks; opposing passing stalls", lowMeans: "the quarterback has time against them" },
  def_rz_td_rate: { high: "bends in the red zone", low: "holds in the red zone", highMeans: "opponents finish drives with touchdowns against them", lowMeans: "opponents settle for field goals against them" },
  def_blitz_rate: { high: "blitzes a lot", low: "rushes four", highMeans: "extra rushers: quick throws, hot reads, big plays if it fails", lowMeans: "four-man rushes: the quarterback can hold the ball" },
  def_box_avg: { high: "stacks the box", low: "light boxes", highMeans: "they load the box: the run is hard, the pass is open", lowMeans: "light boxes: the run is there" },
  def_pressure_rate: { high: "generates pressure", low: "little pressure", highMeans: "pressure shortens the passing game and forces sacks", lowMeans: "no pressure: passers sit and pick" },
  def_man_rate: { high: "plays man", low: "plays zone", highMeans: "man coverage: receivers win or lose one-on-one; quarterbacks scramble", lowMeans: "zone coverage: underneath catches, fewer explosives" },
  def_int_rate: { high: "takes the ball away", low: "few interceptions", highMeans: "they take the ball away: turnovers and short fields", lowMeans: "they rarely take it away" },
  def_third_down_conv: { high: "lets third downs convert", low: "gets off the field on third down", highMeans: "opponents convert, so their drives last", lowMeans: "opponents punt on third down" },
  def_fga_pg: { high: "forces field goals", low: "few field goals against", highMeans: "they bend and force field goals", lowMeans: "few field goals against them" },
  def_adot_faced: { high: "gets attacked deep", low: "gets attacked short", highMeans: "opponents attack them deep", lowMeans: "opponents dink and dunk them" },
  def_deep_rate_faced: { high: "sees a lot of deep shots", low: "sees few deep shots", highMeans: "they get tested deep: long-play props against them are live", lowMeans: "opponents do not take shots on them" },
  def_cover1_rate: { high: "single-high man", low: "little Cover 1", highMeans: "single-high man: corners on islands, deep shots available", lowMeans: "little Cover 1" },
  def_cover3_rate: { high: "Cover 3 heavy", low: "little Cover 3", highMeans: "Cover 3: the underneath is open, the deep middle is not", lowMeans: "little Cover 3" },
  def_two_high_rate: { high: "two safeties deep", low: "single-high shells", highMeans: "two deep safeties: fewer big plays, more underneath and more runs", lowMeans: "single-high: the deep ball and the run box are both contested" },
  def_cover0_rate: { high: "brings the house", low: "never all-out", highMeans: "all-out blitzes: sacks or touchdowns, little in between", lowMeans: "they never send everyone" },
  def_rb_target_share: { high: "backs get targeted against them", low: "backs rarely targeted against them", highMeans: "opposing backs catch passes against them", lowMeans: "opposing backs are not thrown to against them" },
  def_te_target_share: { high: "tight ends get targeted against them", low: "tight ends rarely targeted against them", highMeans: "opposing tight ends get fed against them", lowMeans: "opposing tight ends are quiet against them" },
};

// Player stats are per game for counting stats and per season for rates,
// read against the position's most-used players, so "a lot" means among them.
const PLAYER: Record<string, Reading> = {
  attempts: { high: "throws a lot", low: "few attempts", highMeans: "volume passing: every receiver's target count benefits", lowMeans: "a low-volume passing game caps every receiver" },
  completions: { high: "completes a lot", low: "few completions", highMeans: "completions pile up for the offense's catchers", lowMeans: "few completions to go around" },
  passing_yards: { high: "piles up passing yards", low: "few passing yards", highMeans: "the passing game produces; yardage props have room", lowMeans: "passing yardage is scarce" },
  passing_tds: { high: "throws touchdowns", low: "few passing touchdowns", highMeans: "touchdowns come through the air; receiver scores follow", lowMeans: "few passing scores" },
  passing_interceptions: { high: "throws picks", low: "protects the ball", highMeans: "turnovers shorten drives and games", lowMeans: "the ball is protected" },
  yards_per_attempt: { high: "gains a lot per throw", low: "gains little per throw", highMeans: "yards come in chunks per throw", lowMeans: "each throw gains little" },
  passing_cpoe: { high: "more accurate than expected", low: "less accurate than expected", highMeans: "hits throws others miss", lowMeans: "misses throws others hit" },
  passing_air_yards: { high: "throws it far downfield", low: "keeps it short", highMeans: "the ball travels: deep, high-variance lines", lowMeans: "the ball stays short: safe catches, capped yards" },
  passing_epa: { high: "adds value per game", low: "loses value per game", highMeans: "each game adds value", lowMeans: "each game loses value" },
  adot: { high: "targeted deep", low: "targeted short", highMeans: "deep targets: boom-or-bust yardage", lowMeans: "short targets: catches over yards" },
  carries: { high: "carries a lot", low: "few carries", highMeans: "the workload is his; carries support the props", lowMeans: "a small share of the carries" },
  rushing_yards: { high: "piles up rushing yards", low: "few rushing yards", highMeans: "rushing production is there", lowMeans: "rushing production is scarce" },
  yards_per_carry: { high: "gains a lot per carry", low: "gains little per carry", highMeans: "each carry goes far", lowMeans: "each carry goes nowhere" },
  rushing_tds: { high: "scores on the ground", low: "few rushing scores", highMeans: "goal-line work and scores", lowMeans: "not the goal-line back" },
  targets: { high: "heavily targeted", low: "few targets", highMeans: "the volume is his; catch and yardage lines are supported", lowMeans: "few looks, so the lines rest on efficiency" },
  receptions: { high: "catches a lot", low: "few catches", highMeans: "catches pile up", lowMeans: "catches are scarce" },
  receiving_yards: { high: "piles up receiving yards", low: "few receiving yards", highMeans: "receiving production is there", lowMeans: "receiving production is scarce" },
  receiving_tds: { high: "scores through the air", low: "few receiving scores", highMeans: "a scoring target", lowMeans: "not a scoring target" },
  receiving_air_yards: { high: "a lot of air yards", low: "few air yards", highMeans: "deep intended volume: variance and long-reception props", lowMeans: "short intended volume" },
  target_share: { high: "a big slice of the team's targets", low: "a small slice of the team's targets", highMeans: "the offense runs through him", lowMeans: "he is a small part of the passing game" },
  air_yards_share: { high: "a big slice of the team's air yards", low: "a small slice of the team's air yards", highMeans: "the deep shots are his", lowMeans: "the deep shots go elsewhere" },
  catch_rate: { high: "catches most of what comes", low: "drops or contested targets", highMeans: "what comes his way is caught", lowMeans: "contested or deep looks that do not always land" },
  yards_per_target: { high: "productive per target", low: "unproductive per target", highMeans: "every look turns into yards", lowMeans: "looks that do not turn into yards" },
  snap_offense_pct: { high: "on the field nearly every snap", low: "part-time snaps", highMeans: "always on the field, so the opportunities keep coming", lowMeans: "a part-time role caps the opportunities" },
  touches: { high: "touches it a lot", low: "few touches", highMeans: "the ball is in his hands a lot", lowMeans: "the ball is rarely in his hands" },
  opportunities: { high: "a lot of opportunities", low: "few opportunities", highMeans: "chances keep coming", lowMeans: "few chances" },
  rush_rec_yards: { high: "piles up yards from scrimmage", low: "few yards from scrimmage", highMeans: "yards from scrimmage add up", lowMeans: "few yards from scrimmage" },
  total_tds: { high: "scores a lot", low: "rarely scores", highMeans: "a scorer", lowMeans: "rarely scores" },
  fantasy_points_ppr: { high: "big fantasy producer", low: "small fantasy producer", highMeans: "a lot of production per game", lowMeans: "little production per game" },
  fantasy_points: { high: "big fantasy producer", low: "small fantasy producer", highMeans: "a lot of production per game", lowMeans: "little production per game" },
  receiving_epa: { high: "adds value as a receiver", low: "loses value as a receiver", highMeans: "adds value with every target", lowMeans: "targets that lose value" },
  rushing_epa: { high: "adds value as a runner", low: "loses value as a runner", highMeans: "adds value with every carry", lowMeans: "carries that lose value" },
};

/** Hand-written readings for the pairings the charts open on. Keyed by the
 *  two metric keys in either order; the value says what each corner means,
 *  indexed by whether the first key (x) and the second key (y) are high. */
type Pair = Record<"hh" | "hl" | "lh" | "ll", string>;   // x-high/y-high, x-high/y-low, x-low/y-high, x-low/y-low
const PAIRS: Record<string, Pair> = {
  "sec_per_play|plays_pg": { hh: "slow but sustains drives: ball control", hl: "plodding: few plays at a slow pace", lh: "up-tempo, the snaps pile up", ll: "fast but the drives end early: three-and-outs" },
  "pass_rate|proe": { hh: "pass-first by design, not game script", hl: "threw a lot because the situations demanded it: trailing", lh: "runs, but less than the situations called for: a passing lean the raw rate hides", ll: "run-first by choice" },
  "rb_target_share|te_target_share": { hh: "backs and tight ends eat targets; receivers share", hl: "checkdown-heavy, tight ends left out", lh: "the tight end is a primary receiver", ll: "the wide receivers get the ball" },
  "rz_trips_pg|rz_td_rate": { hh: "gets there and finishes: touchdowns", hl: "moves the ball but stalls: field goals", lh: "rarely there, efficient when it is", ll: "struggles to reach the red zone and to finish" },
  "pa_rate|motion_rate": { hh: "play action dressed with motion: the modern outside-zone tree", hl: "play action without the window dressing", lh: "motion to read the defense, little play action", ll: "static, straightforward looks" },
  "def_pass_epa|def_rush_epa": { hh: "leaky both ways", hl: "stops the run, beaten through the air", lh: "stout against the pass, soft against the run", ll: "shuts down both" },
  "def_pressure_rate|def_blitz_rate": { hh: "pressure by blitzing, and it works", hl: "wins with four: the front gets home without extra rushers", lh: "blitzes and still does not get home: exploitable", ll: "passive front, the quarterback has time" },
  "def_man_rate|def_two_high_rate": { hh: "two-man and mixed looks", hl: "single-high man: corners on islands", lh: "two-deep zone shells: caps big plays, gives up the underneath", ll: "single-high zone, Cover 3 country" },
  "epa_play|def_epa_play": { hh: "good offense, bad defense: shootouts", hl: "complete team", lh: "bad both ways: lopsided losses", ll: "the defense carries a weak offense: low totals" },
  "targets|receiving_yards": { hh: "volume and production: the focal point of the passing game", hl: "volume without production: short or inefficient targets", lh: "efficient on limited looks: big plays when targeted", ll: "on the fringe of the passing game" },
  "carries|rushing_yards": { hh: "the workhorse, and productive with it", hl: "a lot of carries for little: volume the offense may not keep giving", lh: "efficient in a small role: a change-of-pace back", ll: "a bit part in the run game" },
  "attempts|passing_yards": { hh: "throws a lot and it goes somewhere: a high-volume passing game", hl: "throws a lot for little: short game or a struggling offense", lh: "efficient on fewer throws: a run-first offense that strikes", ll: "a low-volume passing game" },
  "attempts|completions": { hh: "high-volume passer", hl: "throws a lot and misses a lot", lh: "accurate on fewer throws", ll: "low-volume passer" },
  "targets|receptions": { hh: "targeted a lot and catches it", hl: "targeted a lot, catches less of it: contested or deep looks", lh: "catches nearly everything on fewer looks", ll: "few looks" },
};

const reading = (key: string, label: string, high: boolean): string => {
  const r = TEAM[key] ?? PLAYER[key];
  if (r) return high ? r.high : r.low;
  return `${high ? "high" : "low"} ${label.toLowerCase()}`;
};

/** What that side of the metric means for how the game goes and who gets
 *  the ball, or nothing for a metric with no consequence written yet. */
const means = (key: string, high: boolean): string | undefined => {
  const r = TEAM[key] ?? PLAYER[key];
  return high ? r?.highMeans : r?.lowMeans;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The two ends of an axis in the same words the corners use, for the
 *  arrows drawn beside it: "← plays fast … plays slow →". */
export interface AxisEnds { low: string; high: string; lowMeans?: string; highMeans?: string }
export function axisEnds(key: string, label: string): AxisEnds {
  return { low: reading(key, label, false), high: reading(key, label, true), lowMeans: means(key, false), highMeans: means(key, true) };
}

/**
 * Four corner descriptions for a scatter of `x` against `y`, in draw order:
 * top-left (low x, high y), top-right (high, high), bottom-left (low, low),
 * bottom-right (high x, low y). A pairing with a hand-written interpretation
 * gets that; any other gets its two readings joined.
 */
export function describeQuadrants(x: string, y: string, xLabel: string, yLabel: string): [string, string, string, string] {
  const direct = PAIRS[`${x}|${y}`];
  const swapped = direct ? undefined : PAIRS[`${y}|${x}`];
  const pair = (xh: boolean, yh: boolean): string | undefined => {
    if (direct) return direct[`${xh ? "h" : "l"}${yh ? "h" : "l"}` as keyof Pair];
    if (swapped) return swapped[`${yh ? "h" : "l"}${xh ? "h" : "l"}` as keyof Pair];
    return undefined;
  };
  // First line: the two readings. Second: what it means for the game. A
  // pairing with a hand-written line uses it, since it says what the two do
  // *together*; every other pairing gets each side's consequence, which is
  // the meaning of the combination whenever the two do not interact.
  const corner = (xh: boolean, yh: boolean): string => {
    const head = `${cap(reading(x, xLabel, xh))}, ${reading(y, yLabel, yh)}.`;
    const p = pair(xh, yh);
    const body = p ? cap(p) : [means(x, xh), means(y, yh)].filter(Boolean).map((t) => cap(t!)).join(". ");
    return body ? `${head}\n${body}${body.endsWith(".") ? "" : "."}` : head;
  };
  return [corner(false, true), corner(true, true), corner(false, false), corner(true, false)];
}
