"""The quad runner — the DRY engine behind every analysis group.

Given a participant-level tidy frame (cols: exp, mode, role, opponent,
+ a numeric value), it emits the four analytical levels the user
required:

  L1  distinct   — each experiment X1–X4 profiled one-by-one
  L2  2×2        — factorial (Mode / Role / Mode×Role) + the structured
                   pairwise cell contrasts (+ opponent sensitivity)
  L3  overall    — pooled N=40, Mode-collapsed, Role-collapsed
  L4  review     — synthesised downstream from L1–L3 (narrative.py)

Returns raw numeric frames (for figures) AND display frames (APA-
formatted via design.fmt_*), so tables and plots stay coherent.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import stats as S
from .design import EXP_ORDER, fmt_ci, fmt_d, fmt_num, fmt_p, fmt_q

# the six structured pairwise contrasts among X1–X4
PAIRS = [
    ("X1", "X3", "Mode | Buyer (X1 vs X3)"),
    ("X2", "X4", "Mode | Seller (X2 vs X4)"),
    ("X1", "X2", "Role | Delegated (X1 vs X2)"),
    ("X3", "X4", "Role | Direct (X3 vs X4)"),
    ("X1", "X4", "Diagonal (X1 vs X4)"),
    ("X2", "X3", "Diagonal (X2 vs X3)"),
]


def _g(df, col, *vals):
    return df.loc[df[col].isin(vals), "value"].dropna()


def quad_continuous(frame: pd.DataFrame, value: str) -> dict:
    """frame must contain exp, mode, role, opponent, <value>."""
    df = frame.rename(columns={value: "value"})[
        ["exp", "mode", "role", "opponent", "value"]].copy()
    df["value"] = pd.to_numeric(df["value"], errors="coerce")

    # ── L1 distinct (one-by-one) ──
    l1 = []
    for x in EXP_ORDER:
        d = S.describe(df.loc[df["exp"] == x, "value"])
        lo, hi = S.bootstrap_mean_ci(df.loc[df["exp"] == x, "value"])
        l1.append({"Experiment": x, "n": d["n"],
                   "M": round(d["M"], 2), "SD": round(d["SD"], 2),
                   "Mdn": d["Mdn"], "IQR": round(d["IQR"], 2),
                   "95% CI M": fmt_ci(lo, hi, bounded=False),
                   "skew": round(d["skew"], 2)})
    l1 = pd.DataFrame(l1)

    # ── L2 factorial ──
    srh = S.scheirer_ray_hare(df, "value", "mode", "role")
    mw_mode = S.mann_whitney(_g(df, "mode", "delegated"),
                             _g(df, "mode", "direct"))
    mw_role = S.mann_whitney(_g(df, "role", "buyer"),
                             _g(df, "role", "seller"))
    kw_opp = S.kruskal(*[df.loc[df["opponent"] == o, "value"]
                         for o in ("easygoing", "moderate", "tough")])
    l2_fac = pd.DataFrame([
        {"Term": "Mode (SRH)", "stat": f"H={fmt_num(srh['A']['H'])}",
         "p": fmt_p(srh["A"]["p"]), "effect": f"η²={fmt_d(srh['A']['eta2'])}"},
        {"Term": "Role (SRH)", "stat": f"H={fmt_num(srh['B']['H'])}",
         "p": fmt_p(srh["B"]["p"]), "effect": f"η²={fmt_d(srh['B']['eta2'])}"},
        {"Term": "Mode×Role (SRH)", "stat": f"H={fmt_num(srh['AB']['H'])}",
         "p": fmt_p(srh["AB"]["p"]),
         "effect": f"η²={fmt_d(srh['AB']['eta2'])}"},
        {"Term": "Mode (Mann–Whitney)", "stat": f"U={fmt_num(mw_mode['U'],0)}",
         "p": fmt_p(mw_mode["p"]),
         "effect": f"δ={fmt_d(mw_mode['delta'])} {fmt_ci(mw_mode['ci_lo'], mw_mode['ci_hi'])} ({mw_mode['band']})"},
        {"Term": "Role (Mann–Whitney)", "stat": f"U={fmt_num(mw_role['U'],0)}",
         "p": fmt_p(mw_role["p"]),
         "effect": f"δ={fmt_d(mw_role['delta'])} ({mw_role['band']})"},
        {"Term": "Opponent (Kruskal–Wallis, sensitivity)",
         "stat": f"H={fmt_num(kw_opp['H'])}", "p": fmt_p(kw_opp["p"]),
         "effect": f"ε²={fmt_d(kw_opp['eps2'])}"},
    ])

    # ── L2 pairwise (BH across the six) ──
    rows, praw = [], []
    for a, b, lab in PAIRS:
        mw = S.mann_whitney(df.loc[df["exp"] == a, "value"],
                            df.loc[df["exp"] == b, "value"])
        praw.append(mw["p"])
        rows.append({"Contrast": lab, "n": f"{mw['n_a']}/{mw['n_b']}",
                     "U": fmt_num(mw["U"], 0), "p": fmt_p(mw["p"]),
                     "Cliff δ": fmt_d(mw["delta"]),
                     "95% CI": fmt_ci(mw["ci_lo"], mw["ci_hi"]),
                     "band": mw["band"]})
    for r, q in zip(rows, S.multipletests(praw, "fdr_bh")):
        r["q (BH)"] = fmt_q(q)
    l2_pair = pd.DataFrame(rows)

    # ── L3 overall ──
    od = S.describe(df["value"])
    olo, ohi = S.bootstrap_mean_ci(df["value"])
    l3 = pd.DataFrame([
        {"View": "Overall (pooled N)", "n": od["n"],
         "M": round(od["M"], 2), "SD": round(od["SD"], 2),
         "Mdn": od["Mdn"], "95% CI M": fmt_ci(olo, ohi, bounded=False)},
        *[{"View": f"Mode = {m}",
           "n": S.describe(df.loc[df['mode'] == m, 'value'])["n"],
           "M": round(S.describe(df.loc[df['mode'] == m, 'value'])["M"], 2),
           "SD": round(S.describe(df.loc[df['mode'] == m, 'value'])["SD"], 2),
           "Mdn": S.describe(df.loc[df['mode'] == m, 'value'])["Mdn"],
           "95% CI M": ""} for m in ("delegated", "direct")],
        *[{"View": f"Role = {r}",
           "n": S.describe(df.loc[df['role'] == r, 'value'])["n"],
           "M": round(S.describe(df.loc[df['role'] == r, 'value'])["M"], 2),
           "SD": round(S.describe(df.loc[df['role'] == r, 'value'])["SD"], 2),
           "Mdn": S.describe(df.loc[df['role'] == r, 'value'])["Mdn"],
           "95% CI M": ""} for r in ("buyer", "seller")],
    ])

    return {"l1": l1, "l2_factorial": l2_fac, "l2_pairwise": l2_pair,
            "l3": l3,
            "raw": {"srh": srh, "mw_mode": mw_mode, "mw_role": mw_role,
                    "kw_opp": kw_opp, "describe": od},
            "frame": df}


def multi_quad(frame: pd.DataFrame, value_cols: list[str]) -> dict:
    """Compact coherent quad across many DVs: one L1 table (DV × X1–X4
    means), one L2 table (DV × Mode/Role/M×R + best pairwise), one L3
    table (DV × overall/Mode/Role). Keeps 'all 45 full quad' navigable.
    Also returns the per-DV raw stats for the L4 synthesis."""
    l1, l2, l3, raw = [], [], [], {}
    for v in value_cols:
        q = quad_continuous(frame, v)
        r = q["raw"]
        raw[v] = r
        m = {x: frame.loc[frame["exp"] == x, v].astype(float).mean()
             for x in EXP_ORDER}
        l1.append({"Measure": v, **{x: round(m[x], 2) for x in EXP_ORDER},
                   "N": int(frame[v].notna().sum())})
        best_lab, best_p = "—", 1.0
        for a, b, lab in PAIRS:
            pp = S.mann_whitney(frame.loc[frame["exp"] == a, v],
                                frame.loc[frame["exp"] == b, v])["p"]
            if pp == pp and pp < best_p:
                best_p, best_lab = pp, lab
        def _bp(pv):
            return fmt_p(pv).replace("p = ", "").replace("p ", "")
        l2.append({"Measure": v,
                   "Mode p": _bp(r["mw_mode"]["p"]),
                   "Mode δ": fmt_d(r["mw_mode"]["delta"]),
                   "Mode 95%CI": fmt_ci(r["mw_mode"]["ci_lo"],
                                        r["mw_mode"]["ci_hi"]),
                   "Role p": _bp(r["mw_role"]["p"]),
                   "M×R p": _bp(r["srh"]["AB"]["p"]),
                   "Opp p": _bp(r["kw_opp"]["p"]),
                   "Top pairwise": best_lab,
                   "that p": _bp(best_p)})
        od = r["describe"]
        dl = frame.loc[frame["mode"] == "delegated", v].astype(float)
        di = frame.loc[frame["mode"] == "direct", v].astype(float)
        bu = frame.loc[frame["role"] == "buyer", v].astype(float)
        se = frame.loc[frame["role"] == "seller", v].astype(float)
        l3.append({"Measure": v,
                   "Overall M(SD)": f"{od['M']:.2f} ({od['SD']:.2f})",
                   "Delegated": f"{dl.mean():.2f}",
                   "Direct": f"{di.mean():.2f}",
                   "Buyer": f"{bu.mean():.2f}",
                   "Seller": f"{se.mean():.2f}"})
    return {"l1": pd.DataFrame(l1), "l2": pd.DataFrame(l2),
            "l3": pd.DataFrame(l3), "raw": raw}


def quad_binary(frame: pd.DataFrame, value: str) -> dict:
    """Binary/proportion DV (e.g., agreed). L1 rates per X; L2 Fisher
    (Mode, Role) + χ² (opponent) + pairwise Fisher; L3 pooled rate."""
    df = frame.rename(columns={value: "value"})[
        ["exp", "mode", "role", "opponent", "value"]].copy()
    df["value"] = pd.to_numeric(df["value"], errors="coerce")

    l1 = pd.DataFrame([
        {"Experiment": x,
         "n": int(df.loc[df["exp"] == x, "value"].notna().sum()),
         "k": int(df.loc[df["exp"] == x, "value"].sum()),
         "rate": f"{df.loc[df['exp'] == x, 'value'].mean():.0%}"}
        for x in EXP_ORDER])

    def _f(col, a, b):
        ga = df.loc[df[col] == a, "value"]
        gb = df.loc[df[col] == b, "value"]
        return S.fisher2x2(int(ga.sum()), len(ga), int(gb.sum()), len(gb))

    fm, fr = _f("mode", "delegated", "direct"), _f("role", "buyer", "seller")
    tab = pd.crosstab(df["opponent"], df["value"])
    co = S.chi2_or_fisher(tab.to_numpy())
    l2_fac = pd.DataFrame([
        {"Term": "Mode (Fisher)",
         "detail": f"{fm['rate_a']:.0%} vs {fm['rate_b']:.0%}",
         "p": fmt_p(fm["p"]), "effect": f"OR={fmt_num(fm['odds_ratio'])}"},
        {"Term": "Role (Fisher)",
         "detail": f"{fr['rate_a']:.0%} vs {fr['rate_b']:.0%}",
         "p": fmt_p(fr["p"]), "effect": f"OR={fmt_num(fr['odds_ratio'])}"},
        {"Term": "Opponent (χ²)", "detail": co["test"],
         "p": fmt_p(co["p"]),
         "effect": f"V={fmt_d(co.get('cramer_v', float('nan')))}"},
    ])
    rows, praw = [], []
    for a, b, lab in PAIRS:
        ga = df.loc[df["exp"] == a, "value"]
        gb = df.loc[df["exp"] == b, "value"]
        r = S.fisher2x2(int(ga.sum()), len(ga), int(gb.sum()), len(gb))
        praw.append(r["p"])
        rows.append({"Contrast": lab,
                     "rate": f"{r['rate_a']:.0%} vs {r['rate_b']:.0%}",
                     "OR": fmt_num(r["odds_ratio"]), "p": fmt_p(r["p"])})
    for r, q in zip(rows, S.multipletests(praw, "fdr_bh")):
        r["q (BH)"] = fmt_q(q)
    l2_pair = pd.DataFrame(rows)

    l3 = pd.DataFrame([
        {"View": "Overall", "n": int(df["value"].notna().sum()),
         "k": int(df["value"].sum()), "rate": f"{df['value'].mean():.0%}"},
        *[{"View": f"Mode={m}",
           "n": int((df["mode"] == m).sum()),
           "k": int(df.loc[df["mode"] == m, "value"].sum()),
           "rate": f"{df.loc[df['mode'] == m, 'value'].mean():.0%}"}
          for m in ("delegated", "direct")],
        *[{"View": f"Role={r}",
           "n": int((df["role"] == r).sum()),
           "k": int(df.loc[df["role"] == r, "value"].sum()),
           "rate": f"{df.loc[df['role'] == r, 'value'].mean():.0%}"}
          for r in ("buyer", "seller")],
    ])
    return {"l1": l1, "l2_factorial": l2_fac, "l2_pairwise": l2_pair,
            "l3": l3, "raw": {"fm": fm, "fr": fr, "co": co}, "frame": df}
