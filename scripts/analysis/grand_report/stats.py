"""Modern statistics layer.

pingouin (tidy tests + Bayesian + TOST), scipy.stats.bootstrap/
permutation_test (modern resampling), scikit-posthocs (Dunn),
lifelines (survival), factor_analyzer / sklearn (latent structure),
statsmodels (multiplicity). Every function returns a tidy dict and is
defensive: degenerate input → NaN dict, never an exception (a single
fragile cell must not break a 150-page build).
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from scipy import stats as ss

warnings.filterwarnings("ignore")


def _c(x):
    a = np.asarray(x, dtype=float)
    return a[~np.isnan(a)]


def describe(x) -> dict:
    a = _c(x)
    if a.size == 0:
        return dict(n=0, M=np.nan, SD=np.nan, Mdn=np.nan, IQR=np.nan,
                    min=np.nan, max=np.nan, skew=np.nan)
    q1, q3 = np.percentile(a, [25, 75])
    return dict(n=int(a.size), M=float(a.mean()),
                SD=float(a.std(ddof=1)) if a.size > 1 else np.nan,
                Mdn=float(np.median(a)), IQR=float(q3 - q1),
                min=float(a.min()), max=float(a.max()),
                skew=float(ss.skew(a)) if a.size > 2 else np.nan)


def cliffs_delta(a, b) -> float:
    a, b = _c(a), _c(b)
    if a.size == 0 or b.size == 0:
        return float("nan")
    return float(np.sign(a[:, None] - b[None, :]).sum() / (a.size * b.size))


def effect_band(d) -> str:
    d = abs(d)
    if np.isnan(d):
        return "NA"
    return ("negligible" if d < .147 else "small" if d < .330
            else "medium" if d < .474 else "large")


def cliffs_ci(a, b, n=5000, seed=42):
    a, b = _c(a), _c(b)
    if a.size < 2 or b.size < 2:
        return float("nan"), float("nan")
    try:
        res = ss.bootstrap((a, b), cliffs_delta, n_resamples=n,
                           method="basic", vectorized=False,
                           random_state=seed)
        return float(res.confidence_interval.low), \
            float(res.confidence_interval.high)
    except Exception:
        return float("nan"), float("nan")


def mann_whitney(a, b) -> dict:
    a, b = _c(a), _c(b)
    if a.size < 2 or b.size < 2:
        d0 = cliffs_delta(a, b)
        return dict(U=np.nan, p=np.nan, n_a=int(a.size), n_b=int(b.size),
                    delta=d0, ci_lo=np.nan, ci_hi=np.nan, cles=np.nan,
                    band=effect_band(d0))
    try:
        import pingouin as pg
        r = pg.mwu(a, b).iloc[0]
        U, p, cles = float(r["U-val"]), float(r["p-val"]), float(r["CLES"])
    except Exception:
        U, p = ss.mannwhitneyu(a, b, alternative="two-sided")
        U, p, cles = float(U), float(p), float("nan")
    d = cliffs_delta(a, b)
    lo, hi = cliffs_ci(a, b)
    return dict(U=U, p=p, n_a=int(a.size), n_b=int(b.size), delta=d,
                ci_lo=lo, ci_hi=hi, cles=cles, band=effect_band(d))


def kruskal(*groups) -> dict:
    gs = [_c(g) for g in groups]
    gs = [g for g in gs if g.size]
    if len(gs) < 2 or any(g.size < 2 for g in gs):
        return dict(H=np.nan, p=np.nan, ns=[int(g.size) for g in gs],
                    eps2=np.nan)
    H, p = ss.kruskal(*gs)
    N = sum(g.size for g in gs)
    eps2 = (H - len(gs) + 1) / (N - len(gs)) if N > len(gs) else np.nan
    return dict(H=float(H), p=float(p), ns=[int(g.size) for g in gs],
                eps2=float(eps2))


def dunn(df: pd.DataFrame, val: str, grp: str) -> pd.DataFrame:
    try:
        import scikit_posthocs as sp
        return sp.posthoc_dunn(df, val_col=val, group_col=grp,
                               p_adjust="holm")
    except Exception:
        return pd.DataFrame()


def fisher2x2(sa, na, sb, nb) -> dict:
    odds, p = ss.fisher_exact([[sa, na - sa], [sb, nb - sb]])
    return dict(odds_ratio=float(odds), p=float(p),
                rate_a=sa / na if na else np.nan,
                rate_b=sb / nb if nb else np.nan, n_a=int(na), n_b=int(nb))


def chi2_or_fisher(table) -> dict:
    t = np.asarray(table, float)
    if t.shape == (2, 2):
        o, p = ss.fisher_exact(t)
        return dict(test="Fisher exact", stat=float(o), p=float(p))
    try:
        chi2, p, dof, _ = ss.chi2_contingency(t)
        n = t.sum()
        v = np.sqrt(chi2 / (n * (min(t.shape) - 1))) if n else np.nan
        return dict(test="χ²", stat=float(chi2), p=float(p), dof=int(dof),
                    cramer_v=float(v))
    except Exception:
        return dict(test="χ²", stat=np.nan, p=np.nan)


def scheirer_ray_hare(df, dv, a, b) -> dict:
    d = df[[dv, a, b]].dropna().copy()
    if len(d) < 4 or d[a].nunique() < 2 or d[b].nunique() < 2:
        nan = dict(H=np.nan, p=np.nan, eta2=np.nan, df=1)
        return dict(A=nan, B=nan, AB=nan, N=int(len(d)))
    R = ss.rankdata(d[dv].to_numpy(float))
    N = R.size
    d["_R"] = R
    g = R.mean()
    SST = float(((R - g) ** 2).sum())

    def ssm(c):
        return float(sum(len(x) * (x["_R"].mean() - g) ** 2
                         for _, x in d.groupby(c, observed=True)))

    SA, SB = ssm(a), ssm(b)
    ma = d.groupby(a, observed=True)["_R"].mean()
    mb = d.groupby(b, observed=True)["_R"].mean()
    SAB = float(sum(len(x) * (x["_R"].mean() - ma[la] - mb[lb] + g) ** 2
                    for (la, lb), x in d.groupby([a, b], observed=True)))
    MST = SST / (N - 1) if N > 1 else np.nan

    def term(s):
        H = s / MST if MST and MST == MST else np.nan
        ok = H == H and np.isfinite(H)
        return dict(H=float(H),
                    p=float(ss.chi2.sf(H, 1)) if ok else np.nan,
                    eta2=float(s / SST) if SST else np.nan, df=1)

    return dict(A=term(SA), B=term(SB), AB=term(SAB), N=int(N))


def spearman_matrix(df) -> pd.DataFrame:
    return df.apply(pd.to_numeric, errors="coerce").corr(method="spearman")


def spearman(a, b) -> dict:
    s = pd.DataFrame({"a": a, "b": b}).dropna()
    if len(s) < 3:
        return dict(rho=np.nan, p=np.nan, n=len(s))
    r, p = ss.spearmanr(s["a"], s["b"])
    return dict(rho=float(r), p=float(p), n=int(len(s)))


def cronbach_alpha(items: pd.DataFrame) -> dict:
    m = items.apply(pd.to_numeric, errors="coerce").dropna()
    if m.shape[0] < 3 or m.shape[1] < 2:
        return dict(alpha=np.nan, ci_lo=np.nan, ci_hi=np.nan,
                    k=int(m.shape[1]), n=int(m.shape[0]))
    try:
        import pingouin as pg
        a, ci = pg.cronbach_alpha(data=m)
        return dict(alpha=float(a), ci_lo=float(ci[0]), ci_hi=float(ci[1]),
                    k=int(m.shape[1]), n=int(m.shape[0]))
    except Exception:
        k = m.shape[1]
        iv = m.var(ddof=1).sum()
        tv = m.sum(axis=1).var(ddof=1)
        a = (k / (k - 1)) * (1 - iv / tv) if tv else np.nan
        return dict(alpha=float(a), ci_lo=np.nan, ci_hi=np.nan,
                    k=int(k), n=int(m.shape[0]))


def multipletests(pvals, method="fdr_bh") -> list[float]:
    p = np.asarray(pvals, float)
    ok = ~np.isnan(p)
    out = np.full(p.size, np.nan)
    if ok.sum() == 0:
        return out.tolist()
    try:
        from statsmodels.stats.multitest import multipletests as mt
        out[ok] = mt(p[ok], method=method)[1]
    except Exception:
        n = ok.sum()
        order = np.argsort(p[ok])
        q = (p[ok][order] * n / (np.arange(n) + 1))
        q = np.minimum.accumulate(q[::-1])[::-1]
        tmp = np.empty(n)
        tmp[order] = np.clip(q, 0, 1)
        out[ok] = tmp
    return out.tolist()


def bayes_ttest(a, b) -> dict:
    a, b = _c(a), _c(b)
    if a.size < 2 or b.size < 2:
        return dict(bf10=np.nan, cohen_d=np.nan)
    try:
        import pingouin as pg
        r = pg.ttest(a, b, paired=False).iloc[0]
        bf = r.get("BF10", np.nan)
        bf = float(bf) if str(bf).replace(".", "", 1).replace(
            "e", "", 1).replace("-", "", 1).replace("+", "", 1).isdigit() \
            else float(str(bf))
        return dict(bf10=float(bf), cohen_d=float(r.get("cohen-d",
                    np.nan)))
    except Exception:
        return dict(bf10=np.nan, cohen_d=np.nan)


def tost(a, b, bound=0.5) -> dict:
    a, b = _c(a), _c(b)
    if a.size < 2 or b.size < 2:
        return dict(p_tost=np.nan, equivalent=None, bound=bound)
    try:
        import pingouin as pg
        r = pg.tost(a, b, bound=bound, paired=False).iloc[0]
        p = float(r["pval"])
        return dict(p_tost=p, equivalent=bool(p < .05), bound=bound)
    except Exception:
        return dict(p_tost=np.nan, equivalent=None, bound=bound)


def perm_diff(a, b, n=5000, seed=42) -> dict:
    a, b = _c(a), _c(b)
    if a.size < 2 or b.size < 2:
        return dict(diff=np.nan, p=np.nan)
    try:
        def st(x, y):
            return np.mean(x) - np.mean(y)
        r = ss.permutation_test((a, b), st, n_resamples=n,
                                permutation_type="independent",
                                random_state=seed)
        return dict(diff=float(np.mean(a) - np.mean(b)),
                    p=float(r.pvalue))
    except Exception:
        return dict(diff=float(np.mean(a) - np.mean(b)), p=np.nan)


def bootstrap_mean_ci(x, n=5000, seed=42):
    a = _c(x)
    if a.size < 2:
        return float("nan"), float("nan")
    try:
        r = ss.bootstrap((a,), np.mean, n_resamples=n, method="BCa",
                         random_state=seed)
        return float(r.confidence_interval.low), \
            float(r.confidence_interval.high)
    except Exception:
        return float("nan"), float("nan")


def km_logrank(dur, event, group) -> dict:
    try:
        from lifelines.statistics import multivariate_logrank_test
        d = pd.DataFrame({"d": dur, "e": event, "g": group}).dropna()
        if d["g"].nunique() < 2 or len(d) < 4:
            return dict(stat=np.nan, p=np.nan, groups=int(d["g"].nunique()))
        r = multivariate_logrank_test(d["d"], d["g"], d["e"])
        return dict(stat=float(r.test_statistic), p=float(r.p_value),
                    groups=int(d["g"].nunique()))
    except Exception:
        return dict(stat=np.nan, p=np.nan, groups=0)


def pca_2d(df) -> pd.DataFrame:
    try:
        from sklearn.decomposition import PCA
        from sklearn.preprocessing import StandardScaler
        m = df.apply(pd.to_numeric, errors="coerce").dropna()
        if m.shape[0] < 4 or m.shape[1] < 2:
            return pd.DataFrame()
        z = StandardScaler().fit_transform(m)
        p = PCA(n_components=2, random_state=42).fit(z)
        sc = p.transform(z)
        return pd.DataFrame({"idx": m.index, "PC1": sc[:, 0],
                             "PC2": sc[:, 1]}).assign(
            evr1=p.explained_variance_ratio_[0],
            evr2=p.explained_variance_ratio_[1])
    except Exception:
        return pd.DataFrame()


def _varimax(L, q=50, tol=1e-6):
    """Kaiser varimax rotation (numpy; factor_analyzer is incompatible
    with sklearn 1.8, so we rotate sklearn FactorAnalysis loadings)."""
    L = np.asarray(L, float)
    p, k = L.shape
    R = np.eye(k)
    d = 0
    for _ in range(q):
        Lr = L @ R
        u, s, vt = np.linalg.svd(
            L.T @ (Lr ** 3 - Lr @ np.diag(np.sum(Lr ** 2, 0)) / p))
        R = u @ vt
        d_old, d = d, np.sum(s)
        if d_old != 0 and d / d_old < 1 + tol:
            break
    return L @ R


def efa_loadings(df, n_factors=2) -> pd.DataFrame:
    """Exploratory factor structure via sklearn FactorAnalysis +
    varimax. Caveated: fragile at n≈40."""
    try:
        from sklearn.decomposition import FactorAnalysis
        from sklearn.preprocessing import StandardScaler
        m = df.apply(pd.to_numeric, errors="coerce").dropna()
        if m.shape[0] < 10 or m.shape[1] < 3:
            return pd.DataFrame()
        z = StandardScaler().fit_transform(m)
        fa = FactorAnalysis(n_components=n_factors, rotation=None,
                            random_state=42).fit(z)
        L = _varimax(fa.components_.T)
        out = pd.DataFrame(L, index=m.columns,
                           columns=[f"F{i+1}" for i in range(n_factors)])
        return out.round(3).reset_index(names="item")
    except Exception:
        return pd.DataFrame()
