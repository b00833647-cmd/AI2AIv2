# scripts/analysis/tests/test_human_pilot_linguistic.py
from scripts.analysis.human_pilot.linguistic import features, human_turn_features
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT

def test_features_counts():
    f = features("Please, I think maybe we could meet in the middle? Thanks!")
    assert f["politeness"] >= 2          # please, thanks
    assert f["hedges"] >= 2              # I think, maybe
    assert f["questions"] == 1
    assert f["concession"] >= 1          # meet in the middle
    assert f["char_len"] > 0

def test_features_empty():
    f = features("")
    assert f["char_len"] == 0 and f["politeness"] == 0

def test_human_turn_features_role_split():
    con = load_db(SNAPSHOT)
    df = human_turn_features(con)
    # Only human-mode participant turns; both roles present
    assert set(df["role"]) <= {"buyer", "seller"}
    assert len(df) > 50
    assert {"politeness", "hedges", "questions", "concession", "char_len"} <= set(df.columns)
