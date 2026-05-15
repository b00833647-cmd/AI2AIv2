"""SQLite snapshot -> tidy pandas frames, restricted to the 40 completers.

A "completer" is any study_participant whose completion_code is non-null
(per the design spec: 'completed' = received the final code). The 19
non-completers are never returned by any function here.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pandas as pd

SNAPSHOT = "data/ai2ai-human-pilot-2026-05-15.db"
N_COMPLETERS_EXPECTED = 40

_MODE2 = {
    "agent": "AI-to-AI",
    "human_buyer": "Human-to-AI",
    "human_seller": "Human-to-AI",
}

_V2_SURVEY_KEYS = [
    "satisfaction", "would_use_again", "agent_represented", "control",
    "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
    "outfair_share",
]


def load_db(path: str | Path = SNAPSHOT) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def _completer_ids(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT id FROM study_participants "
        "WHERE completion_code IS NOT NULL AND completion_code != ''"
    ).fetchall()
    return [r["id"] for r in rows]


def completers_frame(con: sqlite3.Connection) -> pd.DataFrame:
    """One row per completer: identity + condition + demographics + outcome."""
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    sp = pd.read_sql_query(
        f"SELECT * FROM study_participants WHERE id IN ({qmarks})", con, params=ids
    )
    sess = pd.read_sql_query("SELECT * FROM sessions", con)

    pers = pd.read_sql_query(
        f"""SELECT participant_id, value_text AS opponent_personality
              FROM participant_responses
             WHERE screen='engine' AND key='opponent_personality'
               AND participant_id IN ({qmarks})""",
        con, params=ids,
    )

    df = sp.merge(
        sess[["id", "outcome_type", "outcome_terms_json", "turns_consumed",
              "started_at", "ended_at", "tokens_total"]],
        left_on="session_id", right_on="id", how="left", suffixes=("", "_sess"),
    ).merge(pers, left_on="id", right_on="participant_id", how="left")

    df["participant_id"] = df["id"]
    df["mode2"] = df["experiment_mode"].map(_MODE2)

    def _price(j):
        try:
            v = json.loads(j or "{}").get("price")
            return float(v) if isinstance(v, (int, float)) else None
        except Exception:
            return None

    df["final_price"] = df["outcome_terms_json"].map(_price)
    df["turns_count"] = df["turns_consumed"]

    def _secs(row):
        s, e = row.get("started_at"), row.get("ended_at")
        if not s or not e:
            return None
        try:
            from datetime import datetime
            ds = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
            de = datetime.fromisoformat(str(e).replace("Z", "+00:00"))
            return (de - ds).total_seconds()
        except Exception:
            return None

    df["session_time_sec"] = df.apply(_secs, axis=1)
    return df.reset_index(drop=True)


def survey_long(con: sqlite3.Connection) -> pd.DataFrame:
    """Long-format post-survey for completers (one row per item answer)."""
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    s = pd.read_sql_query(
        f"""SELECT pr.participant_id, sp.experiment_mode, sp.role, pr.key,
                   pr.value_int, pr.value_text
              FROM participant_responses pr
              JOIN study_participants sp ON sp.id = pr.participant_id
             WHERE pr.screen='post_survey'
               AND pr.participant_id IN ({qmarks})""",
        con, params=ids,
    )
    s = s[~s["key"].str.startswith("_")].copy()
    s["mode2"] = s["experiment_mode"].map(_MODE2)
    return s.reset_index(drop=True)


def behavior_prompts_frame(con: sqlite3.Connection) -> pd.DataFrame:
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    bp = pd.read_sql_query(
        f"""SELECT bp.participant_id, sp.experiment_mode, sp.role,
                   bp.revision, bp.prompt_text, bp.submitted_at
              FROM behavior_prompts bp
              JOIN study_participants sp ON sp.id = bp.participant_id
             WHERE bp.participant_id IN ({qmarks})""",
        con, params=ids,
    )
    bp["prompt_len"] = bp["prompt_text"].fillna("").str.len()
    return bp.reset_index(drop=True)


def events_frame(con: sqlite3.Connection) -> pd.DataFrame:
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    return pd.read_sql_query(
        f"""SELECT participant_id, event_type, screen
              FROM participant_events
             WHERE participant_id IN ({qmarks})""",
        con, params=ids,
    )


V2_SURVEY_KEYS = _V2_SURVEY_KEYS
