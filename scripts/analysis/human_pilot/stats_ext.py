"""Fisher's exact for the agreement-rate 2x2, plus thin re-exports of the
core stats helpers so figure/table code imports from one place."""
from __future__ import annotations

from scipy import stats as _sc
import numpy as _np
import pandas as _pd  # noqa: F401

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


def scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict:
    """Scheirer–Ray–Hare: rank-based nonparametric two-way (A, B, A×B).

    Balanced or unbalanced 2-level factors. Returns per-term H (= SS/MS_total),
    chi-square p (df=1 for 2-level factors), and eta2 (= SS/SS_total).
    Deterministic; scipy/numpy only.
    """
    d = df[[dv, a, b]].dropna().copy()
    R = _sc.rankdata(d[dv].to_numpy(dtype=float))
    N = int(R.size)
    d["_R"] = R
    grand = float(R.mean())
    SS_total = float(((R - grand) ** 2).sum())

    def _ss_main(col: str) -> float:
        s = 0.0
        for _, g in d.groupby(col, observed=True):
            s += len(g) * (float(g["_R"].mean()) - grand) ** 2
        return float(s)

    SS_A = _ss_main(a)
    SS_B = _ss_main(b)
    mean_a = d.groupby(a, observed=True)["_R"].mean()
    mean_b = d.groupby(b, observed=True)["_R"].mean()
    SS_AB = 0.0
    for (la, lb), g in d.groupby([a, b], observed=True):
        eff = float(g["_R"].mean()) - float(mean_a[la]) - float(mean_b[lb]) + grand
        SS_AB += len(g) * eff ** 2
    SS_AB = float(SS_AB)

    MS_total = SS_total / (N - 1) if N > 1 else float("nan")

    def _term(ss: float, dfree: int) -> dict:
        H = ss / MS_total if MS_total and MS_total == MS_total else float("nan")
        ok = H == H and _np.isfinite(H)
        p = float(_sc.chi2.sf(H, dfree)) if ok else float("nan")
        eta2 = ss / SS_total if SS_total else float("nan")
        return {"H": float(H), "p": p, "eta2": float(eta2), "df": int(dfree)}

    return {"A": _term(SS_A, 1), "B": _term(SS_B, 1),
            "AB": _term(SS_AB, 1), "N": N}
