"""Clean-room nonparametric stats for the process report. scipy/numpy only."""
from __future__ import annotations

import numpy as np
from scipy import stats as _sp


def _cliffs_delta(a, b) -> float:
    a = np.asarray(a, float); b = np.asarray(b, float)
    if a.size == 0 or b.size == 0:
        return float("nan")
    gt = sum((x > b).sum() for x in a)
    lt = sum((x < b).sum() for x in a)
    return float((gt - lt) / (a.size * b.size))


def mann_whitney(a, b) -> dict:
    a = np.asarray(a, float); a = a[~np.isnan(a)]
    b = np.asarray(b, float); b = b[~np.isnan(b)]
    if a.size < 2 or b.size < 2:
        return {"U": float("nan"), "p": float("nan"),
                "cliffs_delta": float("nan"), "n_a": int(a.size),
                "n_b": int(b.size)}
    U, p = _sp.mannwhitneyu(a, b, alternative="two-sided")
    return {"U": float(U), "p": float(p),
            "cliffs_delta": _cliffs_delta(a, b),
            "n_a": int(a.size), "n_b": int(b.size)}


def kruskal_wallis(*groups) -> dict:
    gs = [np.asarray(g, float) for g in groups]
    gs = [g[~np.isnan(g)] for g in gs if np.asarray(g).size]
    if len(gs) < 2 or any(g.size < 1 for g in gs):
        return {"H": float("nan"), "p": float("nan"), "eps2": float("nan")}
    k = _sp.kruskal(*gs)
    N = sum(g.size for g in gs)
    eps2 = float(k.statistic / (N - 1)) if N > 1 else float("nan")
    return {"H": float(k.statistic), "p": float(k.pvalue),
            "eps2": min(max(eps2, 0.0), 1.0)}


def scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict:
    d = df[[dv, a, b]].dropna().copy()
    R = _sp.rankdata(d[dv].to_numpy(float))
    N = int(R.size)
    d["_R"] = R
    grand = float(R.mean())
    SS_total = float(((R - grand) ** 2).sum())

    def _ssm(col):
        return float(sum(len(g) * (float(g["_R"].mean()) - grand) ** 2
                         for _, g in d.groupby(col, observed=True)))

    SS_A = _ssm(a)
    SS_B = _ssm(b)
    ma = d.groupby(a, observed=True)["_R"].mean()
    mb = d.groupby(b, observed=True)["_R"].mean()
    SS_AB = float(sum(
        len(g) * (float(g["_R"].mean()) - float(ma[la]) - float(mb[lb])
                  + grand) ** 2
        for (la, lb), g in d.groupby([a, b], observed=True)))
    MS_total = SS_total / (N - 1) if N > 1 else float("nan")

    def _term(ss):
        H = ss / MS_total if MS_total and MS_total == MS_total else float("nan")
        ok = H == H and np.isfinite(H)
        return {"H": float(H),
                "p": float(_sp.chi2.sf(H, 1)) if ok else float("nan"),
                "eta2": float(ss / SS_total) if SS_total else float("nan"),
                "df": 1}

    return {"A": _term(SS_A), "B": _term(SS_B), "AB": _term(SS_AB), "N": N}


def fisher_2x2(succ_a: int, n_a: int, succ_b: int, n_b: int) -> dict:
    odds, p = _sp.fisher_exact([[succ_a, n_a - succ_a],
                                [succ_b, n_b - succ_b]])
    return {"odds_ratio": float(odds), "p": float(p),
            "rate_a": succ_a / n_a if n_a else float("nan"),
            "rate_b": succ_b / n_b if n_b else float("nan"),
            "n_a": n_a, "n_b": n_b}


def bootstrap_ci(a, b, n_boot: int = 1000, seed: int = 42) -> tuple:
    """Two-sample percentile CI for Cliff's delta (independent resample)."""
    rng = np.random.default_rng(seed)
    A = np.asarray(a, float); B = np.asarray(b, float)
    boots = [_cliffs_delta(rng.choice(A, A.size, replace=True),
                           rng.choice(B, B.size, replace=True))
             for _ in range(n_boot)]
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))
