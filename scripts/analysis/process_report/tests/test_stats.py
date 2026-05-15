import numpy as np
import pandas as pd
from scipy import stats as sp

from scripts.analysis.process_report.stats import (
    scheirer_ray_hare, mann_whitney, kruskal_wallis, fisher_2x2, bootstrap_ci,
)


def test_srh_kw_equivalence():
    rng = np.random.default_rng(1)
    rows = []
    for a in ("lo", "hi"):
        for b in ("x", "y"):
            base = 0.0 if a == "lo" else 5.0
            for _ in range(10):
                rows.append({"dv": base + rng.normal(0, 1), "A": a, "B": b})
    df = pd.DataFrame(rows)
    r = scheirer_ray_hare(df, "dv", "A", "B")
    kw = sp.kruskal(*[g["dv"].values for _, g in df.groupby("A")])
    assert abs(r["A"]["H"] - kw.statistic) < 1e-9
    assert r["A"]["df"] == 1 and 0 <= r["A"]["eta2"] <= 1 and r["N"] == 40


def test_mw_matches_scipy():
    a = [1, 2, 3, 4, 5, 6]
    b = [4, 5, 6, 7, 8, 9]
    r = mann_whitney(a, b)
    u, p = sp.mannwhitneyu(a, b, alternative="two-sided")
    assert abs(r["U"] - float(u)) < 1e-9 and abs(r["p"] - float(p)) < 1e-9
    assert -1 <= r["cliffs_delta"] <= 1


def test_kw_matches_scipy():
    g = [[1, 2, 3], [4, 5, 6], [2, 2, 9]]
    r = kruskal_wallis(*g)
    k = sp.kruskal(*g)
    assert abs(r["H"] - float(k.statistic)) < 1e-9
    assert 0 <= r["eps2"] <= 1


def test_fisher_matches_scipy():
    r = fisher_2x2(7, 10, 3, 10)
    _, p = sp.fisher_exact([[7, 3], [3, 7]])
    assert abs(r["p"] - float(p)) < 1e-9 and r["rate_a"] == 0.7


def test_bootstrap_brackets():
    lo, hi = bootstrap_ci([7] * 20, [1] * 20, seed=42)
    assert lo > 0.9 and hi <= 1.0001
