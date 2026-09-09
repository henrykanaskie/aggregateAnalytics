import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Board as BoardT, BoardRow } from "../api";
import { Field, SampleBanner, Seg, SourceNote, Spinner } from "../components/common";
import { readSticky, useSticky } from "../lib/sticky";
import { applyScale } from "../lib/outliers";
import { useQuery } from "../lib/useQuery";
import { fmtDate, fmtDelta, fmtLine, fmtOdds, fmtPct } from "../lib/format";
import { useMeta } from "../state";

type SortKey = "spread" | "consensus" | "l5" | "l10" | "season" | "avg" | "player" | "moved" | "edge" | "pover";

// The positions with a button of their own; everything else a defender can be
// is what DEF means.
const SKILL = ["QB", "RB", "WR", "TE", "K"];
// One pairing per week, and stable across sources in a way event_id is not.
const gameKey = (r: { away_team: string; home_team: string }) => `${r.away_team}@${r.home_team}`;

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
              <div className="k">{a.kind}{a.severity >= 2 ? " · big" : ""}{a.team ? ` · ${a.team}` : ""}{a.at ? <span className="faint"> · {fmtDate(a.at)}</span> : null}</div>
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
  // Team used to be one abbreviation; carry an old saved pick into the set so
  // an upgrade does not quietly drop the filter someone left the board on.
  const [teams, setTeams] = useSticky<string[]>("board.teams", (() => { const t = readSticky("board.team", ""); return t ? [t] : []; })());
  const [games, setGames] = useSticky<string[]>("board.games", []);
  const [book, setBook] = useSticky("board.book", "");
  const [q, setQ] = useSticky("board.q", "");
  const [onlyFlag, setOnlyFlag] = useSticky("board.onlyFlag", false);
  const [minL10, setMinL10] = useSticky("board.minL10", 0);
  const [sort, setSort] = useSticky<{ k: SortKey; d: 1 | -1 }>("board.sort", { k: "spread", d: -1 });
  const [sortPicked, setSortPicked] = useSticky("board.sortPicked", false);
  const [scale, setScale] = useSticky("board.scale", settings.thresholdScale);

  // Sensitivity is deliberately not in the URL: it only changes which cells are
  // highlighted, and that is worked out below rather than re-pulled.
  const { data, loading, stale } = useQuery<BoardT>(meta ? api.board.url({ week: week ?? meta.week, include_sample: settings.includeSample }) : null);
  const { rows: scaledRows, alerts } = useMemo(() => applyScale(data, scale), [data, scale]);

  useEffect(() => {
    // Only while the sort is still the default one: the board refetches on
    // every visit, and this used to throw away a column the user had clicked.
    if (!data || sortPicked) return;
    // With a single book there is no spread between books to sort by; line movement is the interesting column.
    const multi = data.rows.some((r) => r.n_books > 1);
    setSort((s) => (s.k === "spread" && !multi ? { k: "moved", d: -1 } : s.k === "moved" && multi ? { k: "spread", d: -1 } : s));
  }, [data, sortPicked]);

  const books = useMemo(() => {
    const set = new Set<string>();
    data?.rows.forEach((r) => r.books.forEach((b) => set.add(b.book)));
    const order = Object.keys(meta?.books ?? {});
    return [...set].sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  }, [data, meta]);
  const marketOptions = useMemo(() => { const s = new Set(data?.rows.map((r) => r.market)); return (meta?.markets ?? []).filter((m) => s.has(m.key)); }, [data, meta]);
  // Teams and games come off the board itself rather than the league list, so
  // every option in the pickers has rows behind it and relocated franchises
  // (LA/LAR, OAK/LV) can never disagree with the feed.
  const teamOptions = useMemo(() => {
    const s = new Set<string>();
    data?.rows.forEach((r) => { if (r.team) s.add(r.team); s.add(r.home_team); s.add(r.away_team); });
    if (s.size === 0) (meta?.teams ?? []).forEach((t) => { if (!["OAK", "SD", "STL", "LAR"].includes(t.team_abbr)) s.add(t.team_abbr); });
    return [...s].sort();
  }, [data, meta]);
  const matchupOptions = useMemo(() => {
    // Keyed on the pairing, not event_id: two sources can number the same game
    // differently, and a pairing happens at most once in a week.
    const m = new Map<string, { v: string; l: string; at: number }>();
    data?.rows.forEach((r) => {
      const v = gameKey(r);
      if (!m.has(v)) m.set(v, { v, l: `${r.away_team} @ ${r.home_team}`, at: r.commence_time ? Date.parse(r.commence_time) : 0 });
    });
    return [...m.values()].sort((a, b) => (a.at || Infinity) - (b.at || Infinity) || a.l.localeCompare(b.l));
  }, [data]);

  const rows = useMemo(() => {
    let r = scaledRows;
    if (markets.length) r = r.filter((x) => markets.includes(x.market));
    // DEF is "a defender", not "anything we could not identify": a prop whose
    // player never matched the index has no position and belongs in neither.
    if (pos) r = r.filter((x) => (pos === "DEF" ? !!x.position && !SKILL.includes(x.position) : x.position === pos));
    // Teams are the player's own side; the whole game is what Matchup is for.
    if (teams.length) r = r.filter((x) => (x.team ? teams.includes(x.team) : teams.includes(x.home_team) || teams.includes(x.away_team)));
    if (games.length) r = r.filter((x) => games.includes(gameKey(x)));
    if (book) r = r.filter((x) => x.books.some((b) => b.book === book));
    if (onlyFlag) r = r.filter((x) => x.outliers.length > 0);
    if (minL10 > 0) r = r.filter((x) => { const rate = x.form?.l10?.rate; return rate !== null && rate !== undefined && (rate >= minL10 || rate <= 1 - minL10); });
    // Typing an abbreviation is the fastest way to a team, so the box matches
    // one as well as a name; trimmed, because a trailing space matched nothing.
    const qq = q.trim().toLowerCase();
    if (qq) r = r.filter((x) => x.player_name.toLowerCase().includes(qq) || (x.team ?? "").toLowerCase() === qq);
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
  }, [scaledRows, markets, pos, teams, games, book, onlyFlag, minL10, q, sort]);

  const th = (k: SortKey, label: string) => <th onClick={() => { setSortPicked(true); setSort((s) => (s.k === k ? { k, d: s.d === -1 ? 1 : -1 } : { k, d: -1 })); }}>{label} {sort.k === k ? (sort.d === -1 ? "↓" : "↑") : ""}</th>;
  const weeks = Array.from({ length: 22 }, (_, i) => i + 1);
  const rate = (w?: { rate: number | null; over: number; n: number } | null) => w && w.rate !== null ? <span className={w.rate >= 0.6 ? "over" : w.rate <= 0.4 ? "under" : ""} title={`${w.over}/${w.n}`}>{fmtPct(w.rate)}</span> : <span className="muted">–</span>;

  // A picker that adds to a set rather than replacing it: the select stays on
  // its placeholder and what has been chosen shows up as chips underneath.
  const add = (set: (v: string[]) => void, cur: string[], v: string) => { if (v && !cur.includes(v)) set([...cur, v]); };
  const picked = (cur: string[], set: (v: string[]) => void, label: (v: string) => string) =>
    cur.map((v) => <span key={v} className="chip on">{label(v)}<button title="remove" onClick={() => set(cur.filter((x) => x !== v))}>×</button></span>);

  // How many rows the filters are hiding, so an empty table can say why.
  const active = markets.length + teams.length + games.length + (pos ? 1 : 0) + (book ? 1 : 0) + (q.trim() ? 1 : 0) + (onlyFlag ? 1 : 0) + (minL10 > 0 ? 1 : 0);
  const clearAll = () => { setMarkets([]); setTeams([]); setGames([]); setPos(""); setBook(""); setQ(""); setOnlyFlag(false); setMinL10(0); };

  return (
    <div>
      <div className="page-head">
        <div><h1>Lines board</h1><div className="muted small">Every posted player prop this week across books. Consensus is the median; highlighted cells sit at least one threshold away from it.</div></div>
        <SourceNote sources={data?.sources ?? []} pulled={data?.pulled_at} />
      </div>
      {data && <SampleBanner sources={data.sources} />}
      {alerts.length > 0 && <AlertsPanel alerts={alerts} onPick={(a) => a.player_id && nav(`/research?player=${a.player_id}${a.market ? `&market=${a.market}` : ""}`)} />}
      <div className="panel" style={{ marginBottom: 12 }} data-tour="board-filters">
        <div className="controls">
          <Field label="Week"><select className="input" value={week ?? meta?.week ?? 1} onChange={(e) => setWeek(Number(e.target.value))}>{weeks.map((w) => <option key={w} value={w}>Week {w}</option>)}</select></Field>
          <Field label="Player"><input className="input" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Position"><Seg value={pos} options={[{ v: "", l: "All" }, { v: "QB", l: "QB" }, { v: "RB", l: "RB" }, { v: "WR", l: "WR" }, { v: "TE", l: "TE" }, { v: "K", l: "K" }, { v: "DEF", l: "DEF" }]} onChange={setPos} /></Field>
          <Field label="Teams"><select className="input" value="" onChange={(e) => add(setTeams, teams, e.target.value)}><option value="">{teams.length ? `${teams.length} selected` : "All"}</option>{teamOptions.filter((t) => !teams.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          <Field label="Matchup"><select className="input" value="" onChange={(e) => add(setGames, games, e.target.value)}><option value="">{games.length ? `${games.length} selected` : "All"}</option>{matchupOptions.filter((g) => !games.includes(g.v)).map((g) => <option key={g.v} value={g.v}>{g.l}</option>)}</select></Field>
          <Field label="Book"><select className="input" value={book} onChange={(e) => setBook(e.target.value)}><option value="">Any</option>{books.map((b) => <option key={b} value={b}>{meta?.books[b] ?? b}</option>)}</select></Field>
          <Field label="Outlier sensitivity"><Seg value={scale} options={[{ v: 0.5, l: "High" }, { v: 1, l: "Normal" }, { v: 2, l: "Low" }]} onChange={setScale} /></Field>
          <Field label="Only"><button className={`chip ${onlyFlag ? "on" : ""}`} onClick={() => setOnlyFlag(!onlyFlag)}>flagged books</button></Field>
          <Field label="L10 trend"><Seg value={minL10} options={[{ v: 0, l: "Any" }, { v: 0.7, l: "≥70% one side" }, { v: 0.8, l: "≥80%" }, { v: 0.9, l: "≥90%" }]} onChange={setMinL10} /></Field>
        </div>
        {(teams.length > 0 || games.length > 0) && (
          <div className="chips" style={{ marginTop: 10 }}>
            {picked(teams, setTeams, (t) => t)}
            {picked(games, setGames, (g) => g.replace("@", " @ "))}
          </div>
        )}
        <div className="chips" style={{ marginTop: 10 }}>
          {marketOptions.map((m) => <button key={m.key} className={`chip ${markets.includes(m.key) ? "on" : ""}`} onClick={() => setMarkets(markets.includes(m.key) ? markets.filter((x) => x !== m.key) : [...markets, m.key])}>{m.label}</button>)}
          {markets.length > 0 && <button className="chip" onClick={() => setMarkets([])}>clear markets</button>}
          {active > 0 && <button className="chip" onClick={clearAll}>clear all filters · {active}</button>}
        </div>
      </div>
      <div className="panel" data-tour="board-table">
        <div className="panel-head"><h3>{rows.length} props{(loading || stale) && <> <Spinner /></>}</h3><span className="hint">click a row to research the player</span></div>
        {!loading && rows.length === 0 && (
          // Filters are sticky and outlive the week they were set in, so an
          // empty table is far more often one of those than a missing pull.
          <div className="empty">{scaledRows.length > 0
            ? <>None of the {scaledRows.length} props this week match the filters. <button className="btn sm" onClick={clearAll}>Clear filters</button></>
            : "No lines for this week. Pull one from Settings, ESPN is free and needs no key."}</div>
        )}
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
