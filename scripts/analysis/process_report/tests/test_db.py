from scripts.analysis.process_report.db import (
    SNAPSHOT, connect, completers, MODE2, CELLS,
)


def test_snapshot_exists():
    assert SNAPSHOT.exists()


def test_completers_40_4cells():
    con = connect()
    c = completers(con)
    assert len(c) == 40
    assert set(c["cell"]) == set(CELLS)
    assert (c.groupby("cell").size() == 10).all()
    assert set(c["mode2"]) == {"AI-to-AI", "Human-to-AI"}
    assert set(c["role"]) == {"buyer", "seller"}
    r0 = c.iloc[0]
    assert r0["cell"] == f"{r0['mode2']} · {r0['role']}"
