import sqlite3
import pandas as pd
from scripts.analysis.process_report.conditions import resolve_conditions

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


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    return c


def test_legacy_and_main_branches():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L1','seller','CC','human_seller')")
    c.execute("INSERT INTO participant_responses VALUES "
              "('L1','engine','opponent_personality','moderate')")
    c.execute("INSERT INTO study_participants"
              "(id,role,completion_code,experiment_mode,condition_mode,"
              "condition_role,opponent_block) VALUES "
              "('M1','buyer','CC','agent','delegated','buyer','tough')")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["L1","condition_mode"] == "direct"
    assert df.loc["L1","mode2"] == "Human-to-AI"
    assert df.loc["L1","opponent_block"] == "moderate"
    assert df.loc["L1","condition_source"] == "legacy"
    assert df.loc["M1","condition_mode"] == "delegated"
    assert df.loc["M1","mode2"] == "AI-to-AI"
    assert df.loc["M1","condition_source"] == "main"


def test_legacy_schema_without_new_columns():
    # Frozen-pilot shape: study_participants lacks condition_/assignment_/excl_ cols
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE study_participants (
        id TEXT PRIMARY KEY, role TEXT, completion_code TEXT, experiment_mode TEXT);
      CREATE TABLE participant_responses (
        participant_id TEXT, screen TEXT, key TEXT, value_text TEXT);
    """)
    c.execute("INSERT INTO study_participants VALUES ('L1','buyer','CC','agent')")
    c.execute("INSERT INTO participant_responses VALUES ('L1','engine','opponent_personality','easygoing')")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["L1","condition_source"] == "legacy"
    assert df.loc["L1","condition_mode"] == "delegated"
    assert df.loc["L1","opponent_block"] == "easygoing"
    assert pd.isna(df.loc["L1","assignment_seed"])


def test_clean_room_no_project_imports():
    import scripts.analysis.process_report.conditions as m
    src = open(m.__file__).read()
    assert "scripts.analysis.core" not in src
    assert "scripts.analysis.human_pilot" not in src
