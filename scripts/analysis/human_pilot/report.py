"""Build the human-pilot data report .docx end-to-end from the snapshot.

Run: python -m scripts.analysis.human_pilot.report
"""
from __future__ import annotations

from pathlib import Path

from scripts.analysis.human_pilot.data import load_db, SNAPSHOT, V2_SURVEY_KEYS
from scripts.analysis.human_pilot import tables as T
from scripts.analysis.human_pilot import figures as F
from scripts.analysis.human_pilot.docx_report import (
    new_doc, h1, h2, para, figure, table,
)
from scripts.analysis.human_pilot.tables import (
    theme_prevalence, taxonomy_by_role, comment_sentiment,
    linguistic_by_role, qual_quant_link, qual_cache_available,
)
from scripts.analysis.human_pilot.qual_codebook import MODEL as QMODEL, CODER_RUN_DATE as QDATE

OUT = Path("docs/reports/2026-05-15-human-pilot-data-report.docx")
TBL_DIR = Path("docs/reports/tables-human-pilot")


def _csv(df, name):
    TBL_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(TBL_DIR / f"{name}.csv", index=False)


def build():
    con = load_db(SNAPSHOT)
    doc = new_doc()

    h1(doc, "AI2AI Human Pilot — Data Report")
    para(doc, "First real-human Prolific pilot. Analytical sample = the 40 "
              "participants who received the final completion code. "
              "Exploratory / descriptive throughout — small N; no "
              "confirmatory claims. Snapshot 2026-05-15.", italic=True)

    h1(doc, "1. Sample & flow")
    figure(doc, F.fig_funnel(con),
           "Figure 1.1 — Sample flow.",
           "Of 59 enrolled, 40 received the completion code (the analytical "
           "sample); 27 of those reached an agreement. Non-completers are "
           "not analysed beyond this count.")
    t = T.sample_composition(con); _csv(t, "tbl1_1_sample")
    table(doc, t, "Table 1.1 — Sample composition (mode × role × personality).",
          "The design is balanced at 10 participants per mode×role cell; "
          "opponent personality is roughly even (easygoing 15 / moderate 13 "
          "/ tough 12).")

    h1(doc, "2. Demographics")
    figure(doc, F.fig_demographics(con),
           "Figure 2.1 — Gender, experience, AI-familiarity by mode.",
           "Demographic make-up is broadly similar across AI-to-AI and "
           "Human-to-AI arms, supporting comparability of the two groups.")
    figure(doc, F.fig_age(con),
           "Figure 2.2 — Age distribution by mode.",
           "Age spans 19–73 (mean ≈ 41). No gross age skew between arms.")
    t = T.demographics_summary(con); _csv(t, "tbl2_1_demographics")
    table(doc, t, "Table 2.1 — Who participated (n, % per level).",
          "Descriptive composition of the 40 completers.")

    h1(doc, "3. Negotiation outcomes (descriptive)")
    figure(doc, F.fig_outcomes(con),
           "Figure 3.1 — Outcome type by mode×role.",
           "Most negotiations reached agreement (27/40); rejections and "
           "impasses are spread across cells. Descriptive only — N too "
           "small per cell for inference here.")
    figure(doc, F.fig_price(con),
           "Figure 3.2 — Final agreed price by mode×role (n=27).",
           "Agreed prices cluster in the $22–24k band; cell medians differ "
           "modestly. Treated as descriptive (no test at n≈7/cell).")
    t = T.outcome_descriptives(con); _csv(t, "tbl3_1_outcomes")
    table(doc, t, "Table 3.1 — Outcome descriptives by cell.",
          "Agreement rate, price/turns/time medians per mode×role. No "
          "p-values in this section by design.")
    ag = T.agreement_2x2(con)
    bm, br = ag["by_mode"], ag["by_role"]
    para(doc, f"Agreement rate — by mode: AI-to-AI {bm['rate_a']:.0%} vs "
              f"Human-to-AI {bm['rate_b']:.0%} (Fisher's exact p={bm['p']:.3f}, "
              f"OR={bm['odds_ratio']:.2f}); by role: buyer {br['rate_a']:.0%} "
              f"vs seller {br['rate_b']:.0%} (p={br['p']:.3f}, "
              f"OR={br['odds_ratio']:.2f}). Exploratory; 20 per side.")
    figure(doc, F.fig_interaction(con),
           "Figure 3.3 — Mode × Role on median agreed price (descriptive).",
           "Interaction pattern on the negotiation outcome; not tested "
           "(n≈7 agreed per cell).")

    h1(doc, "4. Post-experience survey — the 9 DVs across the 4 groups")
    para(doc, "Each survey item is a dependent variable. The 2×2 design "
              "(Mode × Role) yields four cells of n=10. Figures show every "
              "data point; statistics are exploratory (Scheirer–Ray–Hare "
              "per DV, no multiplicity correction, no pairwise post-hoc).",
         italic=True)
    figure(doc, F.fig_dv_heatmap(con),
           "Figure 4.1 — Mean (1–7) per DV × group; priority DVs above the rule.",
           "All nine DV means across the four cells at a glance; diverging "
           "scale centered at the 1–7 midpoint.")
    for i, dv in enumerate(V2_SURVEY_KEYS[:4]):
        figure(doc, F.fig_dv_raincloud(con, dv),
               f"Figure 4.{i + 2} — {dv}: distribution by Mode × Role.",
               "Violin + box + all 10 raw points per cell; SRH in the "
               "subtitle. Exploratory.")
    figure(doc, F.fig_dv_panel5(con),
           "Figure 4.6 — Secondary DVs (5) across the four groups.",
           "Same raincloud-style; flat 4-group view.")
    t = T.dv_group_descriptives(con); _csv(t, "tbl4_dv_descriptives")
    table(doc, t,
          "Table 4.1 — Descriptives per DV × group (n, M, SD, Mdn, IQR).",
          "All nine DVs × four cells; priority DVs first.")

    h1(doc, "5. Mode × Role effects on the DVs (exploratory)")
    para(doc, "Per-DV nonparametric two-way (Scheirer–Ray–Hare): rank-based "
              "Mode, Role and Mode×Role tests. Strictly exploratory — "
              "n=10/cell, p uncorrected, no pairwise post-hoc.", italic=True)
    for i, dv in enumerate(V2_SURVEY_KEYS[:4]):
        figure(doc, F.fig_dv_interaction(con, dv),
               f"Figure 5.{i + 1} — {dv}: Mode × Role (mean ± 95% CI).",
               "Lines = Role; x = Mode. Descriptive; exploratory.")
    t = T.srh_results(con); _csv(t, "tbl5_srh")
    table(doc, t, "Table 5.1 — Scheirer–Ray–Hare per DV (H, p, η²).",
          "Mode / Role / Mode×Role rank-based omnibus per DV. p uncorrected, "
          "exploratory; η² = share of rank variance. Priority DVs first.")

    h1(doc, "6. Data quality & operational")
    t = T.data_quality(con); _csv(t, "tbl6_quality")
    table(doc, t, "Table 6.1 — Data-quality & operational metrics.",
          "Clipboard/right-click attempts were blocked + logged; behaviour "
          "prompts captured for agent-mode completers.")
    figure(doc, F.fig_prompt_len(con),
           "Figure 6.1 — Behaviour-prompt length (agent modes).",
           "Distribution of authored agent-instruction lengths.")

    h1(doc, "7. What you can do with this data")
    t = T.variable_inventory(con); _csv(t, "tbl7_inventory")
    table(doc, t, "Table 7.1 — Analysable variables: now vs. when N grows.",
          "At current N the report supports descriptives + the two 20-vs-20 "
          "exploratory contrasts. Powered cell-level and 3-way analyses "
          "require a larger sample.")

    # ── Section 8 — Qualitative ──
    h1(doc, "8. Qualitative analysis")
    if qual_cache_available():
        para(doc, f"LLM-assisted coding disclosure: themes, taxonomy and "
                  f"comment sentiment were coded once on {QDATE} with "
                  f"{QMODEL} against the fixed codebook. n=20 behaviour "
                  f"prompts / 20 comments. Codes are illustrative and "
                  f"hypothesis-generating, NOT theoretically saturated; no "
                  f"inter-rater reliability. The full coding sheet "
                  f"(qual_coding_sheet.csv) is committed for spot-checking.",
             italic=True)
    else:
        para(doc, "Qualitative LLM coding has not been run yet — sections "
                  "8A/8B/8C/8E show placeholders. Run "
                  "`python -m scripts.analysis.human_pilot.code_qualitative` "
                  "with ANTHROPIC_API_KEY set, then rebuild. Section 8D "
                  "(linguistic) is deterministic and shown below regardless.",
             italic=True)

    h2(doc, "8A — Strategy themes (behaviour prompts, inductive)")
    figure(doc, F.fig_theme_prevalence(con),
           "Figure 8A.1 — Theme prevalence across 20 agent-mode prompts.",
           "How often each negotiation-strategy theme appears in "
           "participants' instructions to their delegated agent. "
           "Illustrative; n=20.")
    if qual_cache_available():
        tp = theme_prevalence(con); _csv(tp, "tbl8a_themes")
        table(doc, tp, "Table 8A.1 — Theme prevalence (count, %).",
              "Most-instructed strategies first.")

    h2(doc, "8B — Strategy taxonomy (deductive)")
    if qual_cache_available():
        tx = taxonomy_by_role(con); _csv(tx, "tbl8b_taxonomy")
        table(doc, tx, "Table 8B.1 — Taxonomy frequencies by role.",
              "Distributive vs integrative orientation, anchor strength, "
              "threshold/politeness/info-strategy — buyer vs seller counts. "
              "Descriptive; no test (n=20).")
    else:
        para(doc, "(8B table pending qualitative coding.)", italic=True)

    h2(doc, "8C — Study-comment sentiment")
    figure(doc, F.fig_comment_sentiment(con),
           "Figure 8C.1 — Comment valence × topic (n=20, all non-blank).",
           "Tone and focus of the open-ended study comments.")

    h2(doc, "8D — Human-turn language (deterministic)")
    figure(doc, F.fig_linguistic(con),
           "Figure 8D.1 — Linguistic features, buyer vs seller (human modes).",
           "Politeness, hedging, questions, concession and directness per "
           "typed turn. Lexicon-based, fully reproducible, no LLM.")
    tl = linguistic_by_role(con); _csv(tl, "tbl8d_linguistic")
    table(doc, tl, "Table 8D.1 — Linguistic feature means by role.",
          "Per-turn means for human-mode participants.")

    h2(doc, "8E — Qualitative × quantitative link")
    if qual_cache_available():
        ql = qual_quant_link(con); _csv(ql, "tbl8e_link")
        table(doc, ql, "Table 8E.1 — Outcomes by strategy / sentiment.",
              "Agreed-price median by prompt orientation; satisfaction "
              "median by comment sentiment. Descriptive, illustrative, "
              "hypothesis-generating only — n is small.")
    else:
        para(doc, "(8E link pending qualitative coding.)", italic=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
