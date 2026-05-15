"""Derived per-session / per-participant metric frames for all 4 pillars.

Standalone: only stdlib + pandas/numpy + the package's own db/extract.
No imports from scripts.analysis.human_pilot or scripts.analysis.core.
One tidy DataFrame per public function; deterministic.
"""
from __future__ import annotations

import json
from collections import Counter

import numpy as np
import pandas as pd

from . import db, extract

# --- Fixed reservation values (verified uniform across all 40 sessions) -----
# Re-asserted at call time via extract.extract_reservations (raises on drift).
BUYER_TARGET = 21500
BUYER_WALKAWAY = 23500
SELLER_TARGET = 25500
SELLER_FLOOR = 22500
ZOPA_LOW = SELLER_FLOOR        # 22500
ZOPA_HIGH = BUYER_WALKAWAY     # 23500
ZOPA_MID = (ZOPA_LOW + ZOPA_HIGH) / 2.0


def _base_cols(con) -> pd.DataFrame:
    """The 40 completers with cell labels — the canonical scoping frame."""
    c = db.completers(con)
    return c[["participant_id", "session_id", "role",
              "experiment_mode", "mode2", "cell"]].copy()


def _turns_by_session(con) -> dict:
    """session_id -> turns DataFrame ordered by turn_number (completers only)."""
    base = _base_cols(con)
    sids = set(base["session_id"])
    t = db.load(con, "turns",
                "session_id, turn_number, emitter, emitter_id, "
                "tool_calls_json, message, latency_ms, timestamp")
    t = t[t["session_id"].isin(sids)].copy()
    t["turn_number"] = pd.to_numeric(t["turn_number"], errors="coerce")
    out = {}
    for sid, g in t.groupby("session_id", sort=False):
        out[sid] = g.sort_values("turn_number").reset_index(drop=True)
    return out


def _proposal_stream(turns_df: pd.DataFrame) -> list:
    """Ordered list of priced proposals: dicts with turn_number, side,
    price, action, is_final. One entry per priced proposal in turn order."""
    stream = []
    for _, r in turns_df.iterrows():
        for p in extract.parse_proposals(r["tool_calls_json"]):
            if p["price"] is None:
                continue
            stream.append({
                "turn_number": int(r["turn_number"]),
                "side": r["emitter_id"],
                "price": float(p["price"]),
                "action": p["action"],
                "is_final": bool(p["is_final"]),
            })
    return stream


def _closing_accept_turn(turns_df: pd.DataFrame, outcome_type: str):
    """turn_number of the accept proposal that closed an agreed session."""
    if outcome_type != "agreed":
        return None
    for _, r in turns_df.iterrows():
        for p in extract.parse_proposals(r["tool_calls_json"]):
            if p["action"] == "accept":
                return int(r["turn_number"])
    return None


def _side_concessions(prices_in_order, side: str) -> dict:
    """Concession stats over one side's successive own proposal prices.

    Buyer concession = price moves UP (toward seller); seller concession =
    price moves DOWN (toward buyer). Returns count, total, mean of |Δ| of
    moves in the conceding direction.
    """
    deltas = []
    for prev, cur in zip(prices_in_order[:-1], prices_in_order[1:]):
        d = cur - prev
        if side == "buyer" and d > 0:
            deltas.append(abs(d))
        elif side == "seller" and d < 0:
            deltas.append(abs(d))
    if not deltas:
        return {"n": 0, "total": 0.0, "mean": np.nan}
    return {"n": len(deltas), "total": float(sum(deltas)),
            "mean": float(np.mean(deltas))}


def bargaining_frame(con) -> pd.DataFrame:
    """One row per completer session (40). Anchoring / concession / round /
    ultimatum metrics from the ordered proposal-message stream."""
    extract.extract_reservations(con)  # re-assert uniformity (raises on drift)
    base = _base_cols(con)
    tbs = _turns_by_session(con)

    sess = db.load(con, "sessions",
                   "id AS session_id, outcome_type, outcome_terms_json")
    sess = sess.set_index("session_id")

    rows = []
    for _, b in base.iterrows():
        sid = b["session_id"]
        tdf = tbs.get(sid)
        outcome_type = (sess.loc[sid, "outcome_type"]
                        if sid in sess.index else None)
        rec = {
            "participant_id": b["participant_id"], "session_id": sid,
            "cell": b["cell"], "mode2": b["mode2"], "role": b["role"],
            "outcome_type": outcome_type,
        }
        if tdf is None or tdf.empty:
            rows.append({**rec, "buyer_open": np.nan, "seller_open": np.nan,
                         "opening_spread": np.nan, "anchor_distance": np.nan,
                         "n_concessions": 0, "mean_concession": np.nan,
                         "concession_rate": np.nan,
                         "buyer_share_concession": np.nan,
                         "n_proposal_rounds": 0,
                         "dialogue_to_proposal_ratio": np.nan,
                         "turns_to_first_proposal": np.nan,
                         "turns_to_deal": np.nan, "n_final_offers": 0,
                         "first_final_turn": np.nan,
                         "held_after_final": None})
            continue

        stream = _proposal_stream(tdf)
        buyer_props = [s for s in stream if s["side"] == "buyer"]
        seller_props = [s for s in stream if s["side"] == "seller"]

        buyer_open = buyer_props[0]["price"] if buyer_props else np.nan
        seller_open = seller_props[0]["price"] if seller_props else np.nan
        opening_spread = (seller_open - buyer_open
                          if (buyer_props and seller_props) else np.nan)

        if b["role"] == "buyer":
            own_open, own_target = buyer_open, BUYER_TARGET
        else:
            own_open, own_target = seller_open, SELLER_TARGET
        anchor_distance = (abs(own_open - own_target)
                           if own_open == own_open else np.nan)

        b_con = _side_concessions([s["price"] for s in buyer_props], "buyer")
        s_con = _side_concessions([s["price"] for s in seller_props], "seller")

        if b["role"] == "buyer":
            own_con = b_con
        else:
            own_con = s_con
        n_concessions = own_con["n"]
        mean_concession = own_con["mean"]

        n_proposal_rounds = len(stream)
        concession_rate = (own_con["total"] / max(1, n_proposal_rounds)
                           if n_proposal_rounds else np.nan)

        denom = b_con["total"] + s_con["total"]
        buyer_share_concession = (b_con["total"] / denom
                                  if denom > 0 else np.nan)

        tc = Counter()
        for _, r in tdf.iterrows():
            for k, v in extract.count_tools(r["tool_calls_json"]).items():
                tc[k] += v
        n_send = tc["send_message"]
        n_submit = tc["submit_proposal"]
        dialogue_to_proposal_ratio = n_send / max(1, n_submit)

        turns_to_first_proposal = (stream[0]["turn_number"]
                                   if stream else np.nan)
        turns_to_deal = _closing_accept_turn(tdf, outcome_type)

        finals = [s for s in stream if s["is_final"]]
        n_final_offers = len(finals)
        first_final_turn = finals[0]["turn_number"] if finals else np.nan
        if finals:
            ff = finals[0]
            ff_side = ff["side"]
            held_after_final = not any(
                s["side"] == ff_side and s["turn_number"] > ff["turn_number"]
                and s["price"] != ff["price"] for s in stream)
        else:
            held_after_final = None

        rows.append({
            **rec, "buyer_open": buyer_open, "seller_open": seller_open,
            "opening_spread": opening_spread,
            "anchor_distance": anchor_distance,
            "n_concessions": n_concessions,
            "mean_concession": mean_concession,
            "concession_rate": concession_rate,
            "buyer_share_concession": buyer_share_concession,
            "n_proposal_rounds": n_proposal_rounds,
            "dialogue_to_proposal_ratio": dialogue_to_proposal_ratio,
            "turns_to_first_proposal": turns_to_first_proposal,
            "turns_to_deal": turns_to_deal,
            "n_final_offers": n_final_offers,
            "first_final_turn": first_final_turn,
            "held_after_final": held_after_final,
        })
    return pd.DataFrame(rows).reset_index(drop=True)


def surplus_frame(con) -> pd.DataFrame:
    """Agreed sessions only (~27). Settlement & surplus split vs ZOPA."""
    bf = bargaining_frame(con)
    tbs = _turns_by_session(con)
    sess = db.load(con, "sessions",
                   "id AS session_id, outcome_type, outcome_terms_json")
    sess = sess.set_index("session_id")

    agreed = bf[bf["outcome_type"] == "agreed"].copy()
    rows = []
    for _, b in agreed.iterrows():
        sid = b["session_id"]
        # settlement price: outcome_terms_json {"price":N}; fallback accept
        price = None
        otj = sess.loc[sid, "outcome_terms_json"] if sid in sess.index else None
        if otj:
            try:
                price = json.loads(otj).get("price")
            except Exception:
                price = None
        if price is None:
            tdf = tbs.get(sid)
            if tdf is not None:
                for _, r in tdf.iterrows():
                    for p in extract.parse_proposals(r["tool_calls_json"]):
                        if p["action"] == "accept" and p["price"] is not None:
                            price = p["price"]
        if price is None:
            continue
        price = float(price)

        buyer_surplus = BUYER_WALKAWAY - price
        seller_surplus = price - SELLER_FLOOR
        denom = buyer_surplus + seller_surplus
        # "Share of surplus" is only a meaningful proportion when both
        # parties realised non-negative surplus (settlement within ZOPA).
        # Out-of-ZOPA agreements give one party negative surplus, making
        # the share undefined -> NaN. pareto_efficient records which deals
        # those were, so no information is lost.
        if buyer_surplus < 0 or seller_surplus < 0 or denom <= 0:
            buyer_share = np.nan
        else:
            buyer_share = buyer_surplus / denom
        pareto = ZOPA_LOW <= price <= ZOPA_HIGH

        rec = b.to_dict()
        rec.update({
            "settlement_price": price,
            "zopa_low": float(ZOPA_LOW), "zopa_high": float(ZOPA_HIGH),
            "zopa_mid": float(ZOPA_MID),
            "settlement_vs_mid": price - ZOPA_MID,
            "buyer_surplus": float(buyer_surplus),
            "seller_surplus": float(seller_surplus),
            "buyer_share_of_surplus": buyer_share,
            "pareto_efficient": bool(pareto),
        })
        rows.append(rec)
    return pd.DataFrame(rows).reset_index(drop=True)


def tempo_frame(con) -> pd.DataFrame:
    """40 rows. Latency, duration, token economy per completer session."""
    base = _base_cols(con)
    tbs = _turns_by_session(con)
    sess = db.load(con, "sessions",
                   "id AS session_id, started_at, ended_at, tokens_total, "
                   "tokens_orchestrator, turns_consumed, outcome_type")
    sess = sess.set_index("session_id")

    rows = []
    for _, b in base.iterrows():
        sid = b["session_id"]
        tdf = tbs.get(sid)
        s = sess.loc[sid] if sid in sess.index else None
        rec = {"participant_id": b["participant_id"], "session_id": sid,
               "cell": b["cell"], "mode2": b["mode2"], "role": b["role"]}

        if tdf is not None and not tdf.empty:
            lat = pd.to_numeric(tdf["latency_ms"], errors="coerce").dropna()
            median_latency = float(lat.median()) if len(lat) else np.nan
            mean_latency = float(lat.mean()) if len(lat) else np.nan
        else:
            median_latency = mean_latency = np.nan

        started = extract.parse_ts(s["started_at"]) if s is not None else None
        ended = extract.parse_ts(s["ended_at"]) if s is not None else None
        dur = ((ended - started).total_seconds()
               if (started and ended) else np.nan)

        outcome_type = s["outcome_type"] if s is not None else None
        ttd_s = np.nan
        if tdf is not None and not tdf.empty:
            close_turn = _closing_accept_turn(tdf, outcome_type)
            if close_turn is not None:
                first_ts = extract.parse_ts(tdf.iloc[0]["timestamp"])
                m = tdf[tdf["turn_number"] == close_turn]
                close_ts = (extract.parse_ts(m.iloc[0]["timestamp"])
                            if len(m) else None)
                if first_ts and close_ts:
                    ttd_s = (close_ts - first_ts).total_seconds()

        tot = (float(s["tokens_total"])
               if s is not None and pd.notna(s["tokens_total"]) else np.nan)
        orch = (float(s["tokens_orchestrator"]) if s is not None
                and pd.notna(s["tokens_orchestrator"]) else np.nan)
        agent_tokens = (tot - orch
                        if (tot == tot and orch == orch) else np.nan)
        if tot == tot and tot > 0 and orch == orch:
            orch_share = min(max(orch / tot, 0.0), 1.0)
        else:
            orch_share = np.nan
        tconsumed = (s["turns_consumed"]
                     if s is not None and pd.notna(s["turns_consumed"]) else 0)
        tokens_per_turn = (tot / max(1, int(tconsumed))
                           if tot == tot else np.nan)

        rows.append({
            **rec, "median_latency_ms": median_latency,
            "mean_latency_ms": mean_latency,
            "negotiation_duration_s": dur, "time_to_deal_s": ttd_s,
            "tokens_total": tot, "tokens_orchestrator": orch,
            "agent_tokens": agent_tokens, "orch_token_share": orch_share,
            "tokens_per_turn": tokens_per_turn,
        })
    return pd.DataFrame(rows).reset_index(drop=True)


def orchestrator_frame(con) -> pd.DataFrame:
    """40 rows. Routing alternation, declaration, interventions, referee cost."""
    base = _base_cols(con)
    tbs = _turns_by_session(con)
    od = db.load(con, "orchestrator_decisions",
                 "session_id, decision_index, turn_number, tool_name, "
                 "tool_input_json, rationale, timestamp")
    sess = db.load(con, "sessions",
                   "id AS session_id, degraded, tokens_orchestrator, "
                   "turns_consumed")
    sess = sess.set_index("session_id")
    sids = set(base["session_id"])
    od = od[od["session_id"].isin(sids)].copy()
    od["decision_index"] = pd.to_numeric(od["decision_index"],
                                         errors="coerce")
    od_by = {sid: g.sort_values("decision_index").reset_index(drop=True)
             for sid, g in od.groupby("session_id", sort=False)}

    rows = []
    for _, b in base.iterrows():
        sid = b["session_id"]
        g = od_by.get(sid)
        tdf = tbs.get(sid)
        s = sess.loc[sid] if sid in sess.index else None
        rec = {"participant_id": b["participant_id"], "session_id": sid,
               "cell": b["cell"], "mode2": b["mode2"], "role": b["role"]}

        if g is None or g.empty:
            rows.append({**rec, "alternation_rate": np.nan,
                         "longest_same_streak": 0, "n_request_turn": 0,
                         "declare_turn": np.nan, "declare_latency_s": np.nan,
                         "rationale_len": 0, "n_broadcast": 0, "n_pause": 0,
                         "degraded": (int(s["degraded"]) if s is not None
                                      and pd.notna(s["degraded"]) else 0),
                         "orch_tokens_per_turn": np.nan})
            continue

        req = g[g["tool_name"] == "request_turn"]
        sides = []
        for _, r in req.iterrows():
            side = None
            try:
                side = (json.loads(r["tool_input_json"]) or {}).get(
                    "participant_id")
            except Exception:
                side = None
            sides.append(side)
        # fallback proxy: if sides unextractable, use turns.emitter_id order
        if all(x is None for x in sides) and tdf is not None:
            sides = list(tdf["emitter_id"])

        n_request_turn = len(req)
        if len(sides) >= 2:
            switches = sum(1 for x, y in zip(sides[:-1], sides[1:])
                           if x != y)
            alternation_rate = switches / (len(sides) - 1)
        else:
            alternation_rate = np.nan

        longest = 0
        cur = 0
        prev = object()
        for x in sides:
            if x == prev:
                cur += 1
            else:
                cur = 1
                prev = x
            longest = max(longest, cur)

        decl = g[g["tool_name"] == "declare_outcome"]
        if len(decl):
            d0 = decl.iloc[0]
            declare_turn = (float(d0["turn_number"])
                            if pd.notna(d0["turn_number"]) else np.nan)
            rationale_len = len(d0["rationale"] or "")
            declare_latency_s = np.nan
            d_ts = extract.parse_ts(d0["timestamp"])
            if d_ts is not None and tdf is not None and not tdf.empty:
                last_ts = extract.parse_ts(tdf.iloc[-1]["timestamp"])
                if last_ts is not None:
                    declare_latency_s = (d_ts - last_ts).total_seconds()
        else:
            declare_turn = np.nan
            rationale_len = 0
            declare_latency_s = np.nan

        n_broadcast = int((g["tool_name"] == "broadcast_to").sum())
        n_pause = int((g["tool_name"] == "pause").sum())
        degraded = (int(s["degraded"]) if s is not None
                    and pd.notna(s["degraded"]) else 0)
        orch_tok = (float(s["tokens_orchestrator"]) if s is not None
                    and pd.notna(s["tokens_orchestrator"]) else np.nan)
        tconsumed = (s["turns_consumed"] if s is not None
                     and pd.notna(s["turns_consumed"]) else 0)
        orch_tpt = (orch_tok / max(1, int(tconsumed))
                    if orch_tok == orch_tok else np.nan)

        rows.append({
            **rec, "alternation_rate": alternation_rate,
            "longest_same_streak": longest,
            "n_request_turn": n_request_turn,
            "declare_turn": declare_turn,
            "declare_latency_s": declare_latency_s,
            "rationale_len": rationale_len, "n_broadcast": n_broadcast,
            "n_pause": n_pause, "degraded": degraded,
            "orch_tokens_per_turn": orch_tpt,
        })
    return pd.DataFrame(rows).reset_index(drop=True)


# --- ENGINE_SCREEN: computed empirically at import (per spec) ---------------
def _compute_engine_screen() -> int:
    """Modal `screen` value among engine-event types across completers.

    Engine events: human_turn_submitted, human_turn_input_enabled,
    outcome_revealed. Not blind-hardcoded — derived from the snapshot.
    """
    con = db.connect()
    try:
        comp = list(db.completers(con)["participant_id"])
        if not comp:
            return 7
        qm = ",".join("?" * len(comp))
        rows = con.execute(
            f"""SELECT screen FROM participant_events
                 WHERE participant_id IN ({qm})
                   AND event_type IN ('human_turn_submitted',
                       'human_turn_input_enabled','outcome_revealed')""",
            comp).fetchall()
        screens = [r[0] for r in rows if r[0] is not None]
        if not screens:
            return 7
        return int(Counter(screens).most_common(1)[0][0])
    finally:
        con.close()


ENGINE_SCREEN = _compute_engine_screen()


def _events_by_participant(con) -> dict:
    """participant_id -> events DataFrame ordered by client_ts (completers).

    client_ts / server_ts are ISO-8601 Z strings; parse to tz-aware
    datetimes (`_ts`) so ordering and compose-time deltas are correct.
    """
    base = _base_cols(con)
    pids = set(base["participant_id"])
    ev = db.load(con, "participant_events",
                 "participant_id, client_ts, server_ts, screen, "
                 "event_type, payload_json")
    ev = ev[ev["participant_id"].isin(pids)].copy()
    ev["_ts"] = ev["client_ts"].map(extract.parse_ts)
    ev["_sts"] = ev["server_ts"].map(extract.parse_ts)
    # Fall back to server_ts where client_ts is missing/unparseable.
    ev["_ts"] = ev["_ts"].where(ev["_ts"].notna(), ev["_sts"])
    out = {}
    for pid, g in ev.groupby("participant_id", sort=False):
        out[pid] = (g.sort_values("_ts", kind="stable")
                    .reset_index(drop=True))
    return out


def _payload(s):
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def ux_frame(con) -> pd.DataFrame:
    """One row per completer participant (40). Dwell / attention / effort."""
    base = _base_cols(con)
    eb = _events_by_participant(con)

    rows = []
    for _, b in base.iterrows():
        pid = b["participant_id"]
        g = eb.get(pid)
        rec = {"participant_id": pid, "cell": b["cell"],
               "mode2": b["mode2"], "role": b["role"]}
        if g is None or g.empty:
            rows.append({**rec, "total_active_s": 0.0, "engine_dwell_s": 0.0,
                         "n_idle": 0, "total_idle_s": 0.0, "n_tab_away": 0,
                         "n_thumbnail_views": 0, "n_zoom_opens": 0,
                         "inspected_listing": False, "n_clicks": 0,
                         "mean_scroll_pct": 0.0})
            continue

        total_active_ms = 0.0
        engine_ms = 0.0
        n_idle = 0
        total_idle_ms = 0.0
        n_tab_away = 0
        n_thumb = 0
        n_zoom = 0
        n_clicks = 0
        scroll_maxpcts = []
        for _, r in g.iterrows():
            et = r["event_type"]
            pl = _payload(r["payload_json"])
            if et == "screen_exit":
                d = pl.get("dwellMs")
                if d is not None:
                    total_active_ms += float(d)
                    if r["screen"] == ENGINE_SCREEN:
                        engine_ms += float(d)
            elif et == "idle_start":
                n_idle += 1
            elif et == "idle_end":
                if pl.get("idleMs") is not None:
                    total_idle_ms += float(pl["idleMs"])
            elif et == "visibility_change":
                if pl.get("hidden") is True:
                    n_tab_away += 1
            elif et == "listing_thumbnail_view":
                n_thumb += 1
            elif et == "listing_zoom_open":
                n_zoom += 1
            elif et == "click":
                n_clicks += 1
            elif et == "scroll":
                if pl.get("maxPct") is not None:
                    scroll_maxpcts.append(float(pl["maxPct"]))

        rows.append({
            **rec,
            "total_active_s": total_active_ms / 1000.0,
            "engine_dwell_s": engine_ms / 1000.0,
            "n_idle": n_idle, "total_idle_s": total_idle_ms / 1000.0,
            "n_tab_away": n_tab_away,
            "n_thumbnail_views": n_thumb, "n_zoom_opens": n_zoom,
            "inspected_listing": (n_thumb + n_zoom) > 0,
            "n_clicks": n_clicks,
            "mean_scroll_pct": (float(np.mean(scroll_maxpcts))
                                if scroll_maxpcts else 0.0),
        })
    return pd.DataFrame(rows).reset_index(drop=True)


def human_cadence(con) -> pd.DataFrame:
    """Human-to-AI participants only (<=20). Composition cadence from
    human_turn_submitted events."""
    base = _base_cols(con)
    base = base[base["mode2"] == "Human-to-AI"].copy()
    eb = _events_by_participant(con)

    rows = []
    for _, b in base.iterrows():
        pid = b["participant_id"]
        g = eb.get(pid)
        rec = {"participant_id": pid, "role": b["role"]}
        if g is None or g.empty:
            rows.append({**rec, "n_human_turns": 0, "send_share": np.nan,
                         "proposal_share": np.nan, "mean_charcount": np.nan,
                         "priced_turn_rate": np.nan, "mean_compose_s": np.nan,
                         "n_quick_accept": 0, "n_quick_walk": 0})
            continue

        g = g.reset_index(drop=True)
        actions = []
        charcounts = []
        hadprices = []
        compose_s = []
        last_enabled_ts = None
        n_quick_accept = 0
        n_quick_walk = 0
        for _, r in g.iterrows():
            et = r["event_type"]
            pl = _payload(r["payload_json"])
            if et == "human_turn_input_enabled":
                last_enabled_ts = r["_ts"]
            elif et == "human_turn_submitted":
                act = pl.get("action")
                actions.append(act)
                if pl.get("charCount") is not None:
                    charcounts.append(float(pl["charCount"]))
                hadprices.append(bool(pl.get("hadPrice")))
                if (last_enabled_ts is not None
                        and r["_ts"] is not None):
                    dt = (r["_ts"] - last_enabled_ts).total_seconds()
                    if dt >= 0:
                        compose_s.append(dt)
            elif et == "quick_accept_clicked":
                n_quick_accept += 1
            elif et == "quick_walk_clicked":
                n_quick_walk += 1

        n = len(actions)
        if n:
            send_share = sum(1 for a in actions
                             if a == "send_message") / n
            proposal_share = sum(1 for a in actions
                                 if a != "send_message") / n
        else:
            send_share = proposal_share = np.nan

        rows.append({
            **rec, "n_human_turns": n,
            "send_share": send_share, "proposal_share": proposal_share,
            "mean_charcount": (float(np.mean(charcounts))
                               if charcounts else np.nan),
            "priced_turn_rate": (float(np.mean(hadprices))
                                 if hadprices else np.nan),
            "mean_compose_s": (float(np.mean(compose_s))
                               if compose_s else np.nan),
            "n_quick_accept": n_quick_accept,
            "n_quick_walk": n_quick_walk,
        })
    return pd.DataFrame(rows).reset_index(drop=True)
