"""Statistical helpers used across the analysis.

Conventions
-----------
- Effect sizes are signed: positive when group A > group B.
- All tests return a dict so callers can serialise uniformly into the
  results bundle.
- BH-FDR follows Benjamini & Hochberg (1995); the implementation is monotone
  from the largest p downward.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pingouin as pg
from scipy import stats as scistats


# ─── Effect sizes ───────────────────────────────────────────────────

def cliff_delta(a, b) -> float:
    """Cliff's δ ∈ [-1, 1]. δ = P(A > B) - P(A < B)."""
    a = np.asarray(a, dtype=float); a = a[~np.isnan(a)]
    b = np.asarray(b, dtype=float); b = b[~np.isnan(b)]
    if a.size == 0 or b.size == 0:
        return float("nan")
    diff = a[:, None] - b[None, :]
    return float(np.sign(diff).sum() / (a.size * b.size))


def effect_size_band(delta: float) -> str:
    """Romano et al. (2006) Cliff's δ bands."""
    d = abs(delta)
    if d < 0.147:  return "negligible"
    if d < 0.33:   return "small"
    if d < 0.474:  return "medium"
    return "large"


def cohens_d(a, b) -> float:
    a = np.asarray(a, dtype=float); a = a[~np.isnan(a)]
    b = np.asarray(b, dtype=float); b = b[~np.isnan(b)]
    if a.size < 2 or b.size < 2:
        return float("nan")
    pooled_var = ((a.size - 1) * a.var(ddof=1) + (b.size - 1) * b.var(ddof=1)) / (a.size + b.size - 2)
    pooled = np.sqrt(pooled_var)
    return float((a.mean() - b.mean()) / pooled) if pooled > 0 else float("nan")


# ─── Reliability ────────────────────────────────────────────────────

def cronbach_alpha(items: pd.DataFrame, n_boot: int = 1000, random_state: int | None = None):
    """Returns (alpha, ci_low, ci_high) — point estimate + 95 % bootstrap CI."""
    items = items.dropna(how="any")
    if items.shape[0] < 3 or items.shape[1] < 2:
        return float("nan"), float("nan"), float("nan")
    res = pg.cronbach_alpha(data=items)
    point = float(res[0])
    rng = np.random.default_rng(random_state)
    boots = []
    idx = items.index.to_numpy()
    for _ in range(n_boot):
        sample = items.loc[rng.choice(idx, size=len(idx), replace=True)]
        try:
            boots.append(float(pg.cronbach_alpha(data=sample)[0]))
        except Exception:
            continue
    if not boots:
        return point, float("nan"), float("nan")
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return point, float(lo), float(hi)


# ─── Multiple-comparison correction ─────────────────────────────────

def fdr_bh(pvalues) -> list[float]:
    """Benjamini-Hochberg adjusted q-values, returned in the input order.

    Monotone decreasing from the largest p downward (so q_i never exceeds
    q_{i+1} after re-sorting by p).
    """
    p = np.asarray(pvalues, dtype=float)
    n = p.size
    if n == 0:
        return []
    order = np.argsort(p)
    ranked = p[order]
    q_ranked = ranked * n / (np.arange(n) + 1)
    q_ranked = np.minimum.accumulate(q_ranked[::-1])[::-1]
    q = np.empty(n)
    q[order] = np.clip(q_ranked, 0, 1)
    return q.tolist()


# ─── Bootstrap ──────────────────────────────────────────────────────

def bootstrap_ci(data, statistic=np.mean, n_boot: int = 1000, alpha: float = 0.05,
                 random_state: int | None = None) -> tuple[float, float]:
    arr = np.asarray(data, dtype=float)
    arr = arr[~np.isnan(arr)]
    if arr.size < 2:
        return float("nan"), float("nan")
    rng = np.random.default_rng(random_state)
    boots = [statistic(rng.choice(arr, size=arr.size, replace=True)) for _ in range(n_boot)]
    lo, hi = np.percentile(boots, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return float(lo), float(hi)


# ─── Hypothesis tests ───────────────────────────────────────────────

def mann_whitney(a, b, *, alternative: str = "two-sided") -> dict:
    a = np.asarray(a, dtype=float); a = a[~np.isnan(a)]
    b = np.asarray(b, dtype=float); b = b[~np.isnan(b)]
    if a.size < 2 or b.size < 2:
        return {"U": float("nan"), "p": float("nan"), "n_a": int(a.size), "n_b": int(b.size)}
    U, p = scistats.mannwhitneyu(a, b, alternative=alternative)
    return {"U": float(U), "p": float(p), "n_a": int(a.size), "n_b": int(b.size)}


def kruskal_wallis(*groups) -> dict:
    arrs = [np.asarray(g, dtype=float) for g in groups]
    arrs = [a[~np.isnan(a)] for a in arrs]
    if any(a.size < 2 for a in arrs):
        return {"H": float("nan"), "p": float("nan"), "ns": [int(a.size) for a in arrs]}
    H, p = scistats.kruskal(*arrs)
    return {"H": float(H), "p": float(p), "ns": [int(a.size) for a in arrs]}


def welch_t(a, b) -> dict:
    a = np.asarray(a, dtype=float); a = a[~np.isnan(a)]
    b = np.asarray(b, dtype=float); b = b[~np.isnan(b)]
    if a.size < 2 or b.size < 2:
        return {"t": float("nan"), "p": float("nan"), "n_a": int(a.size), "n_b": int(b.size)}
    t, p = scistats.ttest_ind(a, b, equal_var=False)
    return {"t": float(t), "p": float(p), "n_a": int(a.size), "n_b": int(b.size)}


def anova_one_way(*groups) -> dict:
    arrs = [np.asarray(g, dtype=float) for g in groups]
    arrs = [a[~np.isnan(a)] for a in arrs]
    if any(a.size < 2 for a in arrs):
        return {"F": float("nan"), "p": float("nan"), "eta2": float("nan"),
                "ns": [int(a.size) for a in arrs]}
    F, p = scistats.f_oneway(*arrs)
    grand_mean = np.concatenate(arrs).mean()
    ss_between = sum(a.size * (a.mean() - grand_mean) ** 2 for a in arrs)
    ss_total = sum(((a - grand_mean) ** 2).sum() for a in arrs)
    eta2 = ss_between / ss_total if ss_total > 0 else float("nan")
    return {"F": float(F), "p": float(p), "eta2": float(eta2),
            "ns": [int(a.size) for a in arrs]}
