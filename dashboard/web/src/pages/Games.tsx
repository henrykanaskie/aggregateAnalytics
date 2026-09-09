import { api, GamesResponse } from "../api";
import { Field, SampleBanner, SourceNote, Spinner, TeamTag } from "../components/common";
import { fmtLine, fmtOdds, fmtPct, fmtSpread } from "../lib/format";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

export default function Games() {
  const { meta, settings } = useMeta();
  const [week, setWeek] = useSticky<number | null>("games.week", null);
  const { data, loading, stale } = useQuery<GamesResponse>(meta ? api.games.url(undefined, week ?? meta.week, settings.includeSample) : null);
  const weeks = Array.from({ length: 22 }, (_, i) => i + 1);
  return (
    <div>
      <div className="page-head">
        <div><h1>Games</h1><div className="muted small">Spreads, totals and moneylines per book with opening numbers, next to the model's logged call.</div></div>
        <SourceNote sources={data?.sources ?? []} />{stale && <span className="hint"> <Spinner /> refreshing</span>}
      </div>
      {data && <SampleBanner sources={data.sources} />}
      <div className="panel" style={{ marginBottom: 12 }}><div className="controls"><Field label="Week"><select className="input" value={week ?? meta?.week ?? 1} onChange={(e) => setWeek(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select></Field></div></div>
      {loading && <div className="empty"><Spinner /></div>}
      <div className="grid grid-2" data-tour="games-grid">
        {data?.games.map((g) => {
          const pred = g.predictions[0];
          return (
            <div className="panel" key={g.game_id}>
              <div className="panel-head">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><TeamTag abbr={g.away_team} name /> <span className="muted">@</span> <TeamTag abbr={g.home_team} name /></div>
                <span className="hint">{g.gameday} {g.gametime}{g.home_score !== null ? ` · final ${g.away_score}-${g.home_score}` : ""}</span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th className="left">Book</th><th>{g.home_team} spread</th><th>{g.away_team} spread</th><th>Total</th><th>{g.home_team} ML</th><th>{g.away_team} ML</th></tr></thead>
                  <tbody>
                    <tr className="split-row"><td className="left muted">nflverse closing/reference</td><td className="num">{fmtSpread(g.spread_line === null ? null : -g.spread_line)}</td><td className="num">{fmtSpread(g.spread_line)}</td><td className="num">{fmtLine(g.total_line)}</td><td className="num">{fmtOdds(g.home_moneyline)}</td><td className="num">{fmtOdds(g.away_moneyline)}</td></tr>
                    {g.books.map((b) => {
                      const hs = b[`spreads:${g.home_team}`], as = b[`spreads:${g.away_team}`], ov = b["totals:Over"], un = b["totals:Under"], hm = b[`h2h:${g.home_team}`], am = b[`h2h:${g.away_team}`];
                      const cell = (x: any, kind: "spread" | "line" | "ml") => x ? <>{kind === "spread" ? fmtSpread(x.line) : kind === "line" ? fmtLine(x.line) : fmtOdds(x.price)}{kind !== "ml" && x.price !== null ? <span className="muted tiny"> {fmtOdds(x.price)}</span> : null}{x.open_line !== null && x.open_line !== undefined && x.open_line !== x.line ? <span className="tiny faint"> (o {kind === "spread" ? fmtSpread(x.open_line) : x.open_line})</span> : null}</> : "–";
                      return <tr key={b.book}><td className="left">{b.title}{b.source === "sample" && <span className="pill warn" style={{ marginLeft: 6 }}>sample</span>}</td><td className="num">{cell(hs, "spread")}</td><td className="num">{cell(as, "spread")}</td><td className="num">{cell(ov, "line")}{un?.price !== null && un ? <span className="muted tiny"> / {fmtOdds(un.price)}</span> : null}</td><td className="num">{cell(hm, "ml")}</td><td className="num">{cell(am, "ml")}</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8 }} className="small">
                {pred ? (
                  <span><span className="pill accent">{pred.model_version}</span> {pred.pred_margin >= 0 ? g.home_team : g.away_team} by <b className="num">{Math.abs(pred.pred_margin).toFixed(1)}</b> · {g.home_team} win prob <b className="num">{fmtPct(pred.pred_win_prob)}</b> · market at log time <span className="num">{fmtSpread(pred.market_spread === null ? null : -pred.market_spread)}</span> · edge <span className={`num ${pred.market_spread !== null && pred.pred_margin - pred.market_spread > 0 ? "over" : "under"}`}>{pred.market_spread === null ? "–" : (pred.pred_margin - pred.market_spread).toFixed(1)}</span> <span className="faint">logged {new Date(pred.logged_at).toLocaleString()}</span></span>
                ) : <span className="hint">no model prediction logged for this game</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
