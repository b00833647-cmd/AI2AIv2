"""process_report clean-room condition reader — kept in lockstep with
the canonical core/conditions.py by the Task 6 parallel equivalence test.

This module is fully self-contained (no cross-package imports from the core
or human_pilot sub-packages) and must remain behavior-identical to the
canonical core implementation.

Contract (see spec 2026-05-15-clean-experimental-design-analysis-4a):
resolve_conditions(con) -> DataFrame, one row per completer
(completion_code present), columns:
  participant_id,
  condition_mode  in {delegated, direct},
  condition_role  in {buyer, seller},
  opponent_block  in {easygoing, moderate, tough},
  condition_source in {legacy, main},
  mode2 in {AI-to-AI, Human-to-AI}  (delegated->AI-to-AI, direct->Human-to-AI),
  main-only (NA for legacy): assignment_seed, assignment_block_index,
  replicate_id, manipulation_check_pass, excl_attention, excl_manipulation,
  excl_speeding, excl_comprehension, excl_noncompletion.

Legacy branch (condition_mode IS NULL) reproduces the historical derivation:
experiment_mode 'agent'->delegated, 'human_buyer'/'human_seller'->direct;
condition_role from `role`; opponent from
participant_responses(screen='engine', key='opponent_personality').
"""
from __future__ import annotations

import sqlite3

import pandas as pd

_LEGACY_MODE = {"agent": "delegated", "human_buyer": "direct", "human_seller": "direct"}
_MODE2 = {"delegated": "AI-to-AI", "direct": "Human-to-AI"}

_MAIN_ONLY = [
    "assignment_seed", "assignment_block_index", "replicate_id",
    "manipulation_check_pass", "excl_attention", "excl_manipulation",
    "excl_speeding", "excl_comprehension", "excl_noncompletion",
]


def _table_columns(con: sqlite3.Connection, table: str) -> set[str]:
    """Return the set of column names present in *table*."""
    return {r[1] for r in con.execute(f"PRAGMA table_info([{table}])").fetchall()}


def resolve_conditions(con: sqlite3.Connection) -> pd.DataFrame:
    # Build SELECT dynamically: columns that don't exist in the schema are
    # substituted with NULL so the same code handles both the legacy pilot DB
    # (no condition_* / assignment_* / excl_* columns) and the main-study DB.
    _new_cols = [
        "condition_mode", "condition_role", "opponent_block",
    ] + _MAIN_ONLY
    present = _table_columns(con, "study_participants")
    new_col_sql = ", ".join(
        col if col in present else f"NULL AS [{col}]" for col in _new_cols
    )
    sp = pd.read_sql_query(
        f"""SELECT id AS participant_id, role, experiment_mode, {new_col_sql}
             FROM study_participants
            WHERE completion_code IS NOT NULL AND completion_code != ''""",
        con,
    )
    opp = pd.read_sql_query(
        """SELECT participant_id, value_text AS legacy_opponent
             FROM participant_responses
            WHERE screen='engine' AND key='opponent_personality'""",
        con,
    )
    df = sp.merge(opp, on="participant_id", how="left")

    is_main = df["condition_mode"].notna()
    df["condition_source"] = is_main.map({True: "main", False: "legacy"})

    df["condition_mode"] = df["condition_mode"].where(
        is_main, df["experiment_mode"].map(_LEGACY_MODE))
    df["condition_role"] = df["condition_role"].where(is_main, df["role"])
    df["opponent_block"] = df["opponent_block"].where(is_main, df["legacy_opponent"])

    # legacy rows get pd.NA here; integer columns consequently surface as float/object — expected given the dual-branch schema (callers must not assume int dtype).
    for col in _MAIN_ONLY:
        df[col] = df[col].where(is_main, other=pd.NA)

    df["mode2"] = df["condition_mode"].map(_MODE2)

    cols = (["participant_id", "condition_mode", "condition_role",
             "opponent_block", "condition_source", "mode2"] + _MAIN_ONLY)
    return df[cols].reset_index(drop=True)
