# Plan — One coherent document: all 45 analysis groups × 4 experiments

> **For agentic workers:** This is a PLAN ONLY. Do not implement until the
> user explicitly directs the build. Fresh, self-contained code (no reuse
> of human_pilot / process_report / confirmatory / apa_report / core).

**Goal:** A single, coherent, publication-grade APA-7 Word document that
executes every one of the 45 analysis groups, presenting each (where the
data permit) at four analytical levels across the four experiments, with a
modern analysis stack and one unified visual design system.

## 1. Interpretation & explicit assumptions (correct me if wrong)

**"The 4 experiments" = the four design cells (Mode × Role), n = 10 each:**

| ID | Experiment | Mode | Role | Who acts | n |
|----|------------|------|------|----------|---|
| **X1** | Delegated · Buyer | delegated (agent) | buyer | participant briefs an AI buyer; AI–AI | 10 |
| **X2** | Delegated · Seller | delegated (agent) | seller | participant briefs an AI seller; AI–AI | 10 |
| **X3** | Direct · Buyer | direct (human) | buyer | participant types as buyer vs AI | 10 |
| **X4** | Direct · Seller | direct (human) | seller | participant types as seller vs AI | 10 |

**"distinct, one by one, 2 by 2, and overall comparisons and review"** is
operationalised as a fixed four-level treatment applied to every analysis
family that the data support:

- **L1 — Distinct (one-by-one):** each of X1, X2, X3, X4 profiled alone.
- **L2 — 2×2 + pairwise:** the factorial decomposition (Mode main, Role
  main, Mode×Role interaction) **and** the structured pairwise contrasts —
  X1↔X3, X2↔X4 (Mode within Role), X1↔X2, X3↔X4 (Role within Mode), plus
  exploratory diagonals X1↔X4, X2↔X3.
- **L3 — Overall:** pooled N = 40, plus Mode-collapsed and Role-collapsed
  views.
- **L4 — Review:** a per-family synthesis paragraph, then a global
  integrative cross-experiment review.

Format assumption (unchanged from the earlier approved choice): **one
APA-7 Microsoft Word (.docx)** manuscript. It will be large (est.
120–200 pp.); a navigable structure, running headers, ToC, and
list-of-tables/figures keep it coherent.

## 2. Coverage matrix (45 groups × 4 levels)

Every group is tagged with which levels apply; honest gaps are explicit:

- **Full quad (L1–L4):** groups 2,3,4,5,6,7,14,15,16,22,23,24,25,26,
  32,33,34,35,38,39,43,44,45 (outcomes, experience, process, system,
  instrumentation, dialogue, fairness, affect, sequence, NLP, DQ).
- **L2/L3/L4 only (no meaningful per-cell at n=10, or pooled by design):**
  19 (typologies), 37 (psychometrics/IRT/DIF), 40 (survival), 41
  (Bayesian/exact), 42 (multiverse/design analysis).
- **Mode-restricted (only 2 of 4 cells):** 8 (direct-only: X3,X4),
  9 & 21 (delegated-only: X1,X2) — reported one-by-one for their two
  cells + a Role contrast; cross-Mode comparison flagged not-defined.
- **Cohort/whole-sample only:** 1 (flow), 27 (dropout — non-completers,
  outside the 4 cells), 28 (collection-wave), 30 (Prolific integrity),
  31 (engine reliability), 36 (standardisation audit).
- **Validity caveat carried everywhere:** opponent personality is a
  randomised, unbalanced covariate → no clean 3-way; "experiment" is used
  loosely (4 conditions of one small pilot, n = 10/cell); all inference
  exploratory, never confirmatory; `outcomes`/`scores` empty; no
  attention check.

## 3. Document architecture (one coherent manuscript)

- **Front matter:** APA-7 title page (author Faraz Ghodratizadeh; ESSEC;
  Author Note crediting supervisor Amir Sepehri + exploratory disclosure);
  Abstract + keywords; Table of Contents; List of Tables; List of Figures.
- **Part I — Foundations.** Data provenance & the frozen snapshot; the
  four-experiment framework (this matrix); methodology & the modern stack;
  reproducibility statement; the honesty/limitations charter.
- **Part II — The Four Experiments, one by one (L1).** A *standardised
  dossier template* applied identically to X1, X2, X3, X4: cell sample &
  demographics; outcomes & economics; the nine measures; process &
  strategy; orchestrator/system; instrumentation & engagement;
  mode-specific behaviour; qualitative snapshot. Same tables/figures in
  the same order per experiment → directly comparable.
- **Part III — Factorial & pairwise analysis (L2).** Organised by the ten
  thematic chapters (below); each runs Mode/Role/Mode×Role + the structured
  pairwise contrasts with modern effect sizes and CIs.
- **Part IV — Overall & integrative (L3).** Pooled descriptives;
  cross-family integrative models; typologies; psychometrics; survival;
  Bayesian & exact re-estimation; multiverse/design analysis.
- **Part V — Cross-experiment review & synthesis (L4).** Comparative
  narrative across X1–X4; what differs and why (cautious); robustness &
  data-quality impact; limitations; the powered-confirmatory roadmap.
- **Appendices:** A full data dictionary & DB profile; B complete result
  tables; C verbatim open-text; D per-participant exported frames (CSV/
  Parquet) for re-analysis; E methods & exact package versions; F figure
  catalogue.

**Ten thematic chapters** (the 45 groups bin into these, each carrying its
L1–L4 treatment): (1) Sample, Flow & Validity [1,2,17,30,31,36]; (2)
Outcomes & Economic Efficiency [3]; (3) Subjective Experience [4]; (4)
Negotiation Process & Strategy [5,22,23,38,39]; (5) System & Orchestrator
[6,16,34,35]; (6) Instrumentation & Engagement [7,32,33,44]; (7)
Mode-Specific Behaviour [8,9,21]; (8) Qualitative [10,43]; (9)
Integrative Modelling & Typologies [11,19,26,25]; (10) Temporal, Cost,
Robustness & Design [14,15,28,40,41,42,45,12,13,18,20,24,27,29,37].

## 4. Modern analysis stack

- **Data:** polars + pyarrow (fast, modern) with a pandas bridge where a
  library needs it; parquet caching of every derived frame.
- **Statistics:** scipy 1.13+, statsmodels, **pingouin** (tidy tests +
  effect sizes), **scikit-posthocs** (Dunn/Games–Howell), `scipy.stats.
  bootstrap` (modern BCa CIs), permutation via `scipy.stats.
  permutation_test`.
- **Bayesian / small-N:** **bambi + PyMC + ArviZ** (formula Bayesian
  estimation, posteriors, Bayes factors); pingouin Bayesian t-test;
  **TOST** equivalence (statsmodels/pingouin).
- **Multivariate / ML:** scikit-learn (PCA, clustering), **UMAP**
  (umap-learn), factor_analyzer (EFA), `pymer4`/statsmodels for mixed
  views; specification-curve via a small custom multiverse runner.
- **Survival:** lifelines (Kaplan–Meier, log-rank).
- **NLP (deterministic core; model-based optional & disclosed):**
  spaCy 3.x, textstat (readability), scikit-learn TF-IDF; optional
  sentence-transformers + BERTopic and a local sentiment model — only if
  you approve non-deterministic/heavier deps (default OFF, offline).
- **Tables:** **great_tables** for publication-grade typeset tables
  (rendered to high-res PNG and embedded so the .docx is one coherent
  artifact) with APA fallback via python-docx native tables.
- **Figures:** matplotlib + seaborn objects API (or plotnine) driven by a
  single shared theme; 300 dpi; colourblind-safe.
- **Document:** python-docx assembled by one orchestrator from a shared
  component library (guarantees coherence); deterministic seeds; a single
  pinned environment (requirements-report.txt) and one entrypoint.

## 5. Coherent aesthetic / design system

A single `design.py` defines all visual tokens — nothing is styled ad hoc:

- **Experiment colour identity:** fixed palette where Mode = hue family
  (delegated = blue family, direct = warm family) and Role = shade, so
  X1–X4 have one consistent colour everywhere (legends identical doc-wide).
  Okabe–Ito colourblind-safe base; diverging map (centered at the 1–7
  midpoint) for Likert; sequential for counts.
- **Typography:** body in the manuscript serif (Times New Roman 12,
  double-spaced, APA); figures/tables in one matching sans at fixed sizes;
  consistent number formatting (no leading zero, U+2212 minus, fixed
  decimals, *p* and effect-size conventions).
- **Figure templates (one look):** distribution (raincloud), contrast/
  forest (effect size + CI), 2×2 interaction, offer-path trajectory,
  heatmap, funnel/Sankey, timeline, survival curve — all from the shared
  theme, fixed aspect ratios and margins.
- **Table style:** APA rules (top/header/bottom only), aligned decimals,
  effect-size + CI columns, significance footnote convention, every table
  tagged with its level (L1 cell / L2 factorial / L3 overall).
- **Coherence devices:** continuous Table/Figure numbering, standardised
  captions ("Figure N. <what> — X-level, <experiment(s)>"), cross-
  references, per-part dividers, running header, ToC/LoT/LoF.

## 6. Execution phases (when authorised)

- **P0 — Scaffold:** `scripts/analysis/grand_report/` package; pinned env;
  `design.py`; self-contained `db.py` (fresh condition derivation, verified
  reservation constants); parquet cache; deterministic seeds; test harness.
- **P1 — Metrics engine:** one function per analysis group emitting tidy
  frames at all applicable levels (L1/L2/L3); a generic "quad runner" that,
  given a metric + DV, produces distinct/factorial/overall outputs.
- **P2 — Stats & models:** modern tests, effect sizes/CIs, Bayesian/exact,
  survival, multiverse — all tidy-dict returning, unit-tested vs known
  cases.
- **P3 — Visual layer:** the templated figure & great_tables builders on
  the shared theme.
- **P4 — Narrative & assembly:** academic prose generator + the single
  .docx orchestrator (Parts I–V + appendices); CSV/Parquet exports.
- **P5 — Verification:** deterministic offline tests (structure, honesty
  charter present, zero prior-report imports, key empirical facts, every
  group represented at its declared levels); full `pytest scripts/analysis`
  green; one-command rebuild.

Scale realism: ~45 groups × up to 4 levels is very large; the quad-runner
keeps it DRY, but the document will be long and several late analyses
(IRT/DIF, Bayesian, multiverse, typologies) are statistically fragile at
n = 10/cell and will be reported with explicit caveats, not headline
claims.

## 7. Honesty charter (persists in every part)

Small-N legacy pilot; opponent randomised & unbalanced (covariate, not a
block); `outcomes`/`scores` empty; attention check never recorded; the
four "experiments" are four conditions of one pilot (n = 10 each) so
cell-level results are descriptive; all inference exploratory and
hypothesis-generating; nothing confirmatory; the document states what is
NOT possible as prominently as what is.

## 8. What I need from you before building (your call — no build yet)

1. Confirm "4 experiments = the 4 Mode×Role cells" (X1–X4) as above.
2. Format: keep one APA-7 .docx (large) — or split-feel but single file,
   or a different format?
3. NLP depth: deterministic-only & fully offline (default), or allow the
   optional model-based NLP (embeddings/topics/sentiment, heavier, non-
   deterministic, disclosed)?
4. Any of the 45 to drop or de-prioritise to control length, or all in?
