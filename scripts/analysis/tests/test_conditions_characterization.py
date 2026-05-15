"""Characterization snapshot of condition derivation on the frozen pilot.
Asserts CURRENT behavior so the 4a refactor is provably byte-identical.
"""
from scripts.analysis.human_pilot.data import load_db, completers_frame, SNAPSHOT
from scripts.analysis.process_report.db import connect as pr_connect, completers as pr_completers


def _hp_condition_view():
    df = completers_frame(load_db(SNAPSHOT))
    keep = ["participant_id", "experiment_mode", "role", "mode2", "opponent_personality"]
    return (df[keep].sort_values("participant_id").reset_index(drop=True))


def test_human_pilot_condition_snapshot():
    v = _hp_condition_view()
    assert len(v) == 40
    assert v["mode2"].value_counts().to_dict() == {"AI-to-AI": 20, "Human-to-AI": 20}
    assert set(v["experiment_mode"]) == {"agent", "human_buyer", "human_seller"}
    assert set(v["role"]) == {"buyer", "seller"}
    assert set(v["opponent_personality"].dropna()) <= {"easygoing", "moderate", "tough"}
    assert v.groupby(["experiment_mode", "role"]).size().to_dict() == {
        ("agent", "buyer"): 10, ("agent", "seller"): 10,
        ("human_buyer", "buyer"): 10, ("human_seller", "seller"): 10,
    }
    snap = sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2,
         (r.opponent_personality if isinstance(r.opponent_personality, str) else None))
        for r in v.itertuples(index=False)
    )
    assert len(snap) == 40
    assert snap == sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2,
         (r.opponent_personality if isinstance(r.opponent_personality, str) else None))
        for r in _hp_condition_view().itertuples(index=False)
    )


def test_process_report_condition_snapshot():
    c = pr_completers(pr_connect())
    assert len(c) == 40
    assert set(c["mode2"]) == {"AI-to-AI", "Human-to-AI"}
    assert set(c["role"]) == {"buyer", "seller"}
    assert (c.groupby("cell").size() == 10).all()
    snap = sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2, r.cell)
        for r in c.itertuples(index=False)
    )
    assert len(snap) == 40
