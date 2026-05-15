"""Analyzable-sample construction + the pre-registered exclusion policy +
the clean/dry-run guard for the confirmatory analysis (spec 4b).

Consumes the canonical 4a reader (scripts.analysis.core.conditions).
"""
from __future__ import annotations

import json
import sqlite3

import pandas as pd

from scripts.analysis.core.conditions import resolve_conditions

SURVEY_DVS = [
    "satisfaction", "would_use_again", "agent_represented", "control",
    "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
    "outfair_share",
]
_EXCL_COLS = ["excl_attention", "excl_manipulation", "excl_speeding",
              "excl_comprehension", "excl_noncompletion"]
_STRATA = [(m, r, o) for m in ("delegated", "direct")
           for r in ("buyer", "seller")
           for o in ("easygoing", "moderate", "tough")]


def _price(j):
    try:
        v = json.loads(j or "{}").get("price")
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            return float(v)
        return None
    except Exception:
        return None


def analyzable(con: sqlite3.Connection) -> tuple[pd.DataFrame, pd.DataFrame, bool]:
    """Return (frame, exclusions_audit, clean).

    frame: one row per ANALYZABLE completer — condition columns (4a) +
    the 9 survey DVs (wide) + outcome_type + final_price.
    exclusions_audit: DataFrame[reason, n].
    clean: True iff every row is condition_source=='main' AND all 12
    Mode x Role x opponent strata are present AND exclusion fields are
    non-null (i.e. real pre-registered main-study data).
    """
    cond = resolve_conditions(con)

    sp = pd.read_sql_query(
        "SELECT id AS participant_id, session_id FROM study_participants", con)
    sess = pd.read_sql_query(
        "SELECT id AS session_id, outcome_type, outcome_terms_json FROM sessions",
        con)
    surv = pd.read_sql_query(
        "SELECT participant_id, key, value_int FROM participant_responses "
        "WHERE screen='post_survey'", con)

    df = cond.merge(sp, on="participant_id", how="left") \
             .merge(sess, on="session_id", how="left")
    if not surv.empty:
        wide = (surv[surv["key"].isin(SURVEY_DVS)]
                .pivot_table(index="participant_id", columns="key",
                             values="value_int", aggfunc="first")
                .reset_index())
        df = df.merge(wide, on="participant_id", how="left")
    for dv in SURVEY_DVS:
        if dv not in df.columns:
            df[dv] = pd.NA
    df["final_price"] = df["outcome_terms_json"].map(_price)

    audit_rows = []
    keep = pd.Series(True, index=df.index)
    for col in _EXCL_COLS:
        if col not in df.columns:
            audit_rows.append({"reason": col, "n": None})  # screening not applied
            continue
        flagged = df[col].fillna(0).astype("float") == 1
        audit_rows.append({"reason": col, "n": int(flagged.sum())})
        keep &= ~flagged
    mc = (df["manipulation_check_pass"] if "manipulation_check_pass" in df
          else pd.Series(pd.NA, index=df.index))
    mc_fail = mc.fillna(1).astype("float") == 0
    audit_rows.append({"reason": "manipulation_check_fail", "n": int(mc_fail.sum())})
    keep &= ~mc_fail

    out = df[keep].reset_index(drop=True)
    audit = pd.DataFrame(audit_rows, columns=["reason", "n"])

    all_main = bool(len(out)) and (out["condition_source"] == "main").all()
    excl_present = all(out[c].notna().all() for c in _EXCL_COLS if c in out) \
        and ("manipulation_check_pass" in out
             and out["manipulation_check_pass"].notna().all())
    present = set(zip(out["condition_mode"], out["condition_role"], out["opponent_block"]))
    balanced = all(s in present for s in _STRATA)
    clean = bool(all_main and excl_present and balanced)

    keep_cols = (["participant_id", "condition_mode", "condition_role",
                  "opponent_block", "condition_source", "mode2",
                  "outcome_type", "final_price"] + SURVEY_DVS)
    return out[keep_cols], audit, clean
