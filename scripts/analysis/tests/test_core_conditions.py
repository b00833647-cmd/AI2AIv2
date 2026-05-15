import sqlite3
import pandas as pd
from scripts.analysis.core.conditions import resolve_conditions

LEGACY_DDL = """
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


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(LEGACY_DDL)
    return c


def test_legacy_branch_reproduces_mode_mapping():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L1','buyer','CC','agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L2','seller','CC','human_seller')")
    c.execute("INSERT INTO participant_responses VALUES "
              "('L1','engine','opponent_personality','tough')")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["L1","condition_mode"] == "delegated"
    assert df.loc["L1","condition_role"] == "buyer"
    assert df.loc["L1","opponent_block"] == "tough"
    assert df.loc["L1","mode2"] == "AI-to-AI"
    assert df.loc["L1","condition_source"] == "legacy"
    assert df.loc["L2","condition_mode"] == "direct"
    assert df.loc["L2","mode2"] == "Human-to-AI"
    assert pd.isna(df.loc["L1","assignment_seed"])
    assert pd.isna(df.loc["L1","excl_attention"])


def test_main_branch_reads_first_class_fields():
    c = _con()
    c.execute("INSERT INTO study_participants"
              "(id,role,completion_code,experiment_mode,condition_mode,"
              "condition_role,opponent_block,assignment_seed,"
              "assignment_block_index,replicate_id,manipulation_check_pass,"
              "excl_attention) VALUES "
              "('M1','buyer','CC','agent','direct','seller','easygoing',"
              "'S',3,3,1,0)")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["M1","condition_source"] == "main"
    assert df.loc["M1","condition_mode"] == "direct"
    assert df.loc["M1","condition_role"] == "seller"
    assert df.loc["M1","opponent_block"] == "easygoing"
    assert df.loc["M1","mode2"] == "Human-to-AI"
    assert df.loc["M1","assignment_seed"] == "S"
    assert int(df.loc["M1","assignment_block_index"]) == 3
    assert int(df.loc["M1","manipulation_check_pass"]) == 1
    assert int(df.loc["M1","excl_attention"]) == 0


def test_only_completers_returned():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('done','buyer','CC','agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('noncomp','buyer',NULL,'agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('empty','buyer','','agent')")
    df = resolve_conditions(c)
    assert set(df["participant_id"]) == {"done"}
