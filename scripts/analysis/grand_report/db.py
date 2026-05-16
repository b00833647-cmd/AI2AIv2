"""Self-contained snapshot access + the X1–X4 experiment framework.

Independent reimplementation (no imports from any other report package).
Reservation constants are verified against the scenario pack at call time.
Derived frames are parquet-cached for fast deterministic re-runs.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd

from .design import EXPERIMENTS, exp_of

SNAPSHOT = Path("data/ai2ai-human-pilot-2026-05-15.db")
CACHE = Path("docs/reports/cache-grand")

BUYER_ASPIRATION = 21_500
BUYER_CEILING = 23_500          # buyer reservation
SELLER_LISTING = 25_500
SELLER_FLOOR = 22_500           # seller reservation
MARKET_PRICE = 24_000
ZOPA_LOW, ZOPA_HIGH = SELLER_FLOOR, BUYER_CEILING
ZOPA_MID = (ZOPA_LOW + ZOPA_HIGH) / 2.0
ZOPA_WIDTH = ZOPA_HIGH - ZOPA_LOW

SURVEY_KEYS = ["satisfaction", "would_use_again", "agent_represented",
               "control", "emot_pleasant", "emot_anxious",
               "effort_invested", "engage_engaged", "outfair_share"]
SURVEY_LABEL = {
    "satisfaction": "Satisfaction", "would_use_again": "Would use again",
    "agent_represented": "Felt represented", "control": "Perceived control",
    "emot_pleasant": "Pleasant affect", "emot_anxious": "Anxious affect",
    "effort_invested": "Effort invested", "engage_engaged": "Engagement",
    "outfair_share": "Outcome fairness"}
_MODE = {"agent": "delegated", "human_buyer": "direct",
         "human_seller": "direct"}
_MODE2 = {"delegated": "AI-to-AI", "direct": "Human-to-AI"}


def connect(path: str | Path = SNAPSHOT) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def load(con, table, cols="*", where=""):
    return pd.read_sql_query(f"SELECT {cols} FROM [{table}] {where}", con)


def _cache(name: str, builder):
    CACHE.mkdir(parents=True, exist_ok=True)
    fp = CACHE / f"{name}.parquet"
    if fp.exists():
        try:
            return pd.read_parquet(fp)
        except Exception:
            pass
    df = builder()
    try:
        df.to_parquet(fp, index=False)
    except Exception:
        pass
    return df


def verify_reservations(con) -> dict:
    seen = {"ba": set(), "bc": set(), "sl": set(), "sf": set()}
    for (sp,) in con.execute("SELECT scenario_pack_json FROM sessions"):
        try:
            parts = json.loads(sp)["participants"]
        except Exception:
            continue
        for p in parts:
            b = p.get("brief", {})
            if b.get("maxBudget") is not None:
                seen["ba"].add(b.get("targetPrice"))
                seen["bc"].add(b.get("maxBudget"))
            if "minimumAcceptablePrice" in b:
                seen["sl"].add(b.get("listingPrice"))
                seen["sf"].add(b.get("minimumAcceptablePrice"))
    exp = {"ba": BUYER_ASPIRATION, "bc": BUYER_CEILING,
           "sl": SELLER_LISTING, "sf": SELLER_FLOOR}
    for k, e in exp.items():
        vals = {v for v in seen[k] if v is not None}
        if vals and vals != {e}:
            raise ValueError(f"reservation drift {k}: {vals} != {{{e}}}")
    return {"buyer_aspiration": BUYER_ASPIRATION,
            "buyer_ceiling": BUYER_CEILING,
            "seller_listing": SELLER_LISTING, "seller_floor": SELLER_FLOOR}


def _secs(a, b):
    try:
        da = datetime.fromisoformat(str(a).replace("Z", "+00:00"))
        db_ = datetime.fromisoformat(str(b).replace("Z", "+00:00"))
        return (db_ - da).total_seconds()
    except Exception:
        return None


def _price(j):
    try:
        v = json.loads(j or "{}").get("price")
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str) and v.strip():
            return float(v)
    except Exception:
        return None
    return None


def completers(con) -> pd.DataFrame:
    def _build():
        sp = load(con, "study_participants",
                  "id AS participant_id, session_id, role, experiment_mode, "
                  "consent, age, gender, experience, ai_familiarity, "
                  "attention_check_pass, excluded, test_data, os, browser, "
                  "device_type, timezone, language, viewport_w, viewport_h, "
                  "screen_w, screen_h, connection_type, referrer, "
                  "created_at, finished_at, completion_code, prolific_pid, "
                  "prolific_study_id",
                  "WHERE completion_code IS NOT NULL AND completion_code!=''")
        opp = load(con, "participant_responses",
                   "participant_id, value_text AS opponent",
                   "WHERE screen='engine' AND key='opponent_personality'")
        df = sp.merge(opp, on="participant_id", how="left")
        df["mode"] = df["experiment_mode"].map(_MODE)
        df["mode2"] = df["mode"].map(_MODE2)
        df["exp"] = [exp_of(m, r) for m, r in zip(df["mode"], df["role"])]
        df["exp_label"] = df["exp"].map(
            {k: v["label"] for k, v in EXPERIMENTS.items()})
        df["cell"] = df["mode2"] + " · " + df["role"]
        sess = load(con, "sessions",
                    "id AS session_id, outcome_type, outcome_terms_json, "
                    "outcome_summary, outcome_rationale, started_at, "
                    "ended_at, turns_consumed, tokens_total, "
                    "tokens_orchestrator, degraded, status, scenario_id")
        df = df.merge(sess, on="session_id", how="left")
        df["settlement_price"] = df["outcome_terms_json"].map(_price)
        df["agreed"] = (df["outcome_type"] == "agreed").astype(int)
        df["session_sec"] = [_secs(a, b) for a, b in
                             zip(df["started_at"], df["ended_at"])]
        df["study_sec"] = [_secs(a, b) for a, b in
                           zip(df["created_at"], df["finished_at"])]
        return df.reset_index(drop=True)

    return _cache("completers", _build)


def survey_wide(con) -> pd.DataFrame:
    def _build():
        base = completers(con)[["participant_id", "exp", "exp_label", "mode",
                                "mode2", "role", "opponent", "cell",
                                "outcome_type", "agreed",
                                "settlement_price"]]
        pr = load(con, "participant_responses",
                  "participant_id, key, value_int",
                  "WHERE screen='post_survey'")
        pr = pr[pr["key"].isin(SURVEY_KEYS)]
        wide = pr.pivot_table(index="participant_id", columns="key",
                              values="value_int",
                              aggfunc="first").reset_index()
        return base.merge(wide, on="participant_id", how="left")

    return _cache("survey_wide", _build)


def enrolled(con) -> pd.DataFrame:
    """All 59 enrolled (for flow/attrition/integrity groups)."""
    return load(con, "study_participants", "*")
