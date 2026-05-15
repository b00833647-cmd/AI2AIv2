"""Unit + parity tests: canonical core SRH/Fisher must match the vetted
process_report clean-room copy on a shared fixture."""
import numpy as np
import pandas as pd
from scripts.analysis.core.stats import scheirer_ray_hare, fisher_2x2
from scripts.analysis.process_report.stats import (
    scheirer_ray_hare as pr_srh, fisher_2x2 as pr_fisher,
)


def _fixture():
    rng = np.random.default_rng(7)
    rows = []
    for a in ("delegated", "direct"):
        for b in ("buyer", "seller"):
            for _ in range(12):
                base = 4.0 + (0.8 if a == "delegated" else 0.0)
                rows.append({"dv": float(rng.normal(base, 1.0)),
                             "A": a, "B": b})
    return pd.DataFrame(rows)


def test_srh_shape_and_ranges():
    r = scheirer_ray_hare(_fixture(), "dv", "A", "B")
    for term in ("A", "B", "AB"):
        assert set(r[term]) == {"H", "p", "eta2", "df"}
        assert r[term]["df"] == 1
        assert 0.0 <= r[term]["p"] <= 1.0
        assert 0.0 <= r[term]["eta2"] <= 1.0
    assert r["N"] == 48


def test_srh_parity_with_process_report():
    df = _fixture()
    a = scheirer_ray_hare(df, "dv", "A", "B")
    b = pr_srh(df, "dv", "A", "B")
    assert a == b


def test_fisher_parity_and_values():
    a = fisher_2x2(8, 10, 3, 10)
    b = pr_fisher(8, 10, 3, 10)
    assert a == b
    assert set(a) == {"odds_ratio", "p", "rate_a", "rate_b", "n_a", "n_b"}
    assert a["rate_a"] == 0.8 and a["rate_b"] == 0.3
