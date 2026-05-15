# §4/§5 Redesign — DV-centric 2×2 analysis (design spec)

**Date:** 2026-05-15
**Supersedes:** the §4 (survey forest) and §5 (per-item Cliff's δ / 20-vs-20) parts of
`docs/superpowers/specs/2026-05-15-human-pilot-data-report-design.md`. All other
sections (§1, §2, §3 core, §6, §7, §8) are unchanged.

## Motivation

The researcher rejected the item-by-item comparison paradigm (the 9-item
means±CI forest and the per-item Cliff's δ + BH-FDR strips). Each survey item is
a **dependent variable**, the design is a **2×2** (Mode × Role), and all **four
cells** must be visible per DV. The first four DVs are the priority outcomes.

## Fixed facts (verified from the snapshot)

- **4 cells, balanced n=10:** Mode `mode2 ∈ {AI-to-AI, Human-to-AI}` × Role
  `role ∈ {buyer, seller}`. `survey_long(con)` already carries `mode2`, `role`,
  `participant_id`, `key`, `value_int` (1–7), 40 non-null responses per item.
- **9 DVs in questionnaire order; first 4 = priority:**
  `PRIORITY = ["satisfaction", "would_use_again", "agent_represented", "control"]`,
  `OTHER5 = ["emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged", "outfair_share"]`.
  `V2_SURVEY_KEYS` (data.py) is the canonical order; do not hardcode a second list —
  derive `PRIORITY = V2_SURVEY_KEYS[:4]`, `OTHER5 = V2_SURVEY_KEYS[4:]`.

## Statistical approach

Strictly **exploratory** (n=10/cell). Per DV, one rank-based omnibus —
**Scheirer–Ray–Hare (SRH)** — never pairwise item-by-item.

**SRH definition (to implement in `stats_ext.py`, scipy only, deterministic):**
Given a long frame with a numeric DV and two 2-level factors A (Mode), B (Role):
1. Rank the DV across all N observations (ties → average ranks; `scipy.stats.rankdata`).
2. Balanced 2×2 sum-of-squares decomposition on the ranks:
   - `grand = mean(R)`; `SS_total = Σ (R − grand)²`
   - `SS_A = Σ_a n_a (R̄_a − grand)²`; `SS_B` analogously
   - `SS_AB = Σ_ab n_ab (R̄_ab − R̄_a − R̄_b + grand)²`
3. `MS_total = SS_total / (N − 1)`; for each term `H = SS_term / MS_total`.
4. `p = chi2.sf(H, df)` with `df = 1` for each of A, B, A×B (2-level factors).
5. Effect size per term: `eta2 = SS_term / SS_total` (proportion of rank variance).
   Return `{"A":{"H","p","eta2","df"}, "B":{...}, "AB":{...}, "N"}`.

Returned p-values are reported with an explicit "exploratory; n=10/cell; not
corrected" caveat. SRH is computed independently per DV (9 calls); there is no
cross-DV multiplicity correction and none is implied (we are not ranking/
contrasting items against each other — that is exactly the paradigm being removed).

## What is removed

- `figures.py`: `fig_survey_forest`, `fig_comparison_delta` (+ its two
  `ALL_FIGURES` lambdas `fig5_delta_mode`, `fig5_delta_role`).
- `tables.py`: `_two_group_survey`, `_delta_ci`, `survey_descriptives`; the
  per-item bodies of `comparison_mode`/`comparison_role`.
- The collapsed 20-vs-20 framing and per-item BH-FDR (`fdr_bh` may remain
  exported/unused — do not delete shared core).

## What is kept / relocated

- `fisher_2x2` stays. The **agreement-rate** Fisher (a negotiation outcome, not a
  survey item) **moves into §3** as a compact stat, plus the existing price
  Mode×Role interaction figure (`fig_interaction`) is relabelled and presented in
  §3 (Negotiation outcomes) where it conceptually belongs. §5 becomes purely the
  survey-DV factorial story.
- `core/stats.py` untouched (shared with the unrelated synthetic pipeline).

## New components

### `stats_ext.py`
- `scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict` — as defined above.

### `tables.py`
- `dv_group_descriptives(con) -> DataFrame` — one row per (DV, cell): columns
  `dv, priority(bool), mode2, role, n, M, SD, Mdn, IQR`. 9 DVs × 4 cells = 36
  rows, ordered by `V2_SURVEY_KEYS` then (mode2, role). → `tbl4_dv_descriptives.csv`.
- `srh_results(con) -> DataFrame` — one row per DV: `dv, priority,
  mode_H, mode_p, mode_eta2, role_H, role_p, role_eta2, inter_H, inter_p,
  inter_eta2, N`. 9 rows, priority first. → `tbl5_srh.csv`.
- `agreement_2x2(con) -> dict` — `{"by_mode": fisher_2x2(...), "by_role": fisher_2x2(...)}`
  for the agreement-rate outcome (feeds §3 prose). Replaces the `.attrs["fisher"]`
  carried by the retired `comparison_*`.

### `figures.py` (raincloud-style = violin + narrow box + jittered raw points; plotnine)
- `fig_dv_heatmap(con)` → `fig4_dv_heatmap` — 9 DV rows × 4 cell cols, cell = mean
  (1–7), value-annotated, diverging colormap centered at the scale midpoint 4
  (reuse `LIKERT_DIVERGING`); priority 4 rows grouped on top with a visual rule.
- `fig_dv_raincloud(con, dv)` → `fig4_dv_<dv>` for each PRIORITY dv — plotnine
  `aes('role', value, fill='role')` + `geom_violin(alpha=.3, trim=True)` +
  `geom_boxplot(width=.15, outlier_shape=" ")` + `geom_jitter(width=.08, height=0,
  size=1.6, alpha=.65)` + `facet_wrap('~mode2')` + `scale_fill_manual(ROLE_COLORS)`
  + y limits 1–7. Subtitle = SRH line `Mode p=…, Role p=…, M×R p=…  (exploratory)`.
- `fig_dv_panel5(con)` → `fig4_dv_panel5` — the OTHER5 DVs, one plotnine
  `facet_wrap('~dv', ncol=…)` small-multiple, x = `cell` (4 flat groups
  `mode2×role`), same raincloud-style geoms, `scale_fill_manual(CELL_COLORS)`.
- `fig_dv_interaction(con, dv)` → `fig5_int_<dv>` for each PRIORITY dv —
  matplotlib mean ± 95% CI lines: Mode on x, two lines by Role (`ROLE_COLORS`),
  y limits 1–7, title carries "descriptive — exploratory".

`ALL_FIGURES` updated: remove the 3 retired entries; append
`fig4_dv_heatmap`, the 4 `fig4_dv_<priority>`, `fig4_dv_panel5`, the 4
`fig5_int_<priority>` (the 4 priority builders parametrised via lambdas, mirroring
the existing `fig5_delta_*` lambda pattern). Net figures: +10 / −3.

### `report.py`
- **§3** (Negotiation outcomes): keep `fig_outcomes`, `fig_price`,
  `outcome_descriptives`; add a short paragraph with `agreement_2x2` (mode &
  role agreement rates + Fisher p/OR); move the price `fig_interaction` here with
  a clarified caption.
- **§4** (Post-experience survey — the 9 DVs across the 4 groups): heatmap opener
  → 4 priority `fig_dv_raincloud` (each with its SRH subtitle) → `fig_dv_panel5`
  → `Table 4.1` = `dv_group_descriptives`.
- **§5** (Mode × Role effects on the DVs): 4 priority `fig_dv_interaction` →
  `Table 5.1` = `srh_results` → short prose reading which DVs show a Mode / Role /
  interaction signal (priority first, exploratory wording).
- Section numbering and the heading "5. …" updated; §6/§7/§8 unchanged.

## Tests

- `test_human_pilot_stats_ext.py`: add `test_scheirer_ray_hare_*` —
  (a) constructed data where only factor A separates groups → `A["p"]` small,
  `B["p"]`/`AB["p"]` large; (b) null (all equal) → all p high, eta2≈0;
  (c) shape/keys + p∈[0,1] + eta2∈[0,1].
- `test_human_pilot_tables.py`: replace the 3 now-invalid tests
  (`test_survey_descriptives_nine_items`, `test_comparison_mode_has_fisher_attr`,
  `test_comparison_role_has_fisher_attr`) with: `dv_group_descriptives` → 36 rows,
  expected columns, priority flag correct; `srh_results` → 9 rows, 12 columns,
  all p∈[0,1]; `agreement_2x2` → dict with `by_mode`/`by_role` Fisher dicts.
- Figures: extend the existing render smoke (all new figures produce a PNG
  > 800 bytes, build works with the qual cache present/absent unchanged).
- Full suite must stay green; rebuilt `.docx` acceptance check still passes
  (no manuscript scaffolding; §8 intact; images count adjusts to the new total).

## Acceptance criteria

1. `python -m scripts.analysis.human_pilot.report` rebuilds the `.docx`, no traceback.
2. No `fig_survey_forest` / `fig_comparison_delta` / per-item δ table anywhere in
   the report; `_two_group_survey`/`_delta_ci` removed from `tables.py`.
3. §4 shows: heatmap + 4 priority rainclouds (4 cells each, all points visible) +
   5-DV panel + 36-row descriptives table.
4. §5 shows: 4 priority interaction plots + 9-row SRH table; every SRH p∈[0,1],
   eta2∈[0,1]; captions/prose say "exploratory; n=10/cell".
5. §3 carries the agreement-rate Fisher (by mode, by role) + the price
   interaction figure.
6. Report stays offline/deterministic (no `anthropic` in the build chain);
   palette unchanged (Okabe-Ito / locked cell colours); full pytest green.
7. SRH is implemented in `stats_ext.py` with unit tests; `core/stats.py` untouched.

## Out of scope

No new dependency. No change to §1/§2/§6/§7/§8, the snapshot, the qual pipeline,
or the engine. No pairwise post-hoc tests. No cross-DV multiplicity correction.
