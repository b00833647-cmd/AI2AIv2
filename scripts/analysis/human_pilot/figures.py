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
