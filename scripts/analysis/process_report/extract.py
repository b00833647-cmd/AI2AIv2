"""Pure parsers for the process report. No project imports."""
from __future__ import annotations

import json
from datetime import datetime


def parse_proposals(tool_calls_json) -> list:
    out = []
    try:
        tcs = json.loads(tool_calls_json) if tool_calls_json else []
    except Exception:
        return out
    for tc in tcs:
        if tc.get("name") != "submit_proposal":
            continue
        i = tc.get("input", {}) or {}
        price = None
        for iss in (i.get("issues") or []):
            if iss.get("name") == "price" and iss.get("value") is not None:
                price = float(iss["value"])
        out.append({"action": i.get("action"), "price": price,
                    "is_final": bool(i.get("is_final")),
                    "message": i.get("message")})
    return out


def count_tools(tool_calls_json) -> dict:
    c = {"send_message": 0, "submit_proposal": 0}
    try:
        for tc in (json.loads(tool_calls_json) if tool_calls_json else []):
            n = tc.get("name")
            if n in c:
                c[n] += 1
    except Exception:
        pass
    return c


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _packs_for_completers(con):
    cur = con.execute(
        """SELECT s.id, s.scenario_pack_json
             FROM sessions s
             JOIN study_participants sp ON sp.session_id = s.id
            WHERE sp.completion_code IS NOT NULL
              AND s.scenario_pack_json IS NOT NULL""")
    return [(r[0], r[1]) for r in cur.fetchall()]


def _briefs(pack_json: str) -> dict:
    """role -> structured brief dict from the scenario pack participants."""
    d = json.loads(pack_json)
    by = {}
    for p in d.get("participants", []):
        role = (p.get("role") or p.get("id") or "").lower()
        br = p.get("brief")
        if isinstance(br, dict):
            by[role] = br
    return by


def extract_reservations(con) -> dict:
    res = {}
    for sid, pj in _packs_for_completers(con):
        b = _briefs(pj)
        buyer = b.get("buyer", {})
        seller = b.get("seller", {})
        rec = {
            "buyer_target": buyer.get("targetPrice"),
            "buyer_walkaway": buyer.get("maxBudget"),
            "seller_target": seller.get("listingPrice"),
            "seller_floor": seller.get("minimumAcceptablePrice"),
        }
        rec = {k: (int(v) if v is not None else None)
               for k, v in rec.items()}
        res[sid] = rec
    sigs = {tuple(sorted(v.items())) for v in res.values()}
    if len(sigs) != 1:
        raise ValueError(
            f"Non-uniform reservation values across sessions: {sigs}")
    if any(v is None for v in next(iter(res.values())).values()):
        raise ValueError(
            f"Reservation parse incomplete: {next(iter(res.values()))}")
    return res
