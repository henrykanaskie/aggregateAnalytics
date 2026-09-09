"""Cross-book comparison: consensus lines, per-book deviation, outliers, and
recent form against the consensus.

Works on the long-format snapshot rows from :mod:`store`. A "consensus" is the
median line across books (median rather than mean so a single wild book does
not drag the reference it is being judged against). A book is flagged when it
sits at least ``threshold`` away from that median, with thresholds per market
from :mod:`markets`. For yes/no markets the comparison is on no-vig implied
probability instead.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import mean, median

import polars as pl

from ..stats.gamelog import recent_longest, recent_values
from ..stats.players import player_index
from .common import implied_prob
from .markets import BOOKS, BY_KEY

PROB_THRESHOLD = 0.04


def _book_order(book: str) -> tuple[int, str]:
    keys = list(BOOKS)
    return (keys.index(book) if book in keys else len(keys), book)


def _novig(over: int | None, under: int | None) -> float | None:
    po, pu = implied_prob(over), implied_prob(under)
    if po is None or pu is None or po + pu == 0:
        return None
    return po / (po + pu)


def _positions() -> dict[str, str]:
    idx = player_index().select("player_id", "position", "headshot")
    return {r["player_id"]: (r["position"], r["headshot"]) for r in idx.to_dicts()}


def build_board(latest: pl.DataFrame, markets: list[str] | None = None, threshold_scale: float = 1.0) -> list[dict]:
    if latest.is_empty():
        return []
    if markets:
        latest = latest.filter(pl.col("market").is_in(markets))
    pos = _positions()
    groups: dict[tuple, dict[str, dict]] = defaultdict(dict)
    meta: dict[tuple, dict] = {}
    for r in latest.to_dicts():
        pkey = r["player_id"] or f"name:{r['player_name']}"
        key = (r["game_id"] or r["event_id"], r["market"], pkey)
        meta.setdefault(key, {
            "game_id": r["game_id"], "event_id": r["event_id"], "home_team": r["home_team"],
            "away_team": r["away_team"], "commence_time": r["commence_time"], "market": r["market"],
            "player_id": r["player_id"], "player_name": r["player_name"], "team": r["team"],
            "sources": set(),
        })
        meta[key]["sources"].add(r["source"])
        if r["team"] and not meta[key]["team"]:
            meta[key]["team"] = r["team"]
        b = groups[key].setdefault(r["book"], {"book": r["book"], "title": r["book_title"] or BOOKS.get(r["book"], r["book"]),
                                               "line": None, "over": None, "under": None, "open_line": None,
                                               "yes": None, "no": None, "source": r["source"], "last_update": r["last_update"]})
        side = r["side"]
        if side == "Over":
            b["line"], b["over"] = r["line"], r["price"]
            b["open_line"] = r["open_line"]
        elif side == "Under":
            b["under"] = r["price"]
            if b["line"] is None:
                b["line"] = r["line"]
        elif side == "Yes":
            b["yes"] = r["price"]
        elif side == "No":
            b["no"] = r["price"]

    out: list[dict] = []
    for key, books in groups.items():
        m = BY_KEY.get(key[1])
        if m is None:
            continue
        info = meta[key]
        blist = sorted(books.values(), key=lambda b: _book_order(b["book"]))
        row = {**info, "sources": sorted(info["sources"]), "market_label": m.label, "stat": m.stat,
               "kind": m.kind, "group": m.group, "threshold": m.threshold * threshold_scale}
        pinfo = pos.get(info["player_id"] or "", (None, None))
        row["position"], row["headshot"] = pinfo
        if m.kind == "ou":
            lines = [b["line"] for b in blist if b["line"] is not None]
            if not lines:
                continue
            cons = median(lines)
            thr = m.threshold * threshold_scale
            for b in blist:
                b["delta"] = None if b["line"] is None else round(b["line"] - cons, 2)
                b["flag"] = None
                if b["delta"] is not None and thr > 0 and abs(b["delta"]) >= thr:
                    b["flag"] = "low" if b["delta"] < 0 else "high"
                b["novig_over"] = _novig(b["over"], b["under"])
                b["moved"] = None if (b["open_line"] is None or b["line"] is None) else round(b["line"] - b["open_line"], 2)
            priced_over = [b for b in blist if b["over"] is not None and b["line"] is not None]
            priced_under = [b for b in blist if b["under"] is not None and b["line"] is not None]
            row.update({
                "consensus": cons, "mean_line": round(mean(lines), 2), "n_books": len(lines),
                "min_line": min(lines), "max_line": max(lines), "line_spread": round(max(lines) - min(lines), 2),
                "outliers": [b["book"] for b in blist if b["flag"]],
                # Best over: lowest line, then best price. Best under: highest line, then best price.
                "best_over": _pick(priced_over, lambda b: (b["line"], -b["over"]), "over"),
                "best_under": _pick(priced_under, lambda b: (-b["line"], -b["under"]), "under"),
                "books": blist,
            })
        else:
            probs = []
            for b in blist:
                b["implied"] = implied_prob(b["yes"])
                b["novig_yes"] = _novig(b["yes"], b["no"]) if b["no"] is not None else b["implied"]
                if b["implied"] is not None:
                    probs.append(b["implied"])
            if not probs:
                continue
            cons = median(probs)
            for b in blist:
                b["delta"] = None if b["implied"] is None else round(b["implied"] - cons, 3)
                b["flag"] = None
                if b["delta"] is not None and abs(b["delta"]) >= PROB_THRESHOLD * threshold_scale:
                    # Lower implied probability = longer odds = better price for a Yes bettor.
                    b["flag"] = "low" if b["delta"] < 0 else "high"
            priced = [b for b in blist if b["yes"] is not None]
            row.update({
                "consensus": round(cons, 3), "mean_line": round(mean(probs), 3), "n_books": len(probs),
                "min_line": round(min(probs), 3), "max_line": round(max(probs), 3),
                "line_spread": round(max(probs) - min(probs), 3),
                "outliers": [b["book"] for b in blist if b["flag"]],
                "best_over": _pick(priced, lambda b: -b["yes"], "yes"),
                "best_under": None, "books": blist,
            })
        out.append(row)
    out.sort(key=lambda r: (-(r["line_spread"] or 0), r["player_name"] or ""))
    return out


def _pick(cands: list[dict], keyfn, price_key: str) -> dict | None:
    if not cands:
        return None
    b = min(cands, key=keyfn)
    return {"book": b["book"], "title": b["title"], "line": b.get("line"), "price": b[price_key]}


def attach_form(rows: list[dict], seasons: list[int], windows: tuple[int, ...] = (5, 10)) -> None:
    """Mutates ``rows`` adding ``form``: hit rates of the player's recent games
    against the consensus line. Uses the batch reader so a 600-row board costs
    one scan."""
    by_player: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        if r["player_id"] and r["stat"]:
            by_player[r["player_id"]].add(r["stat"])
    if not by_player:
        return
    stats = sorted({s for ss in by_player.values() for s in ss})
    vals = recent_values(list(by_player), stats, seasons)
    # Longest-play markets live in play-by-play rather than the box score.
    long_players = [p for p, ss in by_player.items() if any(s.startswith("long_") for s in ss)]
    for pid, d in recent_longest(long_players, seasons).items():
        vals.setdefault(pid, {}).update(d)
    for r in rows:
        r["form"] = None
        pv = vals.get(r["player_id"] or "")
        if not pv or r["stat"] not in pv:
            continue
        series = [v for v in pv[r["stat"]] if v is not None]
        if not series:
            continue
        line = r["consensus"]
        form: dict = {"n": len(series), "avg": round(mean(series), 2), "last": series[-1]}
        if r["kind"] == "ou":
            for w in windows:
                recent = series[-w:]
                over = sum(1 for v in recent if v > line)
                push = sum(1 for v in recent if v == line)
                form[f"l{w}"] = {"n": len(recent), "over": over, "push": push,
                                 "rate": round(over / len(recent), 3) if recent else None,
                                 "avg": round(mean(recent), 2) if recent else None}
            form["season"] = {"n": len(series), "over": sum(1 for v in series if v > line),
                              "rate": round(sum(1 for v in series if v > line) / len(series), 3)}
        else:
            for w in windows:
                recent = series[-w:]
                hits = sum(1 for v in recent if v >= 1)
                form[f"l{w}"] = {"n": len(recent), "over": hits, "push": 0,
                                 "rate": round(hits / len(recent), 3) if recent else None,
                                 "avg": round(mean(recent), 2) if recent else None}
            form["season"] = {"n": len(series), "over": sum(1 for v in series if v >= 1),
                              "rate": round(sum(1 for v in series if v >= 1) / len(series), 3)}
        r["form"] = form


def player_lines(latest: pl.DataFrame, player_id: str) -> list[dict]:
    """Board rows for one player only."""
    sub = latest.filter(pl.col("player_id") == player_id)
    return build_board(sub)
