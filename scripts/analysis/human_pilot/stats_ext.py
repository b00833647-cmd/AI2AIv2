"""Fisher's exact for the agreement-rate 2x2, plus thin re-exports of the
core stats helpers so figure/table code imports from one place."""
from __future__ import annotations

from scipy import stats as _sc

from scripts.analysis.core.stats import (  # noqa: F401
    cliff_delta, bootstrap_ci, fdr_bh, mann_whitney, kruskal_wallis,
)


def fisher_2x2(success_a: int, n_a: int, success_b: int, n_b: int) -> dict:
    """Fisher's exact on a 2x2 [[succ_a, fail_a], [succ_b, fail_b]]."""
    table = [[success_a, n_a - success_a], [success_b, n_b - success_b]]
    odds, p = _sc.fisher_exact(table)
    return {
        "odds_ratio": float(odds),
        "p": float(p),
        "rate_a": success_a / n_a if n_a else float("nan"),
        "rate_b": success_b / n_b if n_b else float("nan"),
        "n_a": n_a, "n_b": n_b,
    }
