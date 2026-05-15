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


def test_srh_factor_a_dominates():
    import pandas as pd
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    rows = []
    for a in ["lo", "hi"]:
        for b in ["x", "y"]:
            base = 1.0 if a == "lo" else 6.0
            for _ in range(10):
                rows.append({"dv": base, "A": a, "B": b})
    df = pd.DataFrame(rows)
    r = scheirer_ray_hare(df, "dv", "A", "B")
    assert r["N"] == 40
    assert r["A"]["df"] == 1 and r["B"]["df"] == 1 and r["AB"]["df"] == 1
    assert r["A"]["p"] < 0.01
    assert r["B"]["p"] > 0.2 and r["AB"]["p"] > 0.2
    assert 0.0 <= r["A"]["eta2"] <= 1.0


def test_srh_valid_ranges_on_noise():
    import numpy as np
    import pandas as pd
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    rng = np.random.default_rng(0)
    rows = [{"dv": float(rng.normal(3, 1)), "A": a, "B": b}
            for a in ["lo", "hi"] for b in ["x", "y"] for _ in range(10)]
    r = scheirer_ray_hare(pd.DataFrame(rows), "dv", "A", "B")
    for k in ("A", "B", "AB"):
        assert 0.0 <= r[k]["p"] <= 1.0
        assert 0.0 <= r[k]["eta2"] <= 1.0
