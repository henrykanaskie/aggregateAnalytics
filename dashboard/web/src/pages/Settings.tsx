import { useState } from "react";
import { api, OddsStatus, PullResult, signOut } from "../api";
import { Field, Seg, Spinner } from "../components/common";
import { useSticky } from "../lib/sticky";
import { useQuery } from "../lib/useQuery";
import { useMeta } from "../state";

export default function Settings() {
  const { meta, settings, setSettings, reloadMeta, admin, adminNote } = useMeta();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<PullResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useSticky<number | "">("settings.week", "");
  const [markets, setMarkets] = useSticky<string[]>("settings.markets", ["player_pass_yds", "player_pass_tds", "player_rush_yds", "player_rush_attempts", "player_reception_yds", "player_receptions", "player_anytime_td"]);
  const [maxCredits, setMaxCredits] = useSticky("settings.maxCredits", 250);
  const { data: status, reload: refresh } = useQuery<OddsStatus>(api.status.url());
  const pull = async (source: string, extra: Record<string, any> = {}) => {
    setBusy(source); setErr(null); setResult(null);
    // api.pull drops every cached view built on the snapshot store, so the
    // refresh below and the next visit to any lines page read the new pull.
    try { setResult(await api.pull({ source, week: week === "" ? null : week, ...extra })); refresh(); reloadMeta(); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  };
  const nGames = 16;
  const est = nGames * markets.length + 3;
  const s = status?.status ?? {};
  return (
    <div>
      <div className="page-head"><div><h1>Settings & data</h1></div><button className="btn" onClick={() => signOut()} title="Forget the site password on this browser">Sign out</button></div>
      <div className="grid grid-2">
        {!admin ? (
        <div className="panel" data-tour="settings-pull">
          <div className="panel-head"><h3>Pull lines</h3></div>
          {/* Pulling spends Odds API credits, so it needs the admin password
              rather than the one that opens the site. The buttons are absent
              instead of disabled: every one of them would answer 403. */}
          <div className="small muted">Pulling lines spends real credits, so it needs the admin password. Sign out and sign in with it to get these controls back.{adminNote ? <> <b>Not configured yet:</b> {adminNote}</> : null}</div>
          <div className="hint" style={{ marginTop: 10 }}>The snapshot store on the right is read-only and always visible.</div>
        </div>
        ) : (
        <div className="panel" data-tour="settings-pull">
          <div className="panel-head"><h3>Pull lines</h3><span className="hint">every pull is appended; nothing is overwritten</span></div>
          <div className="controls" style={{ marginBottom: 12 }}>
            <Field label="Week (blank = current)"><input className="input num" type="number" min={1} max={22} value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} /></Field>
          </div>
          <div className="panel" style={{ background: "var(--bg-2)", marginBottom: 10 }}>
            <div className="panel-head"><b>ESPN · DraftKings lines</b><span className="pill over">free</span></div>
            <div className="small muted">Player prop lines (no prices) with opening numbers, plus the DraftKings spread, total and moneyline. One book, exact player ids. Takes about 10 seconds.</div>
            <button className="btn primary" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => pull("espn")}>{busy === "espn" ? <Spinner /> : "Pull from ESPN"}</button>
          </div>
          <div className="panel" style={{ background: "var(--bg-2)", marginBottom: 10 }}>
            <div className="panel-head"><b>The Odds API · multi-book props</b>{status?.has_odds_api_key ? <span className="pill over">key found</span> : <span className="pill warn">no key</span>}</div>
            <div className="small muted">DraftKings, FanDuel, BetMGM, Caesars, BetRivers and more, with prices. Costs credits: one per market per game. Put <code>ODDS_API_KEY=…</code> in the repo's <code>.env</code> and restart the API.</div>
            <div className="chips" style={{ margin: "8px 0" }}>
              {(meta?.markets ?? []).filter((m) => m.kind === "ou" || m.key === "player_anytime_td").map((m) => <button key={m.key} className={`chip ${markets.includes(m.key) ? "on" : ""}`} onClick={() => setMarkets(markets.includes(m.key) ? markets.filter((x) => x !== m.key) : [...markets, m.key])}>{m.label}</button>)}
            </div>
            <div className="controls">
              <Field label="Max credits"><input className="input num" type="number" value={maxCredits} onChange={(e) => setMaxCredits(Number(e.target.value))} /></Field>
              <div className="small muted">≈ <b className="num">{est}</b> credits for a {nGames}-game week{status?.oddsapi_usage?.remaining !== null && status?.oddsapi_usage ? <> · <b className="num">{status.oddsapi_usage.remaining}</b> remaining as of last call</> : null}</div>
            </div>
            <button className="btn primary" style={{ marginTop: 8 }} disabled={!!busy || !status?.has_odds_api_key} onClick={() => pull("oddsapi", { markets, max_credits: maxCredits })}>{busy === "oddsapi" ? <Spinner /> : "Pull from The Odds API"}</button>
          </div>
          <div className="panel" style={{ background: "var(--bg-2)" }}>
            <div className="panel-head"><b>Sample lines</b><span className="pill warn">generated</span></div>
            <div className="small muted">Fake multi-book lines from last season's averages, for exploring the UI. Hidden automatically once real lines exist for the week.</div>
            <button className="btn" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => pull("sample")}>{busy === "sample" ? <Spinner /> : "Generate sample"}</button>
          </div>
          {err && <div className="banner err" style={{ marginTop: 10 }}>{err}</div>}
          {result && <pre style={{ marginTop: 10 }}>{[`${result.source}: ${result.props} prop rows (${result.matched} with player ids), ${result.games} game-line rows`, ...result.log].join("\n")}</pre>}
          <div className="panel" style={{ background: "var(--bg-2)", marginTop: 10 }}>
            <div className="panel-head"><b>Automation</b></div>
            <div className="small muted"><code>dashboard/scripts/daily.sh</code> pulls lines, logs the baseline projection, grades last week, and on Tuesdays refreshes nflverse data and rebuilds the team table. Install it to run at 08:00 and 20:00 with <code>dashboard/scripts/install_launchd.sh</code> (macOS) or <code>install_cron.sh</code>. Output goes to <code>data/odds/automation.log</code>.</div>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>From a terminal or cron: <code>python -m dashboard.odds.pull --source espn</code> (add <code>--source oddsapi --markets …</code> for the multi-book feed).</div>
        </div>
        )}
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <div className="panel-head"><h3>Snapshot store · data/odds/</h3><button className="btn sm" onClick={refresh}>refresh</button></div>
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th className="left">Source</th><th className="left">Kind</th><th>Pulls</th><th>Rows</th><th>Books</th><th className="left">Last pull</th></tr></thead>
              <tbody>{Object.entries(s).flatMap(([src, kinds]) => Object.entries(kinds).map(([kind, v]) => v && <tr key={src + kind}><td className="left">{src}</td><td className="left">{kind}</td><td className="num">{v.pulls}</td><td className="num">{v.rows}</td><td className="num">{v.books}</td><td className="left small">{v.last_pull ? new Date(v.last_pull).toLocaleString() : "–"}</td></tr>))}</tbody>
            </table></div>
            {Object.keys(s).length === 0 && <div className="empty">No snapshots yet.</div>}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Defaults</h3></div>
            <div className="controls">
              <Field label="Load seasons since"><input className="input num" type="number" min={1999} max={meta?.season ?? 2026} value={settings.since} onChange={(e) => setSettings({ since: Number(e.target.value) })} /></Field>
              <Field label="Default last N"><input className="input num" type="number" min={1} value={settings.nGames} onChange={(e) => setSettings({ nGames: Number(e.target.value) })} /></Field>
              <Field label="Preferred book"><select className="input" value={settings.preferredBook} onChange={(e) => setSettings({ preferredBook: e.target.value })}><option value="">Consensus</option>{Object.entries(meta?.books ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Outlier sensitivity"><Seg value={settings.thresholdScale} options={[{ v: 0.5, l: "High" }, { v: 1, l: "Normal" }, { v: 2, l: "Low" }]} onChange={(v) => setSettings({ thresholdScale: v })} /></Field>
              <Field label="Sample lines"><Seg value={settings.includeSample ? 1 : 0} options={[{ v: 1, l: "Show when no real feed" }, { v: 0, l: "Never" }]} onChange={(v) => setSettings({ includeSample: v === 1 })} /></Field>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Cached datasets</h3></div>
            <div className="chips">{(meta?.datasets ?? []).map((d) => <span key={d} className="chip">{d}</span>)}</div>
            <div className="hint" style={{ marginTop: 8 }}>Refresh with <code>python data_handling/ingest.py --only player_stats_week snap_counts --refresh</code> after each week's games.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
