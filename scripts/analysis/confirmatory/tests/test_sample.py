import sqlite3
import pandas as pd
from scripts.analysis.confirmatory.sample import analyzable

DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT, experiment_mode TEXT,
  session_id TEXT, condition_mode TEXT, condition_role TEXT, opponent_block TEXT,
  assignment_seed TEXT, assignment_block_index INTEGER, replicate_id INTEGER,
  manipulation_check_pass INTEGER, excl_attention INTEGER,
  excl_manipulation INTEGER, excl_speeding INTEGER, excl_comprehension INTEGER,
  excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_int INTEGER, value_text TEXT);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, outcome_type TEXT, outcome_terms_json TEXT);
"""


def _main_con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    c.execute("INSERT INTO study_participants VALUES "
              "('M1','buyer','CC','agent','s1','delegated','buyer','moderate',"
              "'S',0,0,1,0,0,0,0,0)")
    c.execute("INSERT INTO study_participants VALUES "
              "('M2','seller','CC','human_seller','s2','direct','seller','tough',"
              "'S',0,0,1,0,0,1,0,0)")
    c.execute("INSERT INTO sessions VALUES ('s1','agreed','{\"price\": 23000}')")
    c.execute("INSERT INTO sessions VALUES ('s2','rejected','{}')")
    for pid in ("M1", "M2"):
        c.execute("INSERT INTO participant_responses VALUES "
                  "(?, 'post_survey', 'satisfaction', 5, NULL)", (pid,))
    return c


def _legacy_con():
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE study_participants (
        id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
        experiment_mode TEXT, session_id TEXT);
      CREATE TABLE participant_responses (
        participant_id TEXT, screen TEXT, key TEXT, value_int INTEGER, value_text TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, outcome_type TEXT, outcome_terms_json TEXT);
    """)
    c.execute("INSERT INTO study_participants VALUES ('L1','buyer','CC','agent','s1')")
    c.execute("INSERT INTO sessions VALUES ('s1','agreed','{\"price\": 22000}')")
    c.execute("INSERT INTO participant_responses VALUES ('L1','engine','opponent_personality',NULL,'tough')")
    c.execute("INSERT INTO participant_responses VALUES ('L1','post_survey','satisfaction',6,NULL)")
    return c


def test_main_excludes_flagged_and_is_clean_when_balanced():
    df, audit, clean = analyzable(_main_con())
    assert set(df["participant_id"]) == {"M1"}
    assert audit.loc[audit["reason"] == "excl_speeding", "n"].iloc[0] == 1
    assert df.loc[df["participant_id"] == "M1", "satisfaction"].iloc[0] == 5
    assert df.loc[df["participant_id"] == "M1", "outcome_type"].iloc[0] == "agreed"
    assert df.loc[df["participant_id"] == "M1", "final_price"].iloc[0] == 23000
    assert clean in (True, False)


def test_legacy_is_not_clean_and_keeps_completers():
    df, audit, clean = analyzable(_legacy_con())
    assert clean is False
    assert set(df["participant_id"]) == {"L1"}
    assert df.loc[df["participant_id"] == "L1", "satisfaction"].iloc[0] == 6
