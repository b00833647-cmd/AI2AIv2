# scripts/analysis/human_pilot/linguistic.py
"""Deterministic lexicon/regex linguistic features for human negotiation
turns (Section 8D). No LLM — fully reproducible."""
from __future__ import annotations

import re

import pandas as pd

from scripts.analysis.human_pilot.data import _completer_ids  # type: ignore

_POLITE = re.compile(r"\b(please|thanks|thank you|appreciate|sorry|kindly)\b", re.I)
_HEDGE = re.compile(r"\b(maybe|perhaps|i think|i guess|kind of|sort of|possibly|might)\b", re.I)
_CONCESSION = re.compile(r"\b(meet (you )?in the middle|compromise|deal|i can do|i'?ll accept|fair|split the difference)\b", re.I)
_IMPERATIVE = re.compile(r"\b(i (want|need)|give me|you (must|should|have to))\b", re.I)


def features(text: str) -> dict:
    t = text or ""
    return {
        "char_len": len(t),
        "politeness": len(_POLITE.findall(t)),
        "hedges": len(_HEDGE.findall(t)),
        "questions": t.count("?"),
        "concession": len(_CONCESSION.findall(t)),
        "directness": len(_IMPERATIVE.findall(t)),
    }


def human_turn_features(con) -> pd.DataFrame:
    """One row per human-mode participant turn with linguistic features.

    In /bhx the human is the buyer; in /shx the human is the seller. We
    keep only the turn rows emitted by the human side.
    """
    ids = _completer_ids(con)
    qm = ",".join("?" * len(ids))
    rows = pd.read_sql_query(
        f"""SELECT sp.experiment_mode, sp.role, t.emitter_id, t.message
              FROM turns t
              JOIN study_participants sp ON sp.session_id = t.session_id
             WHERE sp.id IN ({qm})
               AND sp.experiment_mode IN ('human_buyer','human_seller')""",
        con, params=ids,
    )
    # The human's own turns: emitter_id == the participant's role.
    rows = rows[rows["emitter_id"] == rows["role"]].copy()
    feats = rows["message"].fillna("").map(features).apply(pd.Series)
    out = pd.concat([rows[["role"]].reset_index(drop=True),
                     feats.reset_index(drop=True)], axis=1)
    return out
