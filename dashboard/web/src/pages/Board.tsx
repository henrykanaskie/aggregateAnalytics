import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Board as BoardT, BoardRow } from "../api";
import { Field, SampleBanner, Seg, SourceNote, Spinner } from "../components/common";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { fmtDelta, fmtLine, fmtOdds, fmtPct } from "../lib/format";
import { useMeta } from "../state";

type SortKey = "spread" | "consensus" | "l5" | "l10" | "season" | "avg" | "player" | "moved" | "edge" | "pover";

function AlertsPanel({ alerts, onPick }: { alerts: import("../api").Alert[]; onPick: (a: import("../api").Alert) => void }) {
  const [open, setOpen] = useState(true);
  const [kind, setKind] = useState<"all" | "move" | "outlier" | "injury">("all");
  const shown = alerts.filter((a) => kind === "all" || a.kind === kind);
  const counts = { move: alerts.filter((a) => a.kind === "move").length, outlier: alerts.filter((a) => a.kind === "outlier").length, injury: alerts.filter((a) => a.kind === "injury").length };
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h3 className="clickable" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} Alerts · {alerts.length}</h3>
        <div className="chips">
          <button className={`chip ${kind === "all" ? "on" : ""}`} onClick={() => setKind("all")}>all</button>
          <button className={`chip ${kind === "move" ? "on" : ""}`} onClick={() => setKind("move")}>line moves {counts.move}</button>
          <button className={`chip ${kind === "outlier" ? "on" : ""}`} onClick={() => setKind("outlier")}>book outliers {counts.outlier}</button>
          <button className={`chip ${kind === "injury" ? "on" : ""}`} onClick={() => setKind("injury")}>injuries {counts.injury}</button>
        </div>
      </div>
      {open && (
        <div className="grid grid-3" style={{ maxHeight: 260, overflow: "auto" }}>
          {shown.slice(0, 60).map((a, i) => (
            <div key={i} className="tile clickable" onClick={() => onPick(a)} style={{ borderLeft: `3px solid var(--${a.kind === "injury" ? "under" : a.kind === "move" ? "push" : "accent"})` }}>
              <div className="k">{a.kind}{a.severity >= 2 ? " · big" : ""}{a.team ? ` · ${a.team}` : ""}</div>
              <div className="small" style={{ fontWeight: 600 }}>{a.title}</div>
              <div className="tiny muted">{a.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Board() {
  const { meta, settings } = useMeta();
  const nav = useNavigate();
  // Filters live in sticky state: leaving the board and coming back should land
  // on the same view, not a reset one.
  const [week, setWeek] = useSticky<number | null>("board.week", null);
  const [markets, setMarkets] = useSticky<string[]>("board.markets", []);
  const [pos, setPos] = useSticky("board.pos", "");
  const [team, setTeam] = useSticky("board.team", "");
  const [book, setBook] = useSticky("board.book", "");
  const [q, setQ] = useSticky("board.q", "");
  const [onlyFlag, setOnlyFlag] = useSticky("board.onlyFlag", false);
  const [minL10, setMinL10] = useSticky("board.minL10", 0);
  const [sort, setSort] = useSticky<{ k: SortKey; d: 1 | -1 }>("board.sort", { k: "spread", d: -1 });
  const [scale, setScale] = useSticky("board.scale", settings.thresholdScale);

  const { data, loading, stale } = useQuery<BoardT>(meta ? api.board.url({ week: week ?? meta.week, include_sample: settings.includeSample, scale }) : null);

  useEffect(() => {
    if (!data) return;
    // With a single book there is no spread between books to sort by; line movement is the interesting column.
    const multi = data.rows.some((r) => r.n_books > 1);
    setSort((s) => (s.k === "spread" && !multi ? { k: "moved", d: -1 } : s.k === "moved" && multi ? { k: "spread", d: -1 } : s));
  }, [data]);

  const books = useMemo(() => {
    const set = new Set<string>();
    data?.rows.forEach((r) => r.books.forEach((b) => set.add(b.book)));
    const order = Object.keys(meta?.books ?? {});
    return [...set].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  }, [data, meta]);
  const marketOptions = useMemo(() => { const s = new Set(data?.rows.map((r) => r.market)); return (meta?.markets ?? []).filter((m) => s.has(m.key)); }, [data, meta]);

  const rows = useMemo(() => {
    let r = data?.rows ?? [];
    if (markets.length) r = r.filter((x) => markets.includes(x.market));
    if (pos) r = r.filter((x) => (pos === "DEF" ? !["QB", "RB", "WR", "TE", "K"].includes(x.position ?? "") : x.position === pos));
    if (team) r = r.filter((x) => x.team === team || x.home_team === team || x.away_team === team);
    if (book) r = r.filter((x) => x.books.some((b) => b.book === book));
    if (onlyFlag) r = r.filter((x) => x.outliers.length > 0);
    if (minL10 > 0) r = r.filter((x) => { const rate = x.form?.l10?.rate; return rate !== null && rate !== undefined && (rate >= minL10 || rate <= 1 - minL10); });
    if (q) { const qq = q.toLowerCase(); r = r.filter((x) => x.player_name.toLowerCase().includes(qq)); }
    const key = (x: BoardRow): number | string => {
      switch (sort.k) {
        case "spread": return x.line_spread;
        case "consensus": return x.consensus;
        case "l5": return x.form?.l5?.rate ?? -1;
        case "l10": return x.form?.l10?.rate ?? -1;
        case "season": return x.form?.season?.rate ?? -1;
        case "avg": return x.form?.avg !== undefined && x.form?.avg !== null && x.kind === "ou" ? x.form.avg - x.consensus : -999;
        case "edge": return x.proj?.edge !== null && x.proj?.edge !== undefined ? Math.abs(x.proj.edge) : -1;
        case "pover": return x.proj?.p_over ?? -1;
        case "moved": return Math.max(...x.books.map((b) => Math.abs(b.moved ?? 0)), 0) + (x.form?.l10?.rate !== null && x.form?.l10?.rate !== undefined ? Math.abs(x.form.l10.rate - 0.5) / 100 : 0);
        default: return x.player_name;
      }
    };
    return [...r].sort((a, b) => { const A = key(a), B = key(b); return (A > B ? 1 : A < B ? -1 : 0) * sort.d; });
  }, [data, markets, pos, team, book, onlyFlag, minL10, q, sort]);

  const th = (k: SortKey, label: string) => <th onClick={() => setSort((s) => (s.k === k ? { k, d: s.d === -1 ? 1 : -1 } : { k, d: -1 }))}>{label} {sort.k === k ? (sort.d === -1 ? "↓" : "↑") : ""}</th>;
  const weeks = Array.from({ length: 22 }, (_, i) => i + 1);
  const rate = (w?: { rate: number | null; over: number; n: number } | null) => w && w.rate !== null ? <span className={w.rate >= 0.6 ? "over" : w.rate <= 0.4 ? "under" : ""} title={`${w.over}/${w.n}`}>{fmtPct(w.rate)}</span> : <span className="muted">–</span>;

  return (
    <div>
      <div className="page-head">
        <div><h1>Lines board</h1><div className="muted small">Every posted player prop this week across books. Consensus is the median; highlighted cells sit at least one threshold away from it.</div></div>
        <SourceNote sources={data?.sources ?? []} pulled={data?.pulled_at} />
      </div>
      {data && <SampleBanner sources={data.sources} />}
      {data && data.alerts && data.alerts.length > 0 && <AlertsPanel alerts={data.alerts} onPick={(a) => a.player_id && nav(`/research?player=${a.player_id}${a.market ? `&market=${a.market}` : ""}`)} />}
      <div className="panel" style={{ marginBottom: 12 }} data-tour="board-filters">
        <div className="controls">
          <Field label="Week"><select className="input" value={week ?? meta?.week ?? 1} onChange={(e) => setWeek(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select></Field>
          <Field label="Player"><input className="input" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Position"><Seg value={pos} options={[{ v: "", l: "All" }, { v: "QB", l: "QB" }, { v: "RB", l: "RB" }, { v: "WR", l: "WR" }, { v: "TE", l: "TE" }, { v: "K", l: "K" }, { v: "DEF", l: "DEF" }]} onChange={setPos} /></Field>
          <Field label="Team"><select className="input" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All</option>{(meta?.teams ?? []).filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr)).map((t) => <option key={t.team_abbr} value={t.team_abbr}>{t.team_abbr}</option>)}</select></Field>
          <Field label="Book"><select className="input" value={book} onChange={(e) => setBook(e.target.value)}><option value="">Any</option>{books.map((b) => <option key={b} value={b}>{meta?.books[b] ?? b}</option>)}</select></Field>
          <Field label="Outlier sensitivity"><Seg value={scale} options={[{ v: 0.5, l: "High" }, { v: 1, l: "Normal" }, { v: 2, l: "Low" }]} onChange={setScale} /></Field>
          <Field label="Only"><button className={`chip ${onlyFlag ? "on" : ""}`} onClick={() => setOnlyFlag(!onlyFlag)}>flagged books</button></Field>
          <Field label="L10 trend"><Seg value={minL10} options={[{ v: 0, l: "Any" }, { v: 0.7, l: "≥70% one side" }, { v: 0.8, l: "≥80%" }, { v: 0.9, l: "≥90%" }]} onChange={setMinL10} /></Field>
        </div>
        <div className="chips" style={{ marginTop: 10 }}>
          {marketOptions.map((m) => <button key={m.key} className={`chip ${markets.includes(m.key) ? "on" : ""}`} onClick={() => setMarkets(markets.includes(m.key) ? markets.filter((x) => x !== m.key) : [...markets, m.key])}>{m.label}</button>)}
          {markets.length > 0 && <button className="chip" onClick={() => setMarkets([])}>clear</button>}
        </div>
      </div>
      <div className="panel" data-tour="board-table">
        <div className="panel-head"><h3>{rows.length} props{(loading || stale) && <> <Spinner /></>}</h3><span className="hint">click a row to research the player</span></div>
        {!loading && rows.length === 0 && <div className="empty">No lines for this week. Pull one from Settings, ESPN is free and needs no key.</div>}
        <div className="tbl-wrap" style={{ maxHeight: "72vh" }}>
          <table className="tbl compact tight">
            <thead>
              <tr>
                {th("player", "Player")}<th className="left">Game</th><th className="left">Market</th>
                {th("consensus", "Cons.")}
                {th("l5", "L5")}{th("l10", "L10")}{th("season", "Szn")}{th("avg", "Avg−line")}
                {th("edge", "Proj")}{th("pover", "P(over)")}
                {books.map((b) => <th key={b}>{meta?.books[b] ?? b}</th>)}
                {th("spread", "Spread")}{th("moved", "Move")}
                <th>Best O</th><th>Best U</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const byBook = new Map(r.books.map((b) => [b.book, b]));
                const maxMove = r.books.reduce((m, b) => (Math.abs(b.moved ?? 0) > Math.abs(m) ? (b.moved ?? 0) : m), 0);
                return (
                  <tr key={`${r.event_id}-${r.market}-${r.player_id ?? r.player_name}`} className="clickable" onClick={() => r.player_id && nav(`/research?player=${r.player_id}&market=${r.market}`)}>
                    <td className="left">{r.player_name} <span className="muted">{r.position ?? ""}</span></td>
                    <td className="left small"><b>{r.team ?? ""}</b> <span className="muted">{r.away_team}@{r.home_team}</span></td>
                    <td className="left">{r.market_label}</td>
                    <td className="num"><b>{r.kind === "ou" ? fmtLine(r.consensus) : fmtPct(r.consensus)}</b></td>
                    <td className="num">{rate(r.form?.l5)}</td>
                    <td className="num">{rate(r.form?.l10)}</td>
                    <td className="num">{rate(r.form?.season)}</td>
                    <td className={`num ${r.form && r.kind === "ou" ? (r.form.avg - r.consensus > 0 ? "over" : "under") : "muted"}`}>{r.form && r.kind === "ou" ? fmtDelta(r.form.avg - r.consensus) : r.form ? `${r.form.avg.toFixed(2)} td/g` : "–"}</td>
                    <td className={`num ${r.proj?.edge ? (r.proj.edge > 0 ? "over" : "under") : "muted"}`} title={r.proj ? `baseline ${r.proj.value} (last ${r.proj.n}, ×${r.proj.factor} opp)` : ""}>{r.proj ? <>{r.kind === "ou" ? r.proj.value.toFixed(1) : r.proj.value.toFixed(2)}{r.proj.edge !== null ? <span className="tiny"> {fmtDelta(r.proj.edge)}</span> : null}</> : "–"}</td>
                    <td className={`num ${r.proj?.p_over !== null && r.proj?.p_over !== undefined ? (r.proj.p_over >= 0.6 ? "over" : r.proj.p_over <= 0.4 ? "under" : "") : "muted"}`}>{r.proj?.p_over !== null && r.proj?.p_over !== undefined ? fmtPct(r.proj.p_over) : "–"}</td>
                    {books.map((b) => { const x = byBook.get(b); if (!x) return <td key={b} className="muted">–</td>; return <td key={b} className={`num ${x.flag ? `cell-${x.flag}` : ""}`} title={r.kind === "ou" ? `O ${fmtOdds(x.over)} / U ${fmtOdds(x.under)}${x.open_line !== null ? ` · open ${x.open_line}` : ""}` : `Yes ${fmtOdds(x.yes)}`}>{r.kind === "ou" ? fmtLine(x.line) : fmtOdds(x.yes)}</td>; })}
                    <td className={`num ${r.line_spread > 0 ? "push" : "muted"}`}>{r.kind === "ou" ? r.line_spread : fmtPct(r.line_spread)}</td>
                    <td className={`num ${maxMove > 0 ? "over" : maxMove < 0 ? "under" : "muted"}`}>{maxMove ? fmtDelta(maxMove) : "–"}</td>
                    <td className="num" title={r.best_over ? `${meta?.books[r.best_over.book] ?? r.best_over.book} at ${r.best_over.line ?? ""}` : undefined}>{r.best_over ? fmtOdds(r.best_over.price) : "–"}</td>
                    <td className="num" title={r.best_under ? `${meta?.books[r.best_under.book] ?? r.best_under.book} at ${r.best_under.line ?? ""}` : undefined}>{r.best_under ? fmtOdds(r.best_under.price) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
