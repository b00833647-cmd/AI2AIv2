"""The canonical core reader and the process_report clean-room copy MUST
produce identical DataFrames on identical fixtures (lockstep guarantee).
Also pins non-null main-branch passthrough of _MAIN_ONLY columns
(folded in from the Task 4 code review)."""
import sqlite3
import pandas as pd
from scripts.analysis.core.conditions import resolve_conditions as core_resolve
from scripts.analysis.process_report.conditions import resolve_conditions as pr_resolve

DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
  experiment_mode TEXT, condition_mode TEXT, condition_role TEXT,
  opponent_block TEXT, assignment_seed TEXT, assignment_block_index INTEGER,
  replicate_id INTEGER, manipulation_check_pass INTEGER,
  excl_attention INTEGER, excl_manipulation INTEGER, excl_speeding INTEGER,
  excl_comprehension INTEGER, excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_text TEXT);
"""

ROWS = [
    ("L1","buyer","CC","agent",None,None,None,None,None,None,None,None,None,None,None,None),
    ("L2","seller","CC","human_seller",None,None,None,None,None,None,None,None,None,None,None,None),
    ("L3","buyer","CC","agent",None,None,None,None,None,None,None,None,None,None,None,None),
    ("M1","buyer","CC","agent","direct","seller","easygoing","S",2,2,1,0,0,1,0,0),
    ("X","buyer",None,"agent",None,None,None,None,None,None,None,None,None,None,None,None),
]


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    c.executemany("INSERT INTO study_participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ROWS)
    c.execute("INSERT INTO participant_responses VALUES ('L1','engine','opponent_personality','tough')")
    c.execute("INSERT INTO participant_responses VALUES ('L2','engine','opponent_personality','moderate')")
    return c


def test_core_and_process_report_readers_are_identical():
    a = core_resolve(_con()).sort_values("participant_id").reset_index(drop=True)
    b = pr_resolve(_con()).sort_values("participant_id").reset_index(drop=True)
    pd.testing.assert_frame_equal(a, b, check_dtype=False)
    assert list(a["participant_id"]) == ["L1", "L2", "L3", "M1"]  # 'X' (no code) excluded
    ai = a.set_index("participant_id")
    assert ai.loc["M1","condition_source"] == "main"
    assert ai.loc["L1","condition_source"] == "legacy"
    # non-null main-branch passthrough of _MAIN_ONLY (folded from Task 4 review).
    # M1 fixture tuple (DDL column order): assignment_seed='S',
    # assignment_block_index=2, replicate_id=2, manipulation_check_pass=1,
    # excl_attention=0, excl_manipulation=0, excl_speeding=1 — non-null values
    # must survive on the main branch.
    assert ai.loc["M1","assignment_seed"] == "S"
    assert int(ai.loc["M1","assignment_block_index"]) == 2
    assert int(ai.loc["M1","replicate_id"]) == 2
    assert int(ai.loc["M1","manipulation_check_pass"]) == 1
    assert int(ai.loc["M1","excl_speeding"]) == 1
    assert int(ai.loc["M1","excl_manipulation"]) == 0
    assert int(ai.loc["M1","excl_attention"]) == 0
    # legacy row main-only cols are NA in BOTH readers
    bi = b.set_index("participant_id")
    assert pd.isna(ai.loc["L1","assignment_seed"]) and pd.isna(bi.loc["L1","assignment_seed"])
    # L3 is a legacy row with no participant_responses entry — proves both readers
    # handle the legacy left-join miss → NaN opponent_block identically.
    assert pd.isna(ai.loc["L3","opponent_block"]) and pd.isna(bi.loc["L3","opponent_block"])
