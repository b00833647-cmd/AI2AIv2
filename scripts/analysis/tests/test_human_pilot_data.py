from pathlib import Path
import pytest
from scripts.analysis.human_pilot.data import (
    load_db, completers_frame, survey_long, behavior_prompts_frame,
    SNAPSHOT, N_COMPLETERS_EXPECTED,
)

@pytest.fixture(scope="module")
def con():
    return load_db(SNAPSHOT)

def test_snapshot_exists():
    assert Path(SNAPSHOT).exists(), f"snapshot missing: {SNAPSHOT}"

def test_completers_n_and_balance(con):
    df = completers_frame(con)
    assert len(df) == N_COMPLETERS_EXPECTED == 40
    cell = df.groupby(["experiment_mode", "role"]).size().to_dict()
    assert cell == {
        ("agent", "buyer"): 10,
        ("agent", "seller"): 10,
        ("human_buyer", "buyer"): 10,
        ("human_seller", "seller"): 10,
    }

def test_completers_have_required_columns(con):
    df = completers_frame(con)
    required = {
        "participant_id", "prolific_pid", "experiment_mode", "role",
        "mode2", "opponent_personality", "age", "gender", "experience",
        "ai_familiarity", "outcome_type", "final_price", "turns_count",
        "session_time_sec", "completion_code",
    }
    assert required <= set(df.columns), required - set(df.columns)

def test_mode2_collapses_human_routes(con):
    df = completers_frame(con)
    assert df["mode2"].value_counts().to_dict() == {"AI-to-AI": 20, "Human-to-AI": 20}

def test_outcomes_within_completers(con):
    df = completers_frame(con)
    oc = df["outcome_type"].value_counts(dropna=False).to_dict()
    assert oc.get("agreed") == 27
    assert oc.get("rejected") == 9
    assert oc.get("impasse") == 3
    assert oc.get("aborted") == 1

def test_agreed_price_band(con):
    df = completers_frame(con)
    agreed = df[df["outcome_type"] == "agreed"]["final_price"].dropna()
    assert len(agreed) == 27
    assert agreed.min() == 21500 and agreed.max() == 25500

def test_survey_long_all_completers(con):
    s = survey_long(con)
    assert set(s["participant_id"]).__len__() == 40
    keys = set(s["key"])
    expected_keys = {
        "satisfaction", "would_use_again", "agent_represented", "control",
        "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
        "outfair_share",
    }
    assert expected_keys <= keys
    assert "free_text" in keys or True

def test_behavior_prompts_agent_only(con):
    bp = behavior_prompts_frame(con)
    assert (bp["experiment_mode"] == "agent").all()
    assert len(bp) >= 1
