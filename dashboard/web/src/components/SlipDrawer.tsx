import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api5, CorrRow } from "../api";
import { sideLabel, useSlip } from "../lib/slip";
import type { Leg } from "../lib/slipStore";
import { useMeta } from "../state";
import Drawer from "./Drawer";

/** Two legs in one game, and how the first one's stat has moved with the
 *  second's over the games they shared, when the correlations know. */
interface Pair { a: Leg; b: Leg; r: number | null; n: number | null }

/** Same side on both (over/over, under/under) wants a positive r to help;
 *  opposite sides want a negative one. */
const helps = (p: Pair) => p.r === null ? null : ((p.a.side === "over" || p.a.side === "yes") === (p.b.side === "over" || p.b.side === "yes")) === p.r > 0;

function usePairs(legs: Leg[]): Pair[] {
  const pairs = useMemo(() => {
    const out: Pair[] = [];
    legs.forEach((a, i) => legs.slice(i + 1).forEach((b) => { if (a.game_id === b.game_id && a.player_id !== b.player_id) out.push({ a, b, r: null, n: null }); }));
    return out;
  }, [legs]);
  const [found, setFound] = useState<Record<string, CorrRow>>({});
  useEffect(() => {
    let alive = true;
    // One request per player and stat, which the shared cache keeps after the
    // first. Each side lists only its own top teammates, so ask from both ends.
    const look = (x: Leg, y: Leg) => api5.correlations(x.player_id, x.stat!).then((d) => d.rows.find((r) => r.player_id === y.player_id && r.stat === y.stat));
    for (const p of pairs) {
      if (!p.a.stat || !p.b.stat) continue;
      look(p.a, p.b).then((hit) => hit ?? look(p.b, p.a)).then((hit) => {
        if (alive && hit) setFound((f) => ({ ...f, [`${p.a.id}|${p.b.id}`]: hit }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [pairs]);
  return pairs.map((p) => { const c = found[`${p.a.id}|${p.b.id}`]; return c ? { ...p, r: c.r, n: c.n } : p; });
}

export default function SlipDrawer() {
  const slip = useSlip();
  const { meta } = useMeta();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const pairs = usePairs(slip.draft);
  useEffect(() => { if (!slip.draft.length) setOpen(false); }, [slip.draft.length]);
  if (!slip.draft.length && !open) return null;
  const save = () => { slip.saveDraft(name); setName(""); setOpen(false); };
  const n = slip.draft.length;
  return (
    <>
      {!open && (
        <button className={`slip-pill ${loc.pathname === "/bets" ? "quiet" : ""}`} onClick={() => setOpen(true)} aria-label={`Open slip, ${n} leg${n > 1 ? "s" : ""}`}>
          <b>{n}</b> leg{n > 1 ? "s" : ""} on your slip
        </button>
      )}
      <Drawer open={open} onClose={() => setOpen(false)} title={<><b>Your slip</b> <span className="muted small">{n} leg{n > 1 ? "s" : ""}</span></>}>
        <div className="slip-legs">
          {slip.draft.map((l) => (
            <div key={l.id} className="slip-leg">
              <div>
                <div><b>{l.player_name}</b> <span className="muted small">{l.position ?? ""} · {l.team ?? ""} · {l.matchup.replace("@", " @ ")}</span></div>
                <div className="small">{l.market_label} <b className={l.side === "over" || l.side === "yes" ? "over" : "under"}>{sideLabel(l)}</b> <span className="faint tiny">{l.book ? (meta?.books[l.book] ?? l.book) : "consensus"} · wk {l.week}</span></div>
              </div>
              <button className="btn sm ghost" onClick={() => slip.remove(l.id)} aria-label={`Remove ${l.player_name}`}>✕</button>
            </div>
          ))}
        </div>
        {pairs.length > 0 && (
          <div className="slip-pairs">
            <div className="hint" style={{ marginBottom: 6 }}>Legs from the same game don't move independently:</div>
            {pairs.map((p) => {
              const h = helps(p);
              return (
                <div key={`${p.a.id}|${p.b.id}`} className="small">
                  {p.a.player_name} &amp; {p.b.player_name}
                  {p.r === null ? <span className="muted"> · same game, no history between these two stats</span>
                    : <span className={h ? "over" : "under"}> · r {p.r.toFixed(2)} over {p.n} games, {h ? "these tend to hit together" : "these tend to pull against each other"}</span>}
                </div>
              );
            })}
          </div>
        )}
        <div className="slip-save">
          <input className="input" placeholder={n > 1 ? `${n}-leg parlay` : "Name (optional)"} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          <button className="btn primary" onClick={save}>{n > 1 ? "Save parlay" : "Save bet"}</button>
          <button className="btn ghost" onClick={slip.clearDraft}>Clear</button>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>Graded at the line shown here, not the closing line. Results show on <Link to="/bets" onClick={() => setOpen(false)}>My bets</Link> once the box score is in.</div>
      </Drawer>
    </>
  );
}
