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


def fig_dv_heatmap(con) -> Path:
    apply_theme()
    from matplotlib.colors import LinearSegmentedColormap
    from scripts.analysis.human_pilot.palette import LIKERT_DIVERGING
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    s["cell"] = s["mode2"] + "\n" + s["role"]
    piv = (s.pivot_table(index="key", columns="cell", values="value_int",
                         aggfunc="mean").reindex(V2_SURVEY_KEYS))
    cmap = LinearSegmentedColormap.from_list("likert", LIKERT_DIVERGING)
    fig, ax = plt.subplots()
    im = ax.imshow(piv.values, cmap=cmap, vmin=1, vmax=7, aspect="auto")
    ax.set_xticks(range(piv.shape[1]))
    ax.set_xticklabels(list(piv.columns), fontsize=8)
    ax.set_yticks(range(piv.shape[0]))
    ax.set_yticklabels(list(piv.index), fontsize=8)
    ax.axhline(3.5, color="black", lw=1.6)  # priority DVs (rows 0-3) above
    for r in range(piv.shape[0]):
        for c in range(piv.shape[1]):
            ax.text(c, r, f"{piv.values[r, c]:.1f}", ha="center",
                    va="center", fontsize=8, color="black")
    fig.colorbar(im, ax=ax, shrink=0.7, label="mean (1–7)")
    ax.set_title("DV means by group (priority DVs above the rule)")
    return save(fig, "fig4_dv_heatmap", aspect=0.7)


def fig_dv_raincloud(con, dv: str) -> Path:
    from scripts.analysis.human_pilot.tables import srh_results
    s = survey_long(con)
    d = s[(s["key"] == dv) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    row = srh_results(con).query("dv == @dv").iloc[0]
    sub = (f"SRH  Mode p={row['mode_p']:.3f} · Role p={row['role_p']:.3f} · "
           f"M×R p={row['inter_p']:.3f}  (exploratory, n=10/cell)")
    g = (p9.ggplot(d, p9.aes("role", "value_int", fill="role"))
         + p9.geom_violin(alpha=0.3, trim=True, color="none")
         + p9.geom_boxplot(width=0.15, outlier_alpha=0.0, alpha=0.7)
         + p9.geom_jitter(width=0.08, height=0.0, size=1.6, alpha=0.65)
         + p9.facet_wrap("~mode2")
         + p9.scale_fill_manual(values=ROLE_COLORS)
         + p9.coord_cartesian(ylim=(0.8, 7.2))
         + p9.labs(title=dv, subtitle=sub, x="", y="response (1–7)", fill="")
         + p9.theme_minimal()
         + p9.theme(figure_size=(6, 4.0), legend_position="none"))
    return save_plotnine(g, f"fig4_dv_{dv}", w=6.0, h=4.0)


def fig_dv_panel5(con) -> Path:
    s = survey_long(con)
    keys = V2_SURVEY_KEYS[4:]
    d = s[s["key"].isin(keys) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    d["cell"] = d["mode2"] + "·" + d["role"]
    d["key"] = pd.Categorical(d["key"], categories=keys, ordered=True)
    cmap = {
        "AI-to-AI·buyer": CELL_COLORS["agent/buyer"],
        "AI-to-AI·seller": CELL_COLORS["agent/seller"],
        "Human-to-AI·buyer": CELL_COLORS["human_buyer/buyer"],
        "Human-to-AI·seller": CELL_COLORS["human_seller/seller"],
    }
    g = (p9.ggplot(d, p9.aes("cell", "value_int", fill="cell"))
         + p9.geom_violin(alpha=0.3, trim=True, color="none")
         + p9.geom_boxplot(width=0.15, outlier_alpha=0.0, alpha=0.7)
         + p9.geom_jitter(width=0.08, height=0.0, size=1.2, alpha=0.55)
         + p9.facet_wrap("~key", ncol=2)
         + p9.scale_fill_manual(values=cmap)
         + p9.coord_cartesian(ylim=(0.8, 7.2))
         + p9.labs(title="Secondary DVs by the 4 groups", x="", y="response (1–7)")
         + p9.theme_minimal()
         + p9.theme(figure_size=(7, 7), legend_position="none",
                    axis_text_x=p9.element_text(rotation=30, ha="right")))
    return save_plotnine(g, "fig4_dv_panel5", w=7.0, h=7.0)


def fig_dv_interaction(con, dv: str) -> Path:
    apply_theme()
    s = survey_long(con)
    d = s[(s["key"] == dv) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    modes = ["AI-to-AI", "Human-to-AI"]
    x = np.arange(2)
    fig, ax = plt.subplots()
    for role in ["buyer", "seller"]:
        means, errs = [], []
        for m2 in modes:
            v = d[(d["mode2"] == m2) & (d["role"] == role)]["value_int"]
            means.append(float(v.mean()))
            errs.append(1.96 * float(v.std()) / np.sqrt(len(v))
                        if len(v) > 1 else 0.0)
        ax.errorbar(x, means, yerr=errs, fmt="o-", capsize=3,
                    color=ROLE_COLORS[role], label=role)
    ax.set_xticks(x)
    ax.set_xticklabels(modes)
    ax.set_ylim(1, 7)
    ax.set_ylabel("mean (1–7) ± 95% CI")
    ax.set_title(f"{dv} — Mode × Role (descriptive, exploratory)")
    ax.legend(fontsize=8, title="role")
    return save(fig, f"fig5_int_{dv}", aspect=0.55)


ALL_FIGURES = [
    ("fig1_funnel", fig_funnel),
    ("fig2_demographics", fig_demographics),
    ("fig2_age", fig_age),
    ("fig3_outcomes", fig_outcomes),
    ("fig3_price", fig_price),
    ("fig5_interaction", fig_interaction),
    ("fig6_prompt_len", fig_prompt_len),
    ("fig4_dv_heatmap", fig_dv_heatmap),
    *[(f"fig4_dv_{k}", (lambda c, k=k: fig_dv_raincloud(c, k)))
      for k in V2_SURVEY_KEYS[:4]],
    ("fig4_dv_panel5", fig_dv_panel5),
    *[(f"fig5_int_{k}", (lambda c, k=k: fig_dv_interaction(c, k)))
      for k in V2_SURVEY_KEYS[:4]],
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
