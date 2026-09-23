import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { IconBolt, IconDown, IconPlus, IconShield, IconSwap, IconTrash, IconWarn } from "./Icons";
import type { FantasyPlayer, FantasyWeek, PlayerLite } from "../api";
import { FANTASY_KEY, fantasyHref, fantasyStatFor, Scoring, SCORING_LABEL } from "../lib/profile";
import { DEFAULT_SLOTS, fitsSlot, placeLineup, RosterEntry, SLOT_ORDER, Slots, toEntry } from "./MyRoster";
import { useSticky } from "../lib/sticky";
import { marksFor } from "./FantasySnapshot";
import { Headshot, Spinner } from "./common";
import PlayerSearch from "./PlayerSearch";
import RangeBar, { rangeMax } from "./RangeBar";

// My team: the roster someone actually has, starters and bench, kept in this
// browser. The roster and the slots are the same ones the tailoring questions
// and the home page read (fantasy.roster, fantasy.slots); only a lineup set by
// hand is this view's own. Every number comes from the same weekly projection the rest of the
// page uses; what this adds is the lineup around it. The best lineup is the
// highest projection that fits the slots, and the insights compare the bench
// against the players it would replace on the three things that decide a
// start: the projection, the floor (a quiet week) and the ceiling (a big one).

type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DST";
type Slot = keyof Slots;

const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DST"];
// Kicker and defense come last and never flex (fitsSlot only matches them to their own slot).
const SHORT: Record<Slot, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "FLEX", SFLEX: "SFLX", K: "K", DST: "D/ST" };
const OUT = ["Out", "Doubtful", "IR", "Suspended", "Not playing"];
const MAX_ROSTER = 20;

const fits = fitsSlot;

/** Standard normal CDF (Abramowitz and Stegun 7.1.26), good to 1e-7. */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Chance of a boom week and a bust week, reading the projection's floor and
 *  ceiling (its 20th and 80th percentiles, ±0.8416 sd) as a normal
 *  distribution: the same reading start / sit simulates. */
export function boomBust(p: FantasyPlayer, scoring: Scoring): { boom: number; bust: number; marks: [number, number] } | null {
  const pr = p.proj[scoring];
  if (!pr) return null;
  const sd = Math.max((pr.high - pr.low) / 1.683, 1);
  const marks = marksFor(p.position, scoring);
  return { boom: 1 - phi((marks[0] - pr.value) / sd), bust: phi((marks[1] - pr.value) / sd), marks };
}

type Filled = { slot: Slot; id: string | null };
const place = placeLineup;

interface Insight { kind: "swap" | "warn" | "floor" | "ceiling" | "bust"; text: React.ReactNode; action?: { label: string; run: () => void } }

export default function MyTeam({ data, scoring, loading, roster, setRoster, slots: savedSlots, setSlots }: {
  data: FantasyWeek | null; scoring: Scoring; loading: boolean;
  roster: RosterEntry[]; setRoster: (r: RosterEntry[]) => void; slots: Slots; setSlots: (s: Slots) => void;
}) {
  // null: the best projected lineup, re-picked as the numbers move.
  const [starters, setLineup] = useSticky<string[] | null>("fantasy.lineup", null);
  const [pick, setPick] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [allTips, setAllTips] = useState(false);
  // Past games as dots on each player's range bar.
  const [pastDots, setPastDots] = useSticky<boolean>("fantasy.pastDots", true);
  const slots = { ...DEFAULT_SLOTS, ...savedSlots };
  const byId = useMemo(() => new Map((data?.players ?? []).map((p) => [p.player_id, p])), [data]);
  const key = FANTASY_KEY[scoring];

  const posOf = (id: string) => byId.get(id)?.position ?? roster.find((r) => r.player_id === id)?.position ?? "";
  // Whether a player can score this week at all, and what they project to.
  const why = (id: string): string | null => {
    const p = byId.get(id);
    if (!p) return data?.byes.includes(roster.find((r) => r.player_id === id)?.team ?? "") ? "bye" : "not playing";
    if (p.status && OUT.includes(p.status)) return p.status.toLowerCase();
    if (!p.proj[scoring]) return "no projection";
    return null;
  };
  const proj = (id: string) => (why(id) ? 0 : byId.get(id)!.proj[scoring]!.value);
  const band = (id: string) => (why(id) ? null : byId.get(id)!.proj[scoring]!);

  const ids = roster.map((r) => r.player_id);
  const best = useMemo(() => place(ids.filter((id) => !why(id)), slots, posOf, proj), [data, roster, slots, scoring]);
  const auto = starters === null;
  const current = useMemo(() => (auto ? best : place(starters!.filter((id) => ids.includes(id)), slots, posOf, proj)), [auto, best, starters, roster, slots, data, scoring]);
  const starting = new Set(current.filled.map((f) => f.id).filter((x): x is string => !!x));
  const bench = ids.filter((id) => !starting.has(id)).sort((a, b) => proj(b) - proj(a));
  const total = (f: Filled[], k: "value" | "low" | "high") => f.reduce((s, x) => s + (x.id ? band(x.id)?.[k] ?? 0 : 0), 0);
  const cur = total(current.filled, "value"), top = total(best.filled, "value");
  const gain = top - cur;

  const setStarters = (list: string[]) => setLineup(list);
  const add = (p: PlayerLite | FantasyPlayer) => {
    if (!POSITIONS.includes(p.position as Pos)) { setNote(`${p.name} is a ${p.position}; only QB, RB, WR, TE, kickers and team defenses are projected here.`); return; }
    if (ids.includes(p.player_id)) { setNote(`${p.name} is already on your team.`); return; }
    if (ids.length >= MAX_ROSTER) { setNote(`${MAX_ROSTER} players is the limit.`); return; }
    setNote(null);
    // A player added to a lineup someone has arranged by hand goes to the
    // bench; in auto mode the lineup simply re-picks itself.
    setRoster([...roster, toEntry(p)]);
  };
  const remove = (id: string) => { setRoster(roster.filter((r) => r.player_id !== id)); if (starters) setLineup(starters.filter((x) => x !== id)); };
  const swap = (a: string, b: string) => {
    const now = current.filled.map((f) => f.id).filter((x): x is string => !!x);
    const inA = now.includes(a), inB = now.includes(b);
    if (inA === inB) return;
    const out = inA ? a : b, into = inA ? b : a;
    setStarters(now.map((x) => (x === out ? into : x)));
    setPick(null);
  };
  const startInto = (id: string) => setStarters([...current.filled.map((f) => f.id).filter((x): x is string => !!x), id]);
  const slotOf = (id: string) => current.filled.find((f) => f.id === id)?.slot ?? null;
  const openSlot = (pos: string) => current.filled.find((f) => !f.id && fits(f.slot, pos));

  // Who could take whose place: a bench player and a starter whose slot he fits.
  const canTrade = (benchId: string, starterId: string) => { const s = slotOf(starterId); return !!s && fits(s, posOf(benchId)); };

  const insights: Insight[] = useMemo(() => {
    if (!data) return [];
    const out: Insight[] = [];
    const nm = (id: string) => byId.get(id)?.name ?? roster.find((r) => r.player_id === id)?.name ?? id;
    const f1 = (v: number) => v.toFixed(1);
    // 1. Starters who cannot score, and empty slots.
    for (const f of current.filled) {
      if (!f.id) { out.push({ kind: "warn", text: <>Your <b>{SHORT[f.slot]}</b> slot is empty.{bench.some((b) => !why(b) && fits(f.slot, posOf(b))) ? " Someone on your bench can fill it." : ""}</> }); continue; }
      const w = why(f.id);
      // The replacement, if there is one, is the first swap suggested below.
      if (w) out.push({ kind: "warn", text: <><b>{nm(f.id)}</b> is {w === "bye" ? "on bye" : w === "not playing" ? "not playing this week" : w === "no projection" ? "without a projection (too few games)" : `listed ${w}`}.</> });
      else if (byId.get(f.id)?.status) out.push({ kind: "warn", text: <><b>{nm(f.id)}</b> is on the injury report: {byId.get(f.id)!.status!.toLowerCase()}{byId.get(f.id)!.injury ? ` (${byId.get(f.id)!.injury!.toLowerCase()})` : ""}. Check before kickoff.</> });
    }
    // 2. A better projected lineup exists. Found one legal swap at a time
    //    (a bench player for a starter whose slot he fits, FLEX reshuffles
    //    included), always the swap worth the most, so each suggestion is one
    //    someone can actually make in their league's app.
    const told = new Set<string>();
    if (!auto && gain > 0.4) {
      let now = [...starting];
      const sum = (list: string[]) => total(place(list, slots, posOf, proj).filled, "value");
      for (let step = 0; step < 6; step++) {
        const base = sum(now);
        let win: { b: string; s: string; v: number } | null = null;
        for (const b of ids.filter((id) => !now.includes(id) && !why(id))) {
          for (const st of now) {
            const v = sum(now.map((x) => (x === st ? b : x))) - base;
            if (v > 0.4 && (!win || v > win.v)) win = { b, s: st, v };
          }
        }
        if (!win) break;
        const { b, s: st } = win;
        told.add(b); told.add(st);
        out.push({ kind: "swap", text: why(st)
          ? <>Start <b>{nm(b)}</b> in place of <b>{nm(st)}</b>: {f1(proj(b))} projected.</>
          : <>Start <b>{nm(b)}</b> over <b>{nm(st)}</b>: projects {f1(proj(b))} to {f1(proj(st))}.</>,
          action: { label: "Swap", run: () => swap(st, b) } });
        now = now.map((x) => (x === st ? b : x));
      }
    }
    // 3. Bench players who project lower but win on floor or ceiling: the
    //    trade-off the projection alone hides. Anyone already in a swap above
    //    is left out, so nothing is said twice.
    const pairs = bench.filter((b) => !why(b) && !told.has(b)).flatMap((b) => [...starting].filter((s) => !why(s) && !told.has(s) && canTrade(b, s) && proj(b) <= proj(s)).map((s) => ({ b, s })));
    const floorWins = pairs.filter(({ b, s }) => band(b)!.low - band(s)!.low >= 1).sort((x, y) => (band(y.b)!.low - band(y.s)!.low) - (band(x.b)!.low - band(x.s)!.low));
    for (const { b, s } of floorWins) {
      if (told.has(b) || told.has(s) || out.filter((x) => x.kind === "floor").length >= 2) continue;
      told.add(b); told.add(s);
      out.push({ kind: "floor", text: <><b>{nm(b)}</b> has a safer floor than <b>{nm(s)}</b> ({f1(band(b)!.low)} vs {f1(band(s)!.low)}). The steadier start if you expect to be favored this week.</>, action: { label: "Swap", run: () => swap(s, b) } });
    }
    const ceilWins = pairs.filter(({ b, s }) => band(b)!.high - band(s)!.high >= 1.5).sort((x, y) => (band(y.b)!.high - band(y.s)!.high) - (band(x.b)!.high - band(x.s)!.high));
    for (const { b, s } of ceilWins) {
      if (told.has(b) || told.has(s) || out.filter((x) => x.kind === "ceiling").length >= 2) continue;
      told.add(b); told.add(s);
      const bb = boomBust(byId.get(b)!, scoring), sb = boomBust(byId.get(s)!, scoring);
      out.push({ kind: "ceiling", text: <><b>{nm(b)}</b> has more upside than <b>{nm(s)}</b>: a ceiling of {f1(band(b)!.high)} to {f1(band(s)!.high)}{bb && sb ? <>, and a {Math.round(bb.boom * 100)}% chance of a boom week to {Math.round(sb.boom * 100)}%</> : null}. The swing start if you need a big week.</>, action: { label: "Swap", run: () => swap(s, b) } });
    }
    // 4. The starter most likely to sink the week.
    const risky = [...starting].filter((s) => !why(s)).map((s) => ({ s, bb: boomBust(byId.get(s)!, scoring)! })).filter((x) => x.bb && x.bb.bust >= 0.3).sort((a, b) => b.bb.bust - a.bb.bust)[0];
    if (risky) out.push({ kind: "bust", text: <><b>{nm(risky.s)}</b> is your biggest bust risk: about a {Math.round(risky.bb.bust * 100)}% chance of under {risky.bb.marks[1]} points.</> });
    return out;
  }, [data, roster, slots, starters, scoring, current, best]);

  if (!roster.length) {
    return (
      <div className="panel myteam-empty">
        <div className="myteam-empty-icon"><IconShield size={34} weight="regular" /></div>
        <h2>Build your team</h2>
        <p className="muted">Add everyone on your fantasy roster, bench included. It stays in this browser. You get your best lineup for the week, who on the bench beats a starter on floor or ceiling, and each player's chance of a boom or a bust week.</p>
        <PlayerSearch onSelect={add} placeholder="Add a player…" />
        <div style={{ marginTop: 8 }}><select className="input mt-dst" value="" aria-label="Add a team defense" onChange={(e) => { const d = byId.get(e.target.value); if (d) add(d); }}>
            <option value="">Add a D/ST…</option>
            {(data?.players ?? []).filter((x) => x.position === "DST").sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.player_id} value={d.player_id}>{d.name}</option>)}
          </select></div>
        {note && <div className="hint" style={{ marginTop: 8, color: "var(--push)" }}>{note}</div>}
      </div>
    );
  }

  const maxHigh = rangeMax(ids.map((id) => ({ b: band(id), recent: pastDots ? byId.get(id)?.recent : undefined })), scoring);
  const row = (id: string, slot: Slot | "BN") => {
    const r = roster.find((x) => x.player_id === id)!;
    const p = byId.get(id);
    const b = band(id);
    const w = why(id);
    const bb = p ? boomBust(p, scoring) : null;
    // A swap is always one starter for one bench player.
    const target = !!pick && pick !== id && (slot === "BN" ? starting.has(pick) && canTrade(id, pick) : !starting.has(pick) && canTrade(pick, id));
    const picked = pick === id;
    return (
      <div key={id} className={`mt-row ${w ? "dead" : ""} ${picked ? "picked" : ""} ${target ? "target" : ""} ${pick && !picked && !target ? "muted-row" : ""}`}
        onClick={target ? () => swap(pick!, id) : undefined}>
        <span className={`mt-slot ${slot === "BN" ? "bn" : ""}`}>{slot === "BN" ? "BN" : SHORT[slot]}</span>
        <Headshot src={p?.headshot ?? null} size={38} />
        <div className="mt-who">
          <Link to={fantasyHref(r, fantasyStatFor(r.position, key))} onClick={(e) => pick && e.preventDefault()} className="mt-name">{r.name}</Link>
          <div className="mt-sub">
            {r.position === "DST" ? "D/ST" : r.position} · {p?.team ?? r.team ?? "FA"}{p ? <> {p.home ? "vs" : "@"} {p.opponent}</> : null}
            {w ? <span className="pill under">{w}</span> : p?.status ? <span className="pill warn">{p.status}</span> : null}
          </div>
          {b && <RangeBar b={b} recent={p?.recent} scoring={scoring} max={maxHigh} dots={pastDots} />}
          {bb && <div className="mt-odds"><span className="boom">Boom {Math.round(bb.boom * 100)}%</span><span className="bust">Bust {Math.round(bb.bust * 100)}%</span><span className="faint">{b!.low.toFixed(1)} to {b!.high.toFixed(1)}</span></div>}
        </div>
        <div className="mt-proj"><b>{b ? b.value.toFixed(1) : "–"}</b><span>proj</span></div>
        <div className="mt-acts">
          {editing
            ? <button className="mt-btn danger" aria-label={`Remove ${r.name}`} onClick={(e) => { e.stopPropagation(); remove(id); }}><IconTrash size={18} /></button>
            : target
              ? <button className="mt-btn on" aria-label="Swap here" onClick={(e) => { e.stopPropagation(); swap(pick!, id); }}><IconSwap size={18} weight="bold" /></button>
              : slot === "BN" && !w && openSlot(r.position)
                ? <button className="mt-btn" aria-label={`Start ${r.name}`} onClick={(e) => { e.stopPropagation(); startInto(id); }}><IconPlus size={18} weight="bold" /></button>
                : <button className={`mt-btn ${picked ? "on" : ""}`} aria-label={picked ? "Cancel swap" : `Swap ${r.name}`} onClick={(e) => { e.stopPropagation(); setPick(picked ? null : id); }}><IconSwap size={18} /></button>}
        </div>
      </div>
    );
  };
  const icon = (k: Insight["kind"]) => ({ swap: <IconSwap size={18} weight="bold" />, warn: <IconWarn size={18} weight="fill" />, floor: <IconShield size={18} weight="fill" />, ceiling: <IconBolt size={18} weight="fill" />, bust: <IconDown size={18} weight="bold" /> }[k]);

  return (
    <div className="myteam">
      <div className="mt-side">
      <div className="panel mt-summary">
        <div className="mt-total">
          <span className="k">Projected · {SCORING_LABEL[scoring]}</span>
          <span className="v">{cur.toFixed(1)}</span>
          <span className="s">range {total(current.filled, "low").toFixed(0)} to {total(current.filled, "high").toFixed(0)}</span>
        </div>
        <div className="mt-lineup-state">
          {auto
            ? <span className="pill accent">Auto: best projected lineup</span>
            : gain > 0.4
              ? <><span className="pill warn">+{gain.toFixed(1)} on the bench</span><button className="btn sm primary" onClick={() => setLineup(null)}>Use best lineup</button></>
              : <span className="pill over">Your lineup is the best projected</span>}
        </div>
        {loading && <Spinner />}
      </div>

      {insights.length > 0 && (
        <div className="panel mt-insights">
          <div className="panel-head"><h3>This week</h3><span className="hint">{insights.length} thing{insights.length === 1 ? "" : "s"} worth a look</span></div>
          {(allTips ? insights : insights.slice(0, 4)).map((x, i) => (
            <div key={i} className={`mt-insight ${x.kind}`}>
              <span className="ic">{icon(x.kind)}</span>
              <span className="tx">{x.text}</span>
              {x.action && <button className="btn sm" onClick={x.action.run}>{x.action.label}</button>}
            </div>
          ))}
          {insights.length > 4 && <button className="linkish small" style={{ marginTop: 6 }} onClick={() => setAllTips(!allTips)}>{allTips ? "Show fewer" : `Show ${insights.length - 4} more`}</button>}
        </div>
      )}

      </div>
      <div className="mt-main">
      <div className="panel">
        <div className="panel-head">
          <h3>Starters</h3>
          <div className="actions">
            {pick && <span className="hint">tap who to swap with</span>}
            <button className={`chip ${pastDots ? "on" : ""}`} title="Each player's last 8 games as dots on his range bar" onClick={() => setPastDots(!pastDots)}>past weeks</button>
            {!auto && !pick && <button className="btn sm ghost" onClick={() => setLineup(null)}>auto</button>}
          </div>
        </div>
        <div className="mt-list">{current.filled.map((f, i) => f.id ? row(f.id, f.slot) : <div key={`empty-${i}`} className="mt-row empty"><span className="mt-slot">{SHORT[f.slot]}</span><span className="muted small">Empty</span></div>)}</div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Bench · {bench.length}</h3>
          <div className="actions"><button className={`btn sm ${editing ? "primary" : "ghost"}`} onClick={() => { setEditing(!editing); setPick(null); }}>{editing ? "Done" : "Edit roster"}</button></div>
        </div>
        <div className="mt-list">{bench.map((id) => row(id, "BN"))}</div>
        {bench.length === 0 && <div className="hint">Nobody on the bench yet.</div>}
        <div className="mt-add">
          <PlayerSearch onSelect={add} placeholder="Add a player…" />
          <select className="input mt-dst" value="" aria-label="Add a team defense" onChange={(e) => { const d = byId.get(e.target.value); if (d) add(d); }}>
            <option value="">Add a D/ST…</option>
            {(data?.players ?? []).filter((x) => x.position === "DST").sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.player_id} value={d.player_id}>{d.name}</option>)}
          </select>
          {note && <div className="hint" style={{ marginTop: 6, color: "var(--push)" }}>{note}</div>}
        </div>
        {editing && (
          <div className="mt-slots">
            <span className="hint">Lineup slots</span>
            {SLOT_ORDER.map((s) => (
              <span key={s} className="mt-stepper">
                <b>{SHORT[s]}</b>
                <button className="mt-btn" aria-label={`Fewer ${s}`} disabled={slots[s] <= 0} onClick={() => setSlots({ ...slots, [s]: slots[s] - 1 })}>−</button>
                <span className="num">{slots[s]}</span>
                <button className="mt-btn" aria-label={`More ${s}`} disabled={slots[s] >= 4} onClick={() => setSlots({ ...slots, [s]: slots[s] + 1 })}>+</button>
              </span>
            ))}
            <button className="btn sm ghost" style={{ color: "var(--under)" }} onClick={() => { if (window.confirm("Remove every player from your team?")) { setRoster([]); setLineup(null); setEditing(false); } }}>Clear team</button>
          </div>
        )}
      </div>
      </div>
      <div className="hint mt-foot">Boom and bust use the same lines as the rest of the fantasy pages (roughly a top-12 week, and a week that loses a matchup on its own), read from each player's floor and ceiling, which come from simulating the week out of his own games around ESPN's projection.</div>
    </div>
  );
}
