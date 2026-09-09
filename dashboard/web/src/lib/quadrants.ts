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

interface Reading { high: string; low: string }

const TEAM: Record<string, Reading> = {
  plays_pg: { high: "runs a lot of plays", low: "few snaps a game" },
  pass_rate: { high: "throws more than most", low: "leans on the run" },
  proe: { high: "passes more than the situations call for", low: "runs more than the situations call for" },
  early_down_pass_rate: { high: "throws on early downs", low: "runs on early downs" },
  neutral_pass_rate: { high: "throws even when the game is close", low: "runs when the game is close" },
  shotgun_rate: { high: "lives in shotgun", low: "under center often" },
  no_huddle_rate: { high: "goes no-huddle a lot", low: "huddles" },
  sec_per_play: { high: "plays slow", low: "plays fast" },
  fourth_go_rate: { high: "goes for it on 4th and short", low: "kicks on 4th and short" },
  epa_play: { high: "efficient offense", low: "inefficient offense" },
  success_rate: { high: "stays on schedule", low: "falls behind the chains" },
  pass_epa: { high: "efficient passing game", low: "passing game that loses value" },
  rush_epa: { high: "efficient run game", low: "run game that loses value" },
  ypp: { high: "gains a lot per snap", low: "gains little per snap" },
  explosive_rate: { high: "generates big plays", low: "few big plays" },
  adot: { high: "throws deep", low: "throws short" },
  rz_trips_pg: { high: "reaches the red zone often", low: "rarely reaches the red zone" },
  rz_td_rate: { high: "finishes drives with touchdowns", low: "stalls in the red zone" },
  rz_pass_rate: { high: "throws in the red zone", low: "runs in the red zone" },
  gtg_rush_rate: { high: "pounds it in from goal-to-go", low: "throws from goal-to-go" },
  rb_target_share: { high: "throws to the backs", low: "backs rarely targeted" },
  wr_target_share: { high: "receivers get the targets", low: "receivers share targets with backs and tight ends" },
  te_target_share: { high: "tight end is a primary target", low: "tight ends rarely targeted" },
  rb_carry_share: { high: "backs take nearly every carry", low: "quarterback carries a lot of the rushing" },
  lead_rb_share: { high: "one back carries the load", low: "committee backfield" },
  rb_touch_pg: { high: "backs touch it a lot", low: "backs touch it little" },
  qb_rush_rate: { high: "quarterback runs often", low: "quarterback stays in the pocket" },
  sack_rate_taken: { high: "takes a lot of sacks", low: "keeps the quarterback clean" },
  int_rate: { high: "throws picks", low: "protects the ball" },
  third_down_conv: { high: "converts third downs", low: "stalls on third down" },
  fga_pg: { high: "kicks a lot of field goals", low: "few field goal tries" },
  rz_rb_target_share: { high: "backs targeted near the goal line", low: "backs ignored near the goal line" },
  rz_wr_target_share: { high: "receivers targeted near the goal line", low: "receivers share red-zone looks" },
  rz_te_target_share: { high: "tight ends targeted near the goal line", low: "tight ends ignored near the goal line" },
  deep_rate: { high: "takes deep shots", low: "rarely throws deep" },
  pa_rate: { high: "heavy play action", low: "little play action" },
  motion_rate: { high: "motions before the snap", low: "static before the snap" },
  rpo_rate: { high: "runs a lot of RPOs", low: "few RPOs" },
  screen_rate: { high: "throws a lot of screens", low: "few screens" },
  box_faced: { high: "sees stacked boxes", low: "sees light boxes" },
  p11_rate: { high: "three receivers nearly always", low: "heavier personnel than most" },
  p12_rate: { high: "two tight ends often", low: "rarely two tight ends" },
  p21_rate: { high: "uses a fullback", low: "no fullback" },
  under_center_rate: { high: "under center a lot", low: "shotgun nearly always" },
  def_epa_play: { high: "gives up a lot per play", low: "gives up little per play" },
  def_success_rate: { high: "lets offenses stay on schedule", low: "gets offenses off schedule" },
  def_pass_epa: { high: "beaten through the air", low: "stout against the pass" },
  def_rush_epa: { high: "beaten on the ground", low: "stout against the run" },
  def_ypp: { high: "gives up yards in chunks", low: "gives up little per snap" },
  def_explosive_rate: { high: "gives up big plays", low: "caps big plays" },
  def_pass_rate_faced: { high: "opponents throw on them", low: "opponents run on them" },
  def_sack_rate: { high: "gets to the quarterback", low: "rarely sacks" },
  def_rz_td_rate: { high: "bends in the red zone", low: "holds in the red zone" },
  def_blitz_rate: { high: "blitzes a lot", low: "rushes four" },
  def_box_avg: { high: "stacks the box", low: "light boxes" },
  def_pressure_rate: { high: "generates pressure", low: "little pressure" },
  def_man_rate: { high: "plays man", low: "plays zone" },
  def_int_rate: { high: "takes the ball away", low: "few interceptions" },
  def_third_down_conv: { high: "lets third downs convert", low: "gets off the field on third down" },
  def_fga_pg: { high: "forces field goals", low: "few field goals against" },
  def_adot_faced: { high: "gets attacked deep", low: "gets attacked short" },
  def_deep_rate_faced: { high: "sees a lot of deep shots", low: "sees few deep shots" },
  def_cover1_rate: { high: "single-high man", low: "little Cover 1" },
  def_cover3_rate: { high: "Cover 3 heavy", low: "little Cover 3" },
  def_two_high_rate: { high: "two safeties deep", low: "single-high shells" },
  def_cover0_rate: { high: "brings the house", low: "never all-out" },
  def_rb_target_share: { high: "backs get targeted against them", low: "backs rarely targeted against them" },
  def_te_target_share: { high: "tight ends get targeted against them", low: "tight ends rarely targeted against them" },
};

// Player stats are per game for counting stats and per season for rates,
// read against the position's most-used players, so "a lot" means among them.
const PLAYER: Record<string, Reading> = {
  attempts: { high: "throws a lot", low: "few attempts" },
  completions: { high: "completes a lot", low: "few completions" },
  passing_yards: { high: "piles up passing yards", low: "few passing yards" },
  passing_tds: { high: "throws touchdowns", low: "few passing touchdowns" },
  passing_interceptions: { high: "throws picks", low: "protects the ball" },
  yards_per_attempt: { high: "gains a lot per throw", low: "gains little per throw" },
  passing_cpoe: { high: "more accurate than expected", low: "less accurate than expected" },
  passing_air_yards: { high: "throws it far downfield", low: "keeps it short" },
  passing_epa: { high: "adds value per game", low: "loses value per game" },
  adot: { high: "targeted deep", low: "targeted short" },
  carries: { high: "carries a lot", low: "few carries" },
  rushing_yards: { high: "piles up rushing yards", low: "few rushing yards" },
  yards_per_carry: { high: "gains a lot per carry", low: "gains little per carry" },
  rushing_tds: { high: "scores on the ground", low: "few rushing scores" },
  targets: { high: "heavily targeted", low: "few targets" },
  receptions: { high: "catches a lot", low: "few catches" },
  receiving_yards: { high: "piles up receiving yards", low: "few receiving yards" },
  receiving_tds: { high: "scores through the air", low: "few receiving scores" },
  receiving_air_yards: { high: "a lot of air yards", low: "few air yards" },
  target_share: { high: "a big slice of the team's targets", low: "a small slice of the team's targets" },
  air_yards_share: { high: "a big slice of the team's air yards", low: "a small slice of the team's air yards" },
  catch_rate: { high: "catches most of what comes", low: "drops or contested targets" },
  yards_per_target: { high: "productive per target", low: "unproductive per target" },
  snap_offense_pct: { high: "on the field nearly every snap", low: "part-time snaps" },
  touches: { high: "touches it a lot", low: "few touches" },
  opportunities: { high: "a lot of opportunities", low: "few opportunities" },
  rush_rec_yards: { high: "piles up yards from scrimmage", low: "few yards from scrimmage" },
  total_tds: { high: "scores a lot", low: "rarely scores" },
  fantasy_points_ppr: { high: "big fantasy producer", low: "small fantasy producer" },
  fantasy_points: { high: "big fantasy producer", low: "small fantasy producer" },
  receiving_epa: { high: "adds value as a receiver", low: "loses value as a receiver" },
  rushing_epa: { high: "adds value as a runner", low: "loses value as a runner" },
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The two ends of an axis in the same words the corners use, for the
 *  arrows drawn beside it: "← plays fast … plays slow →". */
export function axisEnds(key: string, label: string): { low: string; high: string } {
  return { low: reading(key, label, false), high: reading(key, label, true) };
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
  // A hand-written reading already says what the two sides mean together,
  // so it stands alone; the joined readings are for every other pairing.
  const corner = (xh: boolean, yh: boolean): string => {
    const p = pair(xh, yh);
    return p ? cap(p) : `${cap(reading(x, xLabel, xh))}, ${reading(y, yLabel, yh)}`;
  };
  return [corner(false, true), corner(true, true), corner(false, false), corner(true, false)];
}
