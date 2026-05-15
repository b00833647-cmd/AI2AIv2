from scripts.analysis.process_report.db import connect
from scripts.analysis.process_report.viz import ALL_FIGURES


def test_all_figures_render():
    con = connect()
    assert len(ALL_FIGURES) >= 12
    for name, fn in ALL_FIGURES:
        p = fn(con)
        assert p.exists() and p.stat().st_size > 800, name
