"""Injury reports folded into a game's matchup: who is listed, and what that
does to the angles built as if everyone were playing.

The angle tables are computed from last season's usage and this week's
tendencies with no idea who is hurt. This layer runs after them, per side:

* every player on either roster carries his listing (``status``, ``injury``),
  so the tables can mark him;
* a player angle for someone who is Out or Doubtful is replaced by one that
  says so and what share of the ball that frees; one for a Questionable
  player, or one who sat out practice, keeps its lean but says so and drops
  a notch in strength;
* a team angle is added when the listing changes the picture the team
  tendencies paint: the starting quarterback out, the lead back out, a
  starting corner or safety out.

Statuses, from strongest: Out, Doubtful, Questionable, then practice-only
listings DNP and Limited. Full participation is a listing without a
concern and is left alone.
"""

from __future__ import annotations

#: Listings that mean "not playing" for the purposes of an angle.
OUT = ("Out", "Doubtful", "IR", "Injured Reserve")
#: Listings worth a caveat on an angle that still stands.
DOUBT = ("Questionable", "DNP")


def status_of(row: dict) -> str | None:
    """One word for a report row: the game designation if there is one,
    otherwise the practice participation, None when neither says anything."""
    s = row.get("report_status")
    if s and s != "Note":
        return s
    p = row.get("practice_status") or ""
    if p.startswith("Did Not"):
        return "DNP"
    if p.startswith("Limited"):
        return "Limited"
    return None


def listings(rows: list[dict]) -> dict[str, dict]:
    """gsis_id -> {status, injury} for every listed player on a team."""
    out: dict[str, dict] = {}
    for r in rows:
        st = status_of(r)
        pid = r.get("gsis_id")
        if not pid or not st:
            continue
        out[pid] = {"status": st, "injury": r.get("report_primary_injury") or r.get("practice_primary_injury") or None}
    return out


def _pct(v) -> str:
    return f"{round(float(v) * 100)}%" if v is not None else "–"


def _mark(players: list[dict], listed: dict[str, dict], name_key: str) -> None:
    for p in players:
        l = listed.get(p.get("player_id") or "")
        p["status"] = l["status"] if l else None
        p["injury"] = l["injury"] if l else None


def apply(side: dict, off_listed: dict[str, dict], def_listed: dict[str, dict]) -> None:
    """Annotate one side's personnel and rewrite its angles in place."""
    off = side.get("offense_personnel") or []
    deff = side.get("defense_personnel") or []
    _mark(off, off_listed, "player_display_name")
    _mark(deff, def_listed, "name")
    by_id = {p["player_id"]: p for p in off if p.get("player_id")}

    # --- player angles: replace, caveat, or leave -----------------------------
    kept: list[dict] = []
    absent: dict[str, dict] = {}
    for a in side.get("player_angles") or []:
        pid = a.get("player_id")
        l = off_listed.get(pid or "")
        if not l:
            kept.append(a)
            continue
        if l["status"] in OUT:
            absent[pid] = l
            continue
        if l["status"] in DOUBT:
            why = f"{l['status']}" + (f" ({l['injury']})" if l["injury"] else "")
            a = {**a, "tags": [*a.get("tags", []), "injury"], "strength": max(1, int(a.get("strength", 1)) - 1),
                 "detail": f"{a.get('detail', '')} Listed {why}; treat the angle as conditional on him playing.".strip()}
        kept.append(a)
    # A player Out with no angle of his own still matters if he is a key
    # player: his share of the ball goes somewhere.
    for pid, l in off_listed.items():
        if l["status"] in OUT and pid in by_id and pid not in absent:
            absent[pid] = l
    # A key player listed short of Out, with no angle of his own to caveat,
    # still deserves a line: a DNP on Wednesday is the first thing a bettor
    # wants to know about his props.
    caveated = {a.get("player_id") for a in kept if "injury" in a.get("tags", [])}
    for pid, l in off_listed.items():
        p = by_id.get(pid)
        if l["status"] in DOUBT and p and pid not in caveated and pid not in absent:
            why = l["status"] + (f", {l['injury']}" if l["injury"] else "")
            what = "sat out practice" if l["status"] == "DNP" else "is listed Questionable"
            kept.append({"title": f"{p.get('player_display_name', '?')} {what}", "lean": "neutral", "strength": 1,
                         "tags": ["injury", (p.get("position") or "player").lower()], "player_id": pid, "player": p.get("player_display_name"),
                         "position": p.get("position"), "offense": side.get("offense"), "defense": side.get("defense"),
                         "detail": f"{why}. Check the final designation before playing his props; a late scratch hands his volume to the next man up."})
    for pid, l in absent.items():
        p = by_id.get(pid)
        if not p:
            continue
        name, pos = p.get("player_display_name", "?"), p.get("position", "")
        why = l["status"] + (f", {l['injury']}" if l["injury"] else "")
        share = (f"{_pct(p.get('carry_share'))} of the carries" if pos == "RB"
                 else f"{_pct(p.get('target_share'))} of the targets" if pos in ("WR", "TE")
                 else "the passing game" if pos == "QB" else "his touches")
        kept.insert(0, {"title": f"{name} is {l['status']}", "lean": "under", "strength": 2, "tags": ["injury", pos.lower() or "player"],
                        "player_id": pid, "player": name, "position": pos, "offense": side.get("offense"), "defense": side.get("defense"),
                        "detail": f"{why}. Last season that was {share}; his props are off the board and that volume goes to whoever fills in."})
    side["player_angles"] = kept

    # --- team angles: the picture changes when a starter is missing ---------
    team: list[dict] = list(side.get("angles") or [])
    def first(pos: str, players: list[dict]) -> dict | None:
        cands = [p for p in players if p.get("position") == pos]
        cands.sort(key=lambda p: (p.get("depth_rank") or 99, -(p.get("touches_pg") or 0)))
        return cands[0] if cands else None
    qb = first("QB", off)
    if qb and qb.get("status") in OUT:
        team.insert(0, {"title": f"Backup quarterback: {qb['player_display_name']} is {qb['status']}", "lean": "under", "strength": 2,
                        "tags": ["injury", "qb"], "offense": side.get("offense"), "defense": side.get("defense"),
                        "detail": "Every passing tendency on this side was set with him under center. Expect a shorter, more conservative passing game and more runs; passing volume props lean under until the replacement shows otherwise."})
    rb = first("RB", off)
    if rb and rb.get("status") in OUT:
        others = [p for p in off if p.get("position") == "RB" and p is not rb and p.get("status") not in OUT]
        nxt = others[0]["player_display_name"] if others else "the committee"
        team.insert(0, {"title": f"Lead back out: {rb['player_display_name']} is {rb['status']}", "lean": "over", "strength": 2,
                        "tags": ["injury", "rb"], "offense": side.get("offense"), "defense": side.get("defense"),
                        "detail": f"His {_pct(rb.get('carry_share'))} of the carries has to go somewhere, most of it to {nxt}. The lead-back share below is last season's picture, not this week's."})
    starters_out = [p for p in deff if p.get("status") in OUT and (p.get("snap_pct") or 0) >= 0.6 and p.get("group") in ("CB", "S")]
    if starters_out:
        names = ", ".join(f"{p['name']} ({p['position']})" for p in starters_out[:3])
        team.insert(0, {"title": f"{side.get('defense')} secondary short a starter: {names}", "lean": "over", "strength": 2 if len(starters_out) > 1 else 1,
                        "tags": ["injury", "coverage"], "offense": side.get("offense"), "defense": side.get("defense"),
                        "detail": "The coverage rates and the who-covers table are built with him on the field. A replacement in the secondary is the softest matchup a passing game gets; receiving props lean over."})
    side["angles"] = team
