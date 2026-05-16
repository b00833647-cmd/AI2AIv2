"""Templated figures — every plot uses the one shared theme/palette so
X1–X4 look identical document-wide. Each builder returns a PNG Path.
Reusable templates (distribution, interaction, forest, heatmap, …) are
parametrised so any analysis group can call them coherently.
"""
from __future__ import annotations

import json

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

from . import db
from . import stats as S
from .design import (EXP_COLORS, EXP_ORDER, MODE_COLORS, OUTCOME_COLORS,
                      ROLE_COLORS, apply_theme, save)
from .framework import PAIRS


# ── reusable templates ──────────────────────────────────────────────

def fig_distribution(frame: pd.DataFrame, value: str, name: str,
                     title: str) -> "Path":
    """L1 — raincloud-style distribution per experiment (X1–X4)."""
    apply_theme()
    d = frame[["exp", value]].dropna().copy()
    d["exp"] = pd.Categorical(d["exp"], EXP_ORDER, ordered=True)
    fig, ax = plt.subplots()
    pal = [EXP_COLORS[x] for x in EXP_ORDER if x in set(d["exp"])]
    sns.violinplot(data=d, x="exp", y=value, hue="exp", order=EXP_ORDER,
                   palette=EXP_COLORS, inner=None, cut=0, density_norm="width",
                   legend=False, ax=ax, alpha=.35)
    sns.boxplot(data=d, x="exp", y=value, order=EXP_ORDER, width=.16,
                showcaps=True, boxprops={"facecolor": "white", "zorder": 3},
                showfliers=False, ax=ax)
    sns.stripplot(data=d, x="exp", y=value, order=EXP_ORDER, color="#222",
                  size=3, alpha=.55, jitter=.12, ax=ax)
    ax.set_xlabel("")
    ax.set_ylabel(value)
    ax.set_title(title)
    return save(fig, name, aspect=0.52)


def fig_interaction(frame: pd.DataFrame, value: str, name: str,
                    title: str) -> "Path":
    """L2 — Mode × Role interaction (mean ± 95% CI)."""
    apply_theme()
    d = frame.copy()
    if "mode2" not in d.columns or d["mode2"].isna().all():
        d["mode2"] = d["mode"].map(
            {"delegated": "AI-to-AI", "direct": "Human-to-AI"})
    d = d[["mode2", "role", value]].dropna()
    fig, ax = plt.subplots()
    modes = ["AI-to-AI", "Human-to-AI"]
    x = np.arange(2)
    for role in ["buyer", "seller"]:
        m, e = [], []
        for mo in modes:
            v = pd.to_numeric(
                d[(d["mode2"] == mo) & (d["role"] == role)][value],
                errors="coerce").dropna()
            m.append(v.mean())
            e.append(1.96 * v.std() / np.sqrt(len(v)) if len(v) > 1 else 0)
        ax.errorbar(x, m, yerr=e, fmt="o-", capsize=4, lw=2,
                    color=ROLE_COLORS[role], label=role)
    ax.set_xticks(x)
    ax.set_xticklabels(modes)
    ax.set_ylabel(f"{value} (mean ± 95% CI)")
    ax.set_title(title)
    ax.legend(title="Role", fontsize=8)
    return save(fig, name, aspect=0.52)


def fig_forest(frame: pd.DataFrame, value: str, name: str,
               title: str) -> "Path":
    """L2 — Cliff's δ + bootstrap CI for the six pairwise contrasts."""
    apply_theme()
    rows = []
    for a, b, lab in PAIRS:
        ga = frame.loc[frame["exp"] == a, value]
        gb = frame.loc[frame["exp"] == b, value]
        mw = S.mann_whitney(ga, gb)
        rows.append((lab, mw["delta"], mw["ci_lo"], mw["ci_hi"]))
    rows = rows[::-1]
    fig, ax = plt.subplots()
    y = np.arange(len(rows))
    for i, (lab, d, lo, hi) in enumerate(rows):
        ax.plot([lo, hi], [i, i], color="#555", lw=2, zorder=1)
        ax.scatter([d], [i], color="#0072B2", s=42, zorder=3)
    ax.axvline(0, color="#C1543B", ls="--", lw=1)
    ax.set_yticks(y)
    ax.set_yticklabels([r[0] for r in rows], fontsize=8)
    ax.set_xlabel("Cliff's δ (95% bootstrap CI)")
    ax.set_xlim(-1.05, 1.05)
    ax.set_title(title)
    return save(fig, name, aspect=0.5)


def fig_heatmap(mat: pd.DataFrame, name: str, title: str, *,
                vmin=-1, vmax=1, center=0, cmap="RdBu_r",
                fmt=".2f") -> "Path":
    apply_theme()
    fig, ax = plt.subplots()
    sns.heatmap(mat.astype(float), annot=True, fmt=fmt, cmap=cmap,
                center=center, vmin=vmin, vmax=vmax, square=True,
                annot_kws={"size": 6}, cbar_kws={"shrink": .7}, ax=ax)
    ax.set_title(title)
    ax.set_xlabel("")
    ax.set_ylabel("")
    plt.xticks(rotation=40, ha="right", fontsize=7)
    plt.yticks(fontsize=7)
    return save(fig, name, aspect=0.8)


# ── document-specific figures ───────────────────────────────────────

def fig_funnel(con) -> "Path":
    apply_theme()
    from .metrics import g01
    f = g01(con)["tables"]["Funnel"]
    fig, ax = plt.subplots()
    ax.barh(f["Stage"], f["n"], color="#0072B2")
    for i, v in enumerate(f["n"]):
        ax.text(v + 0.6, i, str(v), va="center", fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel("Participants")
    ax.set_title("Participant flow (59 → 40 → agreement)")
    return save(fig, "fig_funnel", aspect=0.42)


def fig_outcomes(con) -> "Path":
    apply_theme()
    c = db.completers(con)
    ct = (c.groupby(["exp", "outcome_type"]).size()
          .unstack(fill_value=0).reindex(EXP_ORDER))
    fig, ax = plt.subplots()
    bottom = np.zeros(len(ct))
    for oc in ["agreed", "rejected", "impasse", "aborted"]:
        if oc in ct.columns:
            ax.bar(ct.index, ct[oc], bottom=bottom, label=oc,
                   color=OUTCOME_COLORS[oc])
            bottom += ct[oc].values
    ax.set_ylabel("Participants")
    ax.set_title("Outcome type by experiment (X1–X4)")
    ax.legend(fontsize=8)
    return save(fig, "fig_outcomes", aspect=0.5)


def fig_price_zopa(con) -> "Path":
    apply_theme()
    c = db.completers(con)
    a = c[(c["outcome_type"] == "agreed") &
          c["settlement_price"].notna()].copy()
    a["exp"] = pd.Categorical(a["exp"], EXP_ORDER, ordered=True)
    fig, ax = plt.subplots()
    ax.axhspan(db.ZOPA_LOW, db.ZOPA_HIGH, color="#009E73", alpha=.12,
               label=f"ZOPA {db.ZOPA_LOW:.0f}–{db.ZOPA_HIGH:.0f}")
    ax.axhline(db.ZOPA_MID, ls="--", color="#009E73", lw=1)
    sns.stripplot(data=a, x="exp", y="settlement_price", order=EXP_ORDER,
                  hue="exp", palette=EXP_COLORS, size=7, alpha=.8,
                  legend=False, ax=ax)
    ax.set_xlabel("")
    ax.set_ylabel("Settlement price (USD)")
    ax.set_title(f"Settlements vs ZOPA by experiment (n={len(a)} agreed)")
    ax.legend(fontsize=7)
    return save(fig, "fig_price_zopa", aspect=0.52)


def fig_survey_heatmap(con) -> "Path":
    apply_theme()
    w = db.survey_wide(con)
    piv = pd.DataFrame({x: pd.to_numeric(
        w.loc[w["exp"] == x, db.SURVEY_KEYS].mean(), errors="coerce")
        for x in EXP_ORDER})
    piv.index = [db.SURVEY_LABEL[i] for i in db.SURVEY_KEYS]
    fig, ax = plt.subplots()
    sns.heatmap(piv, annot=True, fmt=".1f", cmap="RdYlBu", center=4,
                vmin=1, vmax=7, cbar_kws={"label": "Mean (1–7)",
                                          "shrink": .7}, ax=ax)
    ax.set_title("Nine measures × four experiments (means)")
    ax.set_xlabel("")
    ax.set_ylabel("")
    return save(fig, "fig_survey_heatmap", aspect=0.62)


def fig_survey_panel(con) -> "Path":
    apply_theme()
    w = db.survey_wide(con)
    long = w.melt(id_vars=["exp"], value_vars=db.SURVEY_KEYS,
                  var_name="item", value_name="v").dropna()
    long["item"] = long["item"].map(db.SURVEY_LABEL)
    g = sns.catplot(data=long, x="exp", y="v", col="item", col_wrap=3,
                    order=EXP_ORDER, hue="exp", palette=EXP_COLORS,
                    kind="box", height=1.7, aspect=1.15, legend=False,
                    showfliers=False)
    g.set_titles("{col_name}")
    g.set_axis_labels("", "1–7")
    g.figure.suptitle("Each measure by experiment", y=1.02)
    from .design import FIG_DIR
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    p = FIG_DIR / "fig_survey_panel.png"
    g.figure.savefig(p, dpi=300, bbox_inches="tight")
    plt.close(g.figure)
    return p


def fig_affect(con) -> "Path":
    apply_theme()
    w = db.survey_wide(con)
    fig, ax = plt.subplots()
    for x in EXP_ORDER:
        s = w[w["exp"] == x]
        ax.scatter(pd.to_numeric(s["emot_pleasant"], errors="coerce"),
                   pd.to_numeric(s["emot_anxious"], errors="coerce"),
                   color=EXP_COLORS[x], label=x, s=42, alpha=.8)
    ax.set_xlabel("Pleasant affect (1–7)")
    ax.set_ylabel("Anxious affect (1–7)")
    ax.set_title("Affect space by experiment")
    ax.legend(fontsize=8)
    return save(fig, "fig_affect", aspect=0.6)


def fig_offer_paths(con) -> "Path":
    apply_theme()
    base = db.completers(con)[["session_id", "exp"]]
    sids = list(base["session_id"])
    qm = ",".join("?" * len(sids))
    t = pd.read_sql_query(
        f"SELECT session_id, turn_number, emitter_id, tool_calls_json "
        f"FROM turns WHERE session_id IN ({qm})", con, params=sids)
    t["turn_number"] = pd.to_numeric(t["turn_number"], errors="coerce")
    fig, axes = plt.subplots(2, 2, figsize=(6.4, 5.2), sharey=True)
    axmap = dict(zip(EXP_ORDER, axes.flat))
    for x, ax in axmap.items():
        ax.axhspan(db.ZOPA_LOW, db.ZOPA_HIGH, color="#009E73", alpha=.10)
        for sid in base.loc[base["exp"] == x, "session_id"]:
            td = t[t["session_id"] == sid].sort_values("turn_number")
            xs, ys = [], []
            for _, r in td.iterrows():
                try:
                    arr = json.loads(r["tool_calls_json"])
                except Exception:
                    continue
                for tc in arr:
                    if tc.get("name") != "submit_proposal":
                        continue
                    for iss in (tc.get("input", {}) or {}).get(
                            "issues", []) or []:
                        if iss.get("name") == "price":
                            try:
                                ys.append(float(iss["value"]))
                                xs.append(r["turn_number"])
                            except Exception:
                                pass
            if xs:
                ax.plot(xs, ys, "-o", ms=2.5, lw=.8,
                        color=EXP_COLORS[x], alpha=.5)
        ax.set_title(x, fontsize=9)
        ax.set_xlabel("turn")
    axes[0, 0].set_ylabel("price")
    axes[1, 0].set_ylabel("price")
    fig.suptitle("Offer trajectories by experiment (ZOPA shaded)", y=1.0)
    from .design import save as _s
    return _s(fig, "fig_offer_paths", aspect=0.8)


def fig_engagement(con) -> "Path":
    apply_theme()
    from .metrics import _instr
    f = _instr(con)
    fig, axes = plt.subplots(1, 3, figsize=(6.4, 2.7))
    for ax, col, t in zip(axes, ["active_s", "scroll_depth", "n_clicks"],
                          ["Active time (s)", "Scroll depth (%)",
                           "Clicks"]):
        sns.boxplot(data=f, x="exp", y=col, order=EXP_ORDER, hue="exp",
                    palette=EXP_COLORS, legend=False, showfliers=False,
                    ax=ax)
        ax.set_title(t, fontsize=9)
        ax.set_xlabel("")
        ax.set_ylabel("")
        ax.tick_params(axis="x", labelsize=7)
    fig.suptitle("Engagement instrumentation by experiment", y=1.03)
    from .design import save as _s
    return _s(fig, "fig_engagement", aspect=0.42)
