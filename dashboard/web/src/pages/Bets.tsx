import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiSlip, LegResult } from "../api";
import { Banner, Spinner } from "../components/common";
import { fmtPct } from "../lib/format";
import { sideLabel, useSlip } from "../lib/slip";
import { Parlay, readShared, shareLink } from "../lib/slipStore";
import { useMeta } from "../state";

type Status = LegResult["status"];
type Verdict = "hit" | "miss" | "push" | "pending";

/** A parlay dies on its first miss and waits on anything unplayed. Pushed and
 *  voided legs drop out, the way books settle them; all of them out is a push. */
function verdict(results: (LegResult | undefined)[]): Verdict {
  const s = results.map((r) => r?.status ?? "pending");
  if (s.includes("miss")) return "miss";
  if (s.some((x) => x === "pending" || x === "unknown")) return "pending";
  return s.includes("hit") ? "hit" : "push";
}

const TONE: Record<Status | Verdict, string> = { hit: "over", miss: "under", push: "push", void: "muted", pending: "muted", unknown: "muted" };
const WORD: Record<Status | Verdict, string> = { hit: "Hit", miss: "Miss", push: "Push", void: "Void", pending: "Pending", unknown: "?" };

export default function Bets() {
  const { meta } = useMeta();
  const slip = useSlip();
  const [results, setResults] = useState<Record<string, LegResult>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shared] = useState<Parlay | null>(() => { try { return readShared(window.location.search); } catch { return null; } });

  const legs = useMemo(() => slip.parlays.flatMap((p) => p.legs), [slip.parlays]);
  const sig = legs.map((l) => l.id).join(",");
  const load = () => {
    if (!legs.length) return;
    setLoading(true); setErr(null);
    apiSlip.grade(legs.map(({ id, season, week, game_id, player_id, market, side, line }) => ({ id, season, week, game_id, player_id, market, side, line })))
      .then((rs) => setResults(Object.fromEntries(rs.map((r) => [r.id, r]))))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sig]);

  // Newest week first; a parlay spanning weeks sits under its last one.
  const byWeek = useMemo(() => {
    const m = new Map<string, Parlay[]>();
    for (const p of slip.parlays) {
      const last = p.legs.reduce((a, l) => (l.season * 100 + l.week > a.season * 100 + a.week ? l : a), p.legs[0]);
      const k = `${last.season}-${String(last.week).padStart(2, "0")}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [slip.parlays]);

  const tally = useMemo(() => {
    const leg = { hit: 0, miss: 0, pending: 0 };
    const par = { hit: 0, miss: 0, pending: 0 };
    const market = new Map<string, { label: string; hit: number; n: number }>();
    for (const l of legs) {
      const s = results[l.id]?.status;
      if (s === "hit" || s === "miss") {
        leg[s]++;
        const m = market.get(l.market) ?? { label: l.market_label, hit: 0, n: 0 };
        m.n++; if (s === "hit") m.hit++;
        market.set(l.market, m);
      } else if (!s || s === "pending") leg.pending++;
    }
    // Singles are already counted as legs; the parlay record is the multi-leg ones.
    for (const p of slip.parlays) if (p.legs.length > 1) { const v = verdict(p.legs.map((l) => results[l.id])); if (v !== "push") par[v]++; }
    return { leg, par, market: [...market.values()].sort((a, b) => b.n - a.n) };
  }, [legs, results, slip.parlays]);

  const share = async (p: Parlay) => {
    try { const url = shareLink(p); await navigator.clipboard.writeText(url); setNote(`Link to "${p.name}" copied.`); }
    catch (e) { setNote(String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>My bets</h1><div className="muted small">The picks you saved from the Lines board, each graded at the line you took. Box scores land Monday, Tuesday and Friday mornings.</div></div>
        {legs.length > 0 && <button className="btn" onClick={load} disabled={loading}>{loading ? <Spinner /> : "Refresh"}</button>}
      </div>
      {shared && !slip.parlays.some((p) => p.id === shared.id) && (
        <Banner>Someone shared "{shared.name}" ({shared.legs.length} leg{shared.legs.length > 1 ? "s" : ""}). <button className="btn sm" onClick={() => slip.importParlay(shared)}>Add it to my bets</button></Banner>
      )}
      {note && <Banner>{note}</Banner>}
      {err && <Banner kind="err">Couldn't grade: {err}</Banner>}

      {!slip.parlays.length ? (
        <div className="panel empty">Nothing saved yet. On the <Link to="/board">Lines board</Link>, use <b>+O</b> / <b>+U</b> on any prop to start a slip, then save it from the slip drawer.</div>
      ) : (
        <>
          <div className="tiles" style={{ marginBottom: 12 }}>
            <div className="tile"><div className="k">Legs</div><div className="v">{tally.leg.hit + tally.leg.miss ? fmtPct(tally.leg.hit / (tally.leg.hit + tally.leg.miss)) : "–"}</div><div className="s">{tally.leg.hit}–{tally.leg.miss}{tally.leg.pending ? ` · ${tally.leg.pending} pending` : ""}</div></div>
            <div className="tile"><div className="k">Parlays</div><div className="v">{tally.par.hit}–{tally.par.miss}</div><div className="s">{tally.par.pending ? `${tally.par.pending} still live` : "multi-leg only"}</div></div>
            {tally.market.slice(0, 3).map((m) => <div key={m.label} className="tile"><div className="k">{m.label}</div><div className="v">{fmtPct(m.hit / m.n)}</div><div className="s">{m.hit} of {m.n} legs</div></div>)}
          </div>
          {byWeek.map(([k, ps]) => (
            <div key={k} className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head"><h3>{k.split("-")[0]} · Week {Number(k.split("-")[1])}</h3></div>
              <div className="bets">
                {ps.map((p) => {
                  const v = verdict(p.legs.map((l) => results[l.id]));
                  return (
                    <div key={p.id} className={`bet bet-${v}`}>
                      <div className="bet-head">
                        <div><b>{p.name}</b> <span className={`bet-verdict ${TONE[v]}`}>{loading && !Object.keys(results).length ? <Spinner /> : WORD[v]}</span></div>
                        <div className="bet-actions">
                          <button className="btn sm ghost" onClick={() => share(p)}>Share</button>
                          <button className="btn sm ghost" onClick={() => { if (confirm(`Delete "${p.name}"?`)) slip.deleteParlay(p.id); }}>Delete</button>
                        </div>
                      </div>
                      <table className="tbl compact">
                        <tbody>
                          {p.legs.map((l) => {
                            const r = results[l.id];
                            const s: Status = r?.status ?? "pending";
                            return (
                              <tr key={l.id}>
                                <td className="left"><Link to={`/research?player=${l.player_id}&market=${l.market}`}>{l.player_name}</Link> <span className="muted small">{l.team ?? ""}</span></td>
                                <td className="left small">{l.market_label}</td>
                                <td className="left small"><b className={l.side === "over" || l.side === "yes" ? "over" : "under"}>{sideLabel(l)}</b> <span className="faint tiny">{l.book ? (meta?.books[l.book] ?? l.book) : "cons."}</span></td>
                                <td className="num">{r?.actual ?? "–"}</td>
                                <td className={`num ${TONE[s]}`}><b>{WORD[s]}</b></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
