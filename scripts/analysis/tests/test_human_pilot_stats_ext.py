from scripts.analysis.human_pilot.stats_ext import (
    fisher_2x2, cliff_delta, bootstrap_ci, fdr_bh, mann_whitney,
)

def test_fisher_2x2_returns_or_and_p():
    out = fisher_2x2(success_a=8, n_a=10, success_b=3, n_b=10)
    assert "odds_ratio" in out and "p" in out
    assert out["p"] < 0.10
    assert out["n_a"] == 10 and out["n_b"] == 10

def test_fisher_2x2_no_difference():
    out = fisher_2x2(success_a=5, n_a=10, success_b=5, n_b=10)
    assert out["p"] == 1.0

def test_reexports_present():
    assert callable(cliff_delta) and callable(bootstrap_ci)
    assert callable(fdr_bh) and callable(mann_whitney)
