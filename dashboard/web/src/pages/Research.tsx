import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, BoardRow, BookLine, GameLog, Player, PlayerLines } from "../api";
import { Field, SampleBanner, Seg, SourceNote, Spinner } from "../components/common";
import BookLines from "../components/BookLines";
import GameLogTable from "../components/GameLogTable";
import Histogram from "../components/Histogram";
import LineHistory from "../components/LineHistory";
import MiniCharts from "../components/MiniCharts";
import PlayerHeader from "../components/PlayerHeader";
import PlayerSearch from "../components/PlayerSearch";
import PropChart from "../components/PropChart";
import SplitsTable from "../components/SplitsTable";
import StatPicker from "../components/StatPicker";
import StatTiles from "../components/StatTiles";
import { fmtLine, fmtOdds } from "../lib/format";
import { applyFilters, DEFAULT_FILTERS, Filters, DEFAULT_MARKET_FOR, presetFor, suggestLine } from "../lib/stats";
import { useMeta } from "../state";
import Splits from "../components/PbpSplits";
import MatchupPanel from "../components/MatchupPanel";
import InjuryPanel from "../components/InjuryPanel";
import { importantStats } from "../lib/focus";

export default function Research() {
  const { meta, settings, setSettings, statByKey, marketByKey } = useMeta();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const pid = sp.get("player");
  const [player, setPlayer] = useState<Player | null>(null);
  const [log, setLog] = useState<GameLog | null>(null);
  const [lines, setLines] = useState<PlayerLines | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // What is being charted. "market" selects a stat + a line from the books; a bare "stat" uses a custom line.
  const market = sp.get("market");
  const statKey = sp.get("stat") || (market ? marketByKey.get(market)?.stat ?? "receiving_yards" : "receiving_yards");
  const [lineSource, setLineSource] = useState<string>(settings.preferredBook || "consensus"); // consensus | <book> | custom
  const [customLine, setCustomLine] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, n: settings.nGames });
  const [columns, setColumns] = useState<string[]>([]);
  const [miniKeys, setMiniKeys] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [rollWin, setRollWin] = useState(5);

  useEffect(() => {
    if (!pid) { setPlayer(null); setLog(null); setLines(null); return; }
    setLoading(true); setErr(null); setPicked(null);
    Promise.all([api.player(pid), api.gamelog(pid, settings.since), api.playerLines(pid, undefined, undefined, settings.includeSample)])
      .then(([p, g, l]) => {
        setPlayer(p); setLog(g); setLines(l);
        const preset = presetFor(p.position).filter((k) => (g.available[k] ?? 0) > 0);
        setColumns(preset.slice(0, 6));
        setMiniKeys(preset.slice(0, 4));
        if (!sp.get("market") && !sp.get("stat")) {
          // Default to the first market the books actually posted for this player, else the position's usual one.
          const first = l.markets.find((m) => m.kind === "ou") ?? null;
          const fallback = DEFAULT_MARKET_FOR[p.position] ?? DEFAULT_MARKET_FOR.DEF;
          const next = new URLSearchParams(sp);
          next.set("market", first?.market ?? fallback);
          setSp(next, { replace: true });
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, settings.since, settings.includeSample]);

  const marketRow: BoardRow | null = useMemo(() => lines?.markets.find((m) => m.market === market) ?? null, [lines, market]);
  const allRows = log?.rows ?? [];
  const filtered = useMemo(() => applyFilters(allRows, filters), [allRows, filters]);
  const stat = statByKey.get(statKey);
  const important = useMemo(() => (settings.focus && player ? new Set(importantStats(market, statKey, player.position)) : null), [settings.focus, player, market, statKey]);
  const seasons = useMemo(() => [...new Set(allRows.map((r) => r.season))].sort((a, b) => b - a), [allRows]);
  const opponents = useMemo(() => [...new Set(allRows.map((r) => r.opponent))].sort(), [allRows]);
  const qbs = useMemo(() => { const m = new Map<string, number>(); for (const r of allRows) if (r.qb_name) m.set(r.qb_name, (m.get(r.qb_name) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); }, [allRows]);

  // Resolve the line.
  const line: number | null = useMemo(() => {
    if (lineSource === "custom") return customLine;
    if (marketRow && marketRow.kind === "ou") {
      if (lineSource === "consensus") return marketRow.consensus;
      const b = marketRow.books.find((x) => x.book === lineSource);
      if (b?.line !== null && b?.line !== undefined) return b.line;
      return marketRow.consensus;
    }
    if (marketRow && marketRow.kind === "yesno") return 0.5;
    return customLine;
  }, [lineSource, customLine, marketRow]);

  useEffect(() => {
    // When a stat has no market line, seed the custom line from recent games.
    if (!marketRow && allRows.length) { setCustomLine(suggestLine(allRows, statKey)); setLineSource("custom"); }
    else if (marketRow && lineSource === "custom" && customLine === null) setLineSource(settings.preferredBook || "consensus");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketRow, statKey, allRows]);

  useEffect(() => {
    if (important && log) setColumns((cols) => [...new Set([...[...important].filter((k) => (log.available[k] ?? 0) > 0), ...cols])].slice(0, 9));
    if (important && log) setMiniKeys([...important].filter((k) => k !== statKey && (log.available[k] ?? 0) > 0).slice(0, 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [important]);
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const chooseMarket = (key: string) => { const n = new URLSearchParams(sp); n.set("market", key); n.delete("stat"); setSp(n); if (lineSource === "custom") setLineSource(settings.preferredBook || "consensus"); };
  const chooseStat = (key: string) => {
    // Prefer a market that maps to this stat so the books' line comes along.
    const m = lines?.markets.find((x) => x.stat === key);
    const n = new URLSearchParams(sp);
    if (m) { n.set("market", m.market); n.delete("stat"); } else { n.set("stat", key); n.delete("market"); }
    setSp(n);
  };

  if (!pid) {
    return (
      <div>
        <div className="page-head"><h1>Player research</h1></div>
        <div className="panel" style={{ maxWidth: 720 }}>
          <p className="muted" style={{ marginTop: 0 }}>Pick a player to see every game they have played against any stat, with the sportsbook line drawn over it. Any player who has recorded a stat line since 1999 is in here.</p>
          <PlayerSearch autoFocus onSelect={(p) => nav(`/research?player=${p.player_id}`)} />
          <QuickPicks />
        </div>
      </div>
    );
  }

  return (
    <div>
      {err && <div className="banner err">{err}</div>}
      {loading && !player && <div className="empty"><Spinner /> loading…</div>}
      {player && (
        <div className={settings.focus ? "focus-on" : ""}>
          <div className="panel" style={{ marginBottom: 14, display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ flex: 1 }}><PlayerHeader p={player} game={lines?.game ?? null} /></div>
            <button className={`btn focus-toggle ${settings.focus ? "on" : ""}`} title="Highlight the stats that matter for this player and prop; dim the rest" onClick={() => setSettings({ focus: !settings.focus })}>{settings.focus ? "★ Focus on" : "☆ Focus"}</button>
          </div>
          {lines && <SampleBanner sources={lines.sources} />}

          {/* Prop / stat selection */}
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">
              <h3>Props with lines this week</h3>
              <SourceNote sources={lines?.sources ?? []} />
            </div>
            <div className="chips" style={{ marginBottom: 12 }}>
              {(lines?.markets ?? []).length === 0 && <span className="muted small">No lines posted for this player yet. Choose any stat below and set your own line.</span>}
              {(lines?.markets ?? []).map((m) => (
                <button key={m.market} className={`chip ${market === m.market ? "on" : ""} ${important && market !== m.market ? "dim" : ""}`} onClick={() => chooseMarket(m.market)} title={`${m.n_books} book(s)`}>
                  {m.market_label} <b className="num">{m.kind === "ou" ? fmtLine(m.consensus) : fmtOdds(m.best_over?.price ?? null)}</b>
                  {m.outliers.length > 0 && <span className="pill warn" title={`outlier: ${m.outliers.join(", ")}`}>!</span>}
                </button>
              ))}
            </div>
            <div className="controls">
              <Field label="Stat"><StatPicker value={statKey} onChange={chooseStat} available={log?.available} position={player.position} important={important} /></Field>
              <Field label="Line source">
                <select className="input" value={lineSource} onChange={(e) => setLineSource(e.target.value)}>
                  {marketRow && marketRow.kind === "ou" && <option value="consensus">Consensus (median of {marketRow.n_books})</option>}
                  {marketRow && marketRow.kind === "ou" && marketRow.books.map((b) => <option key={b.book} value={b.book}>{b.title}: {fmtLine(b.line)}</option>)}
                  <option value="custom">Custom line</option>
                </select>
              </Field>
              <Field label="Line"><input className="input num" type="number" step="0.5" value={line ?? ""} onChange={(e) => { setCustomLine(e.target.value === "" ? null : Number(e.target.value)); setLineSource("custom"); }} /></Field>
              <Field label="Last N games"><input className="input num" type="number" min={1} value={filters.n ?? ""} placeholder="all" onChange={(e) => setFilters({ ...filters, n: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
              <Field label="Games"><Seg value={filters.seasonType} options={[{ v: "ALL", l: "All" }, { v: "REG", l: "Regular" }, { v: "POST", l: "Playoffs" }]} onChange={(v) => setFilters({ ...filters, seasonType: v })} /></Field>
              <Field label="Venue"><Seg value={filters.venue} options={[{ v: "ALL", l: "All" }, { v: "HOME", l: "Home" }, { v: "AWAY", l: "Away" }]} onChange={(v) => setFilters({ ...filters, venue: v })} /></Field>
              <Field label="Role"><Seg value={filters.role} options={[{ v: "ALL", l: "All" }, { v: "FAV", l: "Fav" }, { v: "DOG", l: "Dog" }]} onChange={(v) => setFilters({ ...filters, role: v })} /></Field>
              <Field label="Opponent"><select className="input" value={filters.opponent ?? ""} onChange={(e) => setFilters({ ...filters, opponent: e.target.value || null })}><option value="">Any</option>{opponents.map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
              <Field label="Weather"><Seg value={filters.weather} options={[{ v: "ALL", l: "All" }, { v: "INDOORS", l: "Dome" }, { v: "OUTDOORS", l: "Outdoors" }, { v: "COLD", l: "Cold" }, { v: "WINDY", l: "Windy" }]} onChange={(v) => setFilters({ ...filters, weather: v })} /></Field>
              {player.position !== "QB" && qbs.length > 1 && <Field label="Starting QB"><select className="input" value={filters.qb ?? ""} onChange={(e) => setFilters({ ...filters, qb: e.target.value || null })}><option value="">Any</option>{qbs.map(([q, n]) => <option key={q} value={q}>{q} ({n})</option>)}</select></Field>}
              <Field label="Min snap %"><input className="input num" type="number" min={0} max={100} step={5} value={filters.minSnapPct === null ? "" : filters.minSnapPct * 100} placeholder="–" onChange={(e) => setFilters({ ...filters, minSnapPct: e.target.value === "" ? null : Number(e.target.value) / 100 })} /></Field>
              <Field label="Seasons">
                <div className="chips">
                  {seasons.map((s) => { const on = !filters.seasons || filters.seasons.includes(s); return <button key={s} className={`chip ${on ? "on" : ""}`} onClick={() => { const cur = filters.seasons ?? seasons; const next = on ? cur.filter((x) => x !== s) : [...cur, s]; setFilters({ ...filters, seasons: next.length === seasons.length ? null : next }); }}>{s}</button>; })}
                </div>
              </Field>
            </div>
          </div>

          <div className="grid grid-main">
            <div className="grid" style={{ gap: 14 }}>
              <div className="panel">
                <div className="panel-head">
                  <div><h2>{stat?.label ?? statKey}{marketRow ? <span className="muted"> · {marketRow.market_label} line {line}</span> : line !== null ? <span className="muted"> · custom line {line}</span> : null}</h2>{stat?.note && <div className="hint">{stat.note}</div>}</div>
                  <div className="actions">
                    <span className="legend"><span><i style={{ background: "var(--over)" }} />over</span><span><i style={{ background: "var(--under)" }} />under</span><span><i style={{ background: "var(--push)" }} />push</span><span><i style={{ background: "var(--accent)", height: 2 }} />rolling avg</span></span>
                    <Field label="Rolling"><Seg value={rollWin} options={[{ v: 3, l: "3" }, { v: 5, l: "5" }, { v: 10, l: "10" }]} onChange={setRollWin} /></Field>
                  </div>
                </div>
                <PropChart rows={filtered} statKey={statKey} stat={stat} line={line} rollingWindow={rollWin} onPick={(id) => setPicked((p) => (p === id ? null : id))} picked={picked} />
              </div>
              <div className="panel"><StatTiles rows={filtered} allRows={allRows} statKey={statKey} stat={stat} line={line} /></div>
              <div className="panel"><GameLogTable rows={filtered} columns={columns} setColumns={setColumns} statKey={statKey} line={line} available={log?.available} position={player.position} picked={picked} onPick={(id) => setPicked((p) => (p === id ? null : id))} important={important} /></div>
              <div className="panel"><MiniCharts rows={filtered} keys={miniKeys} setKeys={setMiniKeys} available={log?.available} position={player.position} onFocus={chooseStat} /></div>
              <div className="panel"><Splits playerId={pid} statKey={statKey} position={player.position} since={settings.since} /></div>
            </div>
            <div className="grid" style={{ gap: 14, alignContent: "start" }}>
              <div className="panel">
                <div className="panel-head"><h3>Books · {marketRow?.market_label ?? "no market"}</h3></div>
                {marketRow ? <BookLines row={marketRow} selected={lineSource} onSelect={(b: BookLine) => setLineSource(b.book)} /> : <div className="hint">No sportsbook has posted this stat for this game. The line above is yours to set.</div>}
                {marketRow && <div style={{ marginTop: 10 }}><LineHistory history={lines?.history ?? []} market={marketRow.market} /></div>}
              </div>
              <div className="panel">
                <div className="panel-head"><h3>Distribution · filtered games</h3></div>
                <Histogram rows={filtered} statKey={statKey} stat={stat} line={line} />
              </div>
              <div className="panel">
                <div className="panel-head"><h3>Splits · all loaded games</h3><span className="hint">since {settings.since}</span></div>
                <SplitsTable rows={applyFilters(allRows, filters, true)} statKey={statKey} stat={stat} line={line} position={player.position} />
              </div>
              <div className="panel">
                <div className="panel-head"><h3>Matchup · team tendencies</h3></div>
                <MatchupPanel team={player.team} opponent={lines?.game ? (lines.game.home_team === player.team ? lines.game.away_team : lines.game.home_team) : null} position={player.position} focus={settings.focus} />
              </div>
              <div className="panel">
                <div className="panel-head"><h3>Injuries</h3></div>
                <InjuryPanel playerId={pid} team={player.team} opponent={lines?.game ? (lines.game.home_team === player.team ? lines.game.away_team : lines.game.home_team) : null} />
              </div>
              <PredictionSlot playerId={pid} market={market} line={line} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PredictionSlot({ playerId, market, line }: { playerId: string; market: string | null; line: number | null }) {
  const { meta } = useMeta();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { if (meta) api.predictions(meta.season, meta.week).then((d) => setRows(d.props.filter((p) => p.player_id === playerId))).catch(() => setRows([])); }, [meta, playerId]);
  const mine = rows.filter((p) => !market || p.market === market);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Prediction</h3>{mine.length ? <span className="pill over">{mine.length} logged</span> : <span className="pill">nothing logged</span>}</div>
      {mine.length === 0 && <div className="hint">When the model logs a row to <code>data/derived/prop_predictions.parquet</code> for this player and market, it shows here next to the line. See the Predictions page for the schema.</div>}
      {mine.map((p) => (
        <div key={p.model_version + p.market} className="small" style={{ marginBottom: 6 }}>
          <span className="pill accent">{p.model_version}</span> {p.market}: pred <b className="num">{p.pred?.toFixed(1)}</b>
          {line !== null && p.pred !== null && <> · vs line <span className="num">{line}</span> <span className={`num ${p.pred - line > 0 ? "over" : "under"}`}>{(p.pred - line > 0 ? "+" : "") + (p.pred - line).toFixed(1)}</span></>}
          {p.p_over !== null && p.p_over !== undefined && <> · P(over {p.line ?? line}) <b className="num">{Math.round(p.p_over * 100)}%</b></>}
          {p.notes && <div className="faint tiny">{p.notes}</div>}
        </div>
      ))}
    </div>
  );
}

function QuickPicks() {
  const { meta } = useMeta();
  const nav = useNavigate();
  const [team, setTeam] = useState("");
  const [rows, setRows] = useState<{ player_id: string; name: string; position: string; games: number; ppr: number }[]>([]);
  useEffect(() => { if (team && meta) api.teamPlayers(team, meta.season - 1).then(setRows); else setRows([]); }, [team, meta]);
  if (!meta) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="controls">
        <Field label="Browse by team (last season)"><select className="input" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Choose…</option>{meta.teams.filter((t) => !["OAK", "SD", "STL", "LAR"].includes(t.team_abbr)).map((t) => <option key={t.team_abbr} value={t.team_abbr}>{t.team_name}</option>)}</select></Field>
      </div>
      {rows.length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {rows.slice(0, 24).map((r) => <button key={r.player_id} className="chip" onClick={() => nav(`/research?player=${r.player_id}`)}>{r.name} <span className="muted">{r.position}</span></button>)}
        </div>
      )}
    </div>
  );
}
