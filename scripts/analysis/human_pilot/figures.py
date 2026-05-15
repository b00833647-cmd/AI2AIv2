"""Every report figure. Each builder returns the PNG Path."""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import plotnine as p9

from scripts.analysis.human_pilot.data import (
    completers_frame, survey_long, behavior_prompts_frame, V2_SURVEY_KEYS,
)
from scripts.analysis.human_pilot.palette import (
    MODE2_COLORS, ROLE_COLORS, CELL_COLORS, OUTCOME_COLORS,
)
from scripts.analysis.human_pilot.figbase import apply_theme, save, save_plotnine
from scripts.analysis.human_pilot.tables import comparison_mode, comparison_role


def fig_funnel(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    stages = ["Enrolled", "Completed\n(received code)", "Agreed\n(within completers)"]
    vals = [59, 40, 27]
    ax.barh(stages, vals, color=["#999999", MODE2_COLORS["AI-to-AI"], OUTCOME_COLORS["agreed"]])
    for i, v in enumerate(vals):
        ax.text(v + 1, i, str(v), va="center", fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel("Participants")
    ax.set_title("Sample flow")
    return save(fig, "fig1_funnel", aspect=0.45)


def fig_demographics(con) -> Path:
    df = completers_frame(con)
    df["cell"] = df["experiment_mode"] + "/" + df["role"]
    long = df.melt(
        id_vars=["mode2"],
        value_vars=["gender", "experience", "ai_familiarity"],
        var_name="variable", value_name="level").dropna(subset=["level"])
    g = (p9.ggplot(long, p9.aes("level", fill="mode2"))
         + p9.geom_bar(position="dodge")
         + p9.facet_wrap("~variable", scales="free_x", ncol=1)
         + p9.scale_fill_manual(values=MODE2_COLORS)
         + p9.labs(title="Demographics by mode (40 completers)",
                   x="", y="count", fill="")
         + p9.theme_minimal()
         + p9.theme(figure_size=(6, 7), axis_text_x=p9.element_text(rotation=30, ha="right")))
    return save_plotnine(g, "fig2_demographics", w=6.0, h=7.0)


def fig_age(con) -> Path:
    df = completers_frame(con)
    g = (p9.ggplot(df.dropna(subset=["age"]), p9.aes("age"))
         + p9.geom_histogram(bins=12, fill=MODE2_COLORS["AI-to-AI"], color="white")
         + p9.facet_wrap("~mode2", ncol=1)
         + p9.labs(title="Age distribution by mode", x="age", y="count")
         + p9.theme_minimal() + p9.theme(figure_size=(6, 4.5)))
    return save_plotnine(g, "fig2_age", w=6.0, h=4.5)


def fig_outcomes(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    df["cell"] = df["experiment_mode"] + "/" + df["role"]
    ct = (df.groupby(["cell", "outcome_type"]).size()
            .unstack(fill_value=0))
    fig, ax = plt.subplots()
    bottom = np.zeros(len(ct))
    for oc in ["agreed", "rejected", "impasse", "aborted"]:
        if oc not in ct.columns:
            continue
        ax.bar(ct.index, ct[oc], bottom=bottom,
               label=oc, color=OUTCOME_COLORS[oc])
        bottom += ct[oc].values
    ax.set_ylabel("participants")
    ax.set_title("Negotiation outcome by mode×role")
    ax.legend(fontsize=8)
    plt.xticks(rotation=20, ha="right")
    return save(fig, "fig3_outcomes", aspect=0.55)


def fig_price(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    a = df[df["outcome_type"] == "agreed"].copy()
    a["cell"] = a["experiment_mode"] + "/" + a["role"]
    import seaborn as sns
    fig, ax = plt.subplots()
    sns.violinplot(data=a, x="cell", y="final_price", hue="cell",
                   palette=CELL_COLORS, inner=None, legend=False, ax=ax, cut=0)
    sns.stripplot(data=a, x="cell", y="final_price", color="black",
                  size=3, alpha=0.6, ax=ax)
    ax.set_title("Final agreed price by mode×role (n=27)")
    ax.set_xlabel(""); ax.set_ylabel("USD")
    plt.xticks(rotation=20, ha="right")
    return save(fig, "fig3_price", aspect=0.6)


def fig_survey_forest(con) -> Path:
    apply_theme()
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()]
    agg = (s.groupby(["key", "mode2"])["value_int"]
             .agg(["mean", "count", "std"]).reset_index())
    agg["se"] = agg["std"] / np.sqrt(agg["count"])
    fig, ax = plt.subplots()
    items = V2_SURVEY_KEYS
    y = np.arange(len(items))
    for i, m2 in enumerate(["AI-to-AI", "Human-to-AI"]):
        sub = agg[agg["mode2"] == m2].set_index("key").reindex(items)
        off = (i - 0.5) * 0.25
        ax.errorbar(sub["mean"], y + off, xerr=1.96 * sub["se"],
                    fmt="o", color=MODE2_COLORS[m2], label=m2, capsize=2)
    ax.set_yticks(y); ax.set_yticklabels(items, fontsize=8)
    ax.set_xlim(1, 7); ax.invert_yaxis()
    ax.set_xlabel("mean (1–7) ± 95% CI")
    ax.set_title("Survey items by mode")
    ax.legend(fontsize=8)
    return save(fig, "fig4_survey_forest", aspect=0.75)


def fig_comparison_delta(con, which: str) -> Path:
    apply_theme()
    tbl = comparison_mode(con) if which == "mode" else comparison_role(con)
    tbl = tbl.sort_values("delta")
    fig, ax = plt.subplots()
    y = np.arange(len(tbl))
    colors = ["#000000" if q < 0.05 else "#999999" for q in tbl["q_bh"]]
    err_lo = np.maximum(0, tbl["delta"].values - tbl["ci_lo"].values)
    err_hi = np.maximum(0, tbl["ci_hi"].values - tbl["delta"].values)
    deltas = tbl["delta"].values
    items_list = tbl["item"].tolist()
    for i, (xi, elo, ehi, col) in enumerate(zip(deltas, err_lo, err_hi, colors)):
        ax.errorbar(xi, y[i], xerr=[[elo], [ehi]],
                    fmt="o", ecolor=col, mfc=col, mec=col, capsize=2, lw=1)
    ax.axvline(0, ls="--", color="grey", lw=0.6)
    ax.set_yticks(y); ax.set_yticklabels(tbl["item"], fontsize=8)
    ax.set_xlim(-1, 1)
    label = "AI-to-AI vs Human-to-AI" if which == "mode" else "Buyer vs Seller"
    ax.set_xlabel("Cliff's δ (95% bootstrap CI)")
    ax.set_title(f"Per-item effect — {label}\n(black = q<.05 BH-FDR; exploratory, small N)")
    return save(fig, f"fig5_delta_{which}", aspect=0.7)


def fig_interaction(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    a = df[df["outcome_type"] == "agreed"]
    piv = a.groupby(["mode2", "role"])["final_price"].median().reset_index()
    fig, ax = plt.subplots()
    for role, g in piv.groupby("role"):
        ax.plot(g["mode2"], g["final_price"], "o-",
                color=ROLE_COLORS[role], label=role)
    ax.set_ylabel("median agreed price (USD)")
    ax.set_title("Mode × Role interaction (descriptive — not tested)")
    ax.legend(fontsize=8)
    return save(fig, "fig5_interaction", aspect=0.55)


def fig_prompt_len(con) -> Path:
    apply_theme()
    bp = behavior_prompts_frame(con)
    fig, ax = plt.subplots()
    if len(bp):
        import seaborn as sns
        sns.histplot(bp["prompt_len"], bins=10, color=MODE2_COLORS["AI-to-AI"], ax=ax)
    ax.set_xlabel("behavior-prompt length (chars)")
    ax.set_title("Behaviour-prompt length (agent modes)")
    return save(fig, "fig6_prompt_len", aspect=0.5)


ALL_FIGURES = [
    ("fig1_funnel", fig_funnel),
    ("fig2_demographics", fig_demographics),
    ("fig2_age", fig_age),
    ("fig3_outcomes", fig_outcomes),
    ("fig3_price", fig_price),
    ("fig4_survey_forest", fig_survey_forest),
    ("fig5_delta_mode", lambda c: fig_comparison_delta(c, "mode")),
    ("fig5_delta_role", lambda c: fig_comparison_delta(c, "role")),
    ("fig5_interaction", fig_interaction),
    ("fig6_prompt_len", fig_prompt_len),
]


# ─── Section 8 — qualitative figures ──────────────────────────────────
from scripts.analysis.human_pilot.tables import (
    theme_prevalence as _theme_prev, comment_sentiment as _csent,
    linguistic_by_role as _ling, qual_cache_available as _qok,
)


def fig_theme_prevalence(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    if _qok():
        t = _theme_prev(con)
        ax.barh(t["theme"], t["n"], color=MODE2_COLORS["AI-to-AI"])
        ax.invert_yaxis()
        ax.set_xlabel("prompts (of 20)")
    else:
        ax.text(0.5, 0.5, "qualitative coding not yet run",
                ha="center", va="center"); ax.axis("off")
    ax.set_title("Behaviour-prompt strategy themes")
    return save(fig, "fig8a_themes", aspect=0.6)


def fig_comment_sentiment(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    if _qok():
        c = _csent(con)
        piv = c.pivot_table(index="topic", columns="valence",
                            values="n", fill_value=0)
        piv.plot(kind="barh", stacked=True, ax=ax,
                 color={"positive": OUTCOME_COLORS["agreed"],
                        "neutral": "#999999",
                        "negative": OUTCOME_COLORS["rejected"]})
        ax.set_xlabel("comments")
    else:
        ax.text(0.5, 0.5, "qualitative coding not yet run",
                ha="center", va="center"); ax.axis("off")
    ax.set_title("Study-comment sentiment × topic")
    return save(fig, "fig8c_sentiment", aspect=0.5)


def fig_linguistic(con) -> Path:
    apply_theme()
    g = _ling(con).set_index("role")
    feats = ["politeness_mean", "hedges_mean", "questions_mean",
             "concession_mean", "directness_mean"]
    fig, ax = plt.subplots()
    x = np.arange(len(feats))
    for i, role in enumerate(g.index):
        ax.bar(x + (i - 0.5) * 0.35, g.loc[role, feats].values, width=0.35,
               label=role, color=ROLE_COLORS.get(role, "#999999"))
    ax.set_xticks(x)
    ax.set_xticklabels([f.replace("_mean", "") for f in feats],
                       rotation=20, ha="right")
    ax.set_ylabel("mean per turn")
    ax.set_title("Human-turn linguistic features by role (8D, deterministic)")
    ax.legend(fontsize=8)
    return save(fig, "fig8d_linguistic", aspect=0.55)


QUAL_FIGURES = [
    ("fig8a_themes", fig_theme_prevalence),
    ("fig8c_sentiment", fig_comment_sentiment),
    ("fig8d_linguistic", fig_linguistic),
]
