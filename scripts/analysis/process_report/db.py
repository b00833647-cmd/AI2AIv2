"""Standalone snapshot access for the process report. No project imports."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

SNAPSHOT = Path("data/ai2ai-human-pilot-2026-05-15.db")

MODE2 = {"agent": "AI-to-AI",
         "human_buyer": "Human-to-AI", "human_seller": "Human-to-AI"}
CELLS = ["AI-to-AI · buyer", "AI-to-AI · seller",
         "Human-to-AI · buyer", "Human-to-AI · seller"]


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def completers(con) -> pd.DataFrame:
    """The 40 finished participants, one row each, with cell labels."""
    df = pd.read_sql_query(
        """SELECT id AS participant_id, session_id, role, experiment_mode,
                  completion_code
             FROM study_participants
            WHERE completion_code IS NOT NULL""", con)
    df["mode2"] = df["experiment_mode"].map(MODE2)
    df["cell"] = df["mode2"] + " · " + df["role"]
    return df.reset_index(drop=True)


def load(con, table: str, cols: str = "*") -> pd.DataFrame:
    return pd.read_sql_query(f"SELECT {cols} FROM {table}", con)
