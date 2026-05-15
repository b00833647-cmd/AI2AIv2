"""Canonical experimental-condition reader (NULL-means-legacy dual path).

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


def resolve_conditions(con: sqlite3.Connection) -> pd.DataFrame:
    sp = pd.read_sql_query(
        """SELECT id AS participant_id, role, experiment_mode,
                  condition_mode, condition_role, opponent_block,
                  assignment_seed, assignment_block_index, replicate_id,
                  manipulation_check_pass, excl_attention, excl_manipulation,
                  excl_speeding, excl_comprehension, excl_noncompletion
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
