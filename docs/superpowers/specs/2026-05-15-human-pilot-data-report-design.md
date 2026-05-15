# Design Spec — Human Pilot Data Report (2026-05-15)

**Status:** Drafted 2026-05-15 · design approved via brainstorming
**Author:** Faraz (b00833647@essec.edu)
**Implementation skill (next):** `writing-plans`

---

## 1. Executive summary

A single Word `.docx` **data report** (NOT an academic manuscript) on the
first real-human Prolific pilot of the AI2AI negotiation platform. The
report is a sequence of **figure / table + short interpretation** blocks:
sample composition, demographic visualisations, descriptive negotiation
outcomes, the 9-item post-experience survey, and two headline group
comparisons (Human-to-AI vs AI-to-AI; Buyer vs Seller). Everything is
**exploratory / descriptive** — N is small, so the report reports effect
sizes with honest confidence intervals and a small set of well-powered
non-parametric tests, never confirmatory claims.

Deliverable: `docs/reports/2026-05-15-human-pilot-data-report.docx`, plus
a reproducible analytic script and a frozen DB snapshot.

---

## 2. Sample definition (locked)

**"Completed the experiment" = received the final completion code.**
The analytical sample is the **40 participants** whose `completion_code`
is non-null (all = `CL2ZWLNV`). The 19 non-completers are **not analysed**
at all (the funnel shows the 59→40 count for context only — no breakdown
of who dropped or why).

| | N |
|---|---|
| Enrolled | 59 |
| **Completed (received code) — analytical sample** | **40** |
| Did not complete (excluded from all analysis) | 19 |

Sample is balanced — **10 per mode×role cell**:

| Mode | Role | n |
|---|---|---|
| agent (AI-to-AI) | buyer | 10 |
| agent (AI-to-AI) | seller | 10 |
| human_buyer (Human-to-AI) | buyer | 10 |
| human_seller (Human-to-AI) | seller | 10 |

Opponent personality across the 40: easygoing 15 · moderate 13 · tough 12.
All 40 completers have post-survey responses.

Negotiation outcome **within** the 40 (a property analysed in-sample, not
a filter): agreed 27 · rejected 9 · impasse 3 · aborted 1. Agreed price
(n=27): $21,500–$25,500, mean $23,205, median $23,500.

---

## 3. Data snapshot

- **Source:** `/Users/faraz/Workstation/ai2ai-db-test.db` (SQLite, 129 MB)
- **Frozen copy:** `data/ai2ai-human-pilot-2026-05-15.db` (gitignored)
- **SHA-256:** `d4f721b95049a6b46d88caaa19e7a0ffe28fc0856bd3b35465267129e50f571e`
- Verified clean: zero orphan rows across all tables; zero unlinked
  sessions; `id == prolific_pid` for all 59; v2 instrument only
  (9 Likert keys + `free_text`, no v1 legacy keys).

---

## 4. Report structure

Each section = one or more **figure/table blocks**, each followed by a
**1–3 sentence interpretation**. No Abstract / Introduction / Method /
Discussion scaffolding.

### Section 1 — Sample & flow
- **Fig 1.1** Funnel: 59 enrolled → 40 completed → (within 40) 27 agreed.
- **Tbl 1.1** Sample composition: mode × role × personality grid (the
  10/10/10/10 balance + personality split).

### Section 2 — Demographics (headline; plotnine small-multiples)
- **Fig 2.1** Age: histogram + KDE, overall and faceted by mode.
- **Fig 2.2** Gender: bar, overall + by mode×role.
- **Fig 2.3** Prior negotiation experience: ordered bar by condition.
- **Fig 2.4** AI familiarity: ordered bar by condition.
- **Tbl 2.1** "Who participated": n + % per demographic level × condition.

### Section 3 — Negotiation outcomes (within the 40, descriptive only)
- **Fig 3.1** Outcome breakdown (agreed/rejected/impasse/aborted) —
  stacked bar by mode×role.
- **Fig 3.2** Final agreed price — raincloud by mode×role (n=27).
- **Fig 3.3** Turns to agreement + wall-clock session time — distributions.
- **Tbl 3.1** Outcome descriptives: agreement rate, price/turns/time
  median + IQR per cell. No p-values in this section (pure description).

### Section 4 — Post-experience survey (40 completers, 9 v2 items)
- **Fig 4.1** Item means + 95% bootstrap CI — dot/forest, by mode.
- **Fig 4.2** Likert distribution — diverging stacked bars per item.
- **Tbl 4.1** Per-item descriptives: M, SD, Mdn, IQR by condition.
- Note: report items individually; no subscale composites / Cronbach's α
  (the v2 instrument is 9 single-ish items; flagged explicitly).

### Section 5 — Two headline group comparisons (exploratory)
**5A — Human-to-AI (n=20) vs AI-to-AI (n=20)**
- **Tbl 5A.1** Agreement rate AI vs Human — 2×2, **Fisher's exact test**
  (valid at this N).
- **Fig 5A.1** Final price AI vs Human — distributions + median.
- **Fig 5A.2** Per-item survey effect: Cliff's δ + 95% bootstrap CI for
  all 9 items, **BH-FDR across the 9**. Mann-Whitney U + δ reported.
- **Tbl 5A.2** Demographic-balance check (age/gender/experience/AI-fam
  AI vs Human) — confirms the arms aren't confounded.

**5B — Buyer (n=20) vs Seller (n=20)**
- Same four blocks, role as the IV.

**5C — 4 groups side-by-side (n=10 each, descriptive)**
- **Fig 5C.1** Small-multiples of the key DVs across all 4 cells.
- 4-group Kruskal–Wallis omnibus (exploratory) per DV. No pairwise tests.

**5D — Mode × Role interaction (2×2)**
- **Fig 5D.1** Interaction plot (does the buyer-vs-seller gap differ
  between Human and AI mode?) + cell-means table. Main effects = the
  20-vs-20 tests in 5A/5B; interaction itself NOT tested (underpowered) —
  descriptive pattern only, explicitly flagged.

### Section 6 — Data quality & operational
- **Tbl 6.1** Copy/paste & device flags (`flag_copy_paste` etc.).
- **Fig/Tbl 6.2** Behaviour-prompt length (agent modes, n≈21) + 2–3
  verbatim samples.
- **Tbl 6.3** Tokens / estimated cost if present in the snapshot.
- (Completion-vs-non-completion and attention-check analyses are
  intentionally OUT — see §2.)

### Section 7 — "What you can do with this data" inventory
- One-page table: every analysable variable, current N, and what it
  supports now (descriptive) vs. when N grows (inferential ≥ ~35/cell).

### Section 8 — Qualitative analysis

Qualitative data is rich here (unlike the synthetic pilot): behaviour
prompts (n=20, agent modes, 50–735 chars), personal-context free-text
(n=20, agent modes), study free-text comments (n=20, **all non-blank**),
and human-typed negotiation turns (~100 msgs, human modes). All five
methods discussed in brainstorming are included.

**8A — Thematic analysis (inductive, Braun & Clarke style).** Behaviour
prompts + personal context coded into emergent strategy themes (seed
codebook: anchor-high, concession-plan, walk-away-threshold, relationship
tone, urgency framing, value-justification, toughness, flexibility — each
a presence flag, codebook may grow during coding).
- **Tbl 8A.1** Theme prevalence (count + % of the 20 prompts) overall and
  by role.
- **Box 8A.1** 2–3 verbatim exemplar quotes per top theme.

**8B — Negotiation-strategy taxonomy (deductive content analysis).** Each
prompt coded against an a-priori categorical scheme: orientation
(distributive / integrative / mixed), anchor (high / moderate / none),
threshold-stated (yes/no), politeness-instructed (yes/no), info-strategy
(emphasise-value / conceal / neutral).
- **Tbl 8B.1** Taxonomy frequencies by role (buyer vs seller). Descriptive
  counts only — no test (n=20).

**8C — Free-text sentiment + topic.** The 20 study comments coded for
valence (positive / neutral / negative) × topic (enjoyment / AI-competence
/ difficulty / suggestion / other).
- **Fig 8C.1** Stacked bar: valence × topic.
- **Box 8C.1** Representative comments per valence.

**8D — Linguistic analysis of human negotiation turns (deterministic,
no LLM).** Human-mode turns only. Per turn: politeness markers, hedges,
directness/imperatives, question marks, concession words, message length.
Aggregated by role (buyer vs seller).
- **Fig 8D.1** Linguistic-feature comparison, buyer vs seller (human modes).
- **Tbl 8D.1** Feature means/medians by role.

**8E — Mixed-methods integration.** Link the per-participant qualitative
codes (8A theme flags, 8B taxonomy) back to quantitative outcomes:
- **Tbl 8E.1** Agreed price (agent modes) by dominant strategy theme /
  taxonomy orientation — descriptive medians, illustrative only.
- **Tbl 8E.2** Satisfaction & would-use-again by comment sentiment.
- Explicitly flagged: n is small, this is a hypothesis-generating link,
  not a tested relationship.

**Coding mechanics + reproducibility.** 8A/8B/8C use **LLM-assisted
coding** (Anthropic Python SDK, Claude). To keep the report build
deterministic and offline:

1. A one-shot script `code_qualitative.py` reads the snapshot, sends each
   text to Claude with a structured codebook, and writes a **cached
   coding sheet** `data/qual-codes-2026-05-15.json` (gitignored — derived
   data) **plus** a human-checkable `docs/reports/tables-human-pilot/
   qual_coding_sheet.csv` (committed: every text + its assigned codes, so
   the researcher can spot-check / correct).
2. The report build reads the cache. It never calls the LLM. If the cache
   is missing, 8A/8B/8C/8E render a clear "qualitative coding not yet run
   — execute code_qualitative.py" note; **8D still renders** (no LLM).
3. A disclosure paragraph in Section 8 states: codes are LLM-assisted,
   generated once on 2026-05-15 with the named model + codebook, n=20,
   themes illustrative not theoretically saturated, no inter-rater
   reliability unless a second coder re-codes the sheet.

---

## 5. Statistical posture (locked)

| Scope | Treatment |
|---|---|
| Sections 1–4 | Descriptive only — counts, %, medians + IQR, distributions. No tests. |
| Section 5A / 5B (20 vs 20) | Exploratory: Mann-Whitney U, Cliff's δ + 95 % bootstrap CI, BH-FDR across the 9 survey items per contrast. Agreement rate via Fisher's exact (2×2 — fully valid). |
| Section 5C (4 × 10) | Descriptive + Kruskal-Wallis omnibus only. No pairwise tests. |
| Section 5D (2×2) | Descriptive interaction pattern + cell means. Interaction not tested. |
| Section 8 (qualitative) | Interpretive / illustrative. 8A–8C LLM-assisted coding (disclosed, cached, spot-checkable), 8D deterministic linguistic features, 8E descriptive qual×quant cross-tabs. No hypothesis tests; explicitly hypothesis-generating. n=20. |

Every test-bearing figure/table caption states **"exploratory; small
sample"**. No confirmatory language anywhere. No three-way analyses
(mode × role × personality cells drop to 2–4). Qualitative findings are
framed as illustrative/hypothesis-generating, never as evidence.

---

## 6. Visualisation stack (modern)

- **plotnine** (ggplot2 grammar-of-graphics) — Section 2 demographic
  small-multiples + Section 5C 4-group small-multiples.
- **seaborn 0.13 (objects API) + matplotlib** — rainclouds, forest/dot
  plots, diverging Likert bars, interaction plot. Tight Word-column
  sizing + reuse of the existing `scripts/analysis/core/stats.py`
  (cliff_delta, bootstrap_ci, fdr_bh, mann_whitney) and the loader
  pattern from the synthetic-pilot pipeline.
- Modern colorblind-safe report palette (NOT the Nature Wong set — this
  is an internal report, not a journal submission). One palette, locked,
  consistent across every figure. Condition→colour mapping fixed so the
  same colour means the same group in every figure.
- All figures exported as 300-dpi PNG (embedded in `.docx`) + SVG.
- **Qualitative coding:** Anthropic Python SDK (`anthropic` package) in
  the one-shot `code_qualitative.py` only. The report build itself has
  **no LLM dependency** — it reads the cached coding sheet. Linguistic
  features (8D) use deterministic lexicons/regex, no SDK.

---

## 7. Deliverables

| File | What |
|---|---|
| `docs/reports/2026-05-15-human-pilot-data-report.docx` | The report |
| `docs/reports/figures-human-pilot/*.png` / `.svg` | Every figure |
| `docs/reports/tables-human-pilot/*.csv` | Every table |
| `docs/reports/tables-human-pilot/qual_coding_sheet.csv` | Committed, human-checkable: every coded text + its codes |
| `scripts/analysis/human_pilot/` | Analytic package (loader, tables, figures, qual coder, docx assembler) |
| `scripts/analysis/human_pilot/code_qualitative.py` | One-shot LLM coder → cached coding sheet |
| `data/ai2ai-human-pilot-2026-05-15.db` | Frozen snapshot (gitignored, sha in §3) |
| `data/qual-codes-2026-05-15.json` | Cached LLM coding output (gitignored, derived) |

Two commands:
- `python -m scripts.analysis.human_pilot.code_qualitative` — one-shot,
  needs `ANTHROPIC_API_KEY`; writes the cached coding sheet. Idempotent
  (skips if cache exists unless `--force`).
- `python -m scripts.analysis.human_pilot.report` — rebuilds the entire
  `.docx` deterministically + offline from the snapshot + the cached
  coding sheet.

---

## 8. Reuse from the synthetic-pilot pipeline

- `scripts/analysis/core/stats.py` — `cliff_delta`, `bootstrap_ci`,
  `fdr_bh`, `mann_whitney`, `kruskal_wallis` reused as-is.
- `scripts/analysis/render_docx.py` patterns for python-docx assembly
  (figure embed + caption + interpretation paragraph).
- New: a SQLite loader (the synthetic pipeline loaded a JSON export;
  this one reads the `.db` directly) + plotnine added to requirements.

---

## 9. Acceptance criteria

1. Report opens cleanly in Word with every figure embedded + each
   followed by an interpretation paragraph.
2. Analytical sample is exactly the 40 completers everywhere; the 19
   non-completers appear only in the funnel count.
3. Every test-bearing block carries an "exploratory; small sample" note.
4. `python -m scripts.analysis.human_pilot.report` regenerates the
   whole `.docx` from the snapshot deterministically (fixed seeds for
   bootstrap).
5. Sections 5A/5B FDR-corrected across the 9 items; agreement-rate via
   Fisher's exact.
6. No manuscript scaffolding (no Abstract/Intro/Method/Discussion).
7. Section 7 inventory present and accurate.
8. Section 8 present with 8A–8E. 8D renders deterministically with no
   LLM. 8A/8B/8C/8E render from the cached coding sheet, or — if the
   cache is absent — show the explicit "coding not yet run" note (build
   never crashes on a missing cache).
9. `qual_coding_sheet.csv` is committed (every coded text + its codes,
   spot-checkable). The LLM-coding disclosure paragraph is present in
   Section 8.
10. The report build has zero LLM/network dependency; only
    `code_qualitative.py` calls the Anthropic SDK.

---

## 10. Self-review pass

- **Placeholders:** none. Every section + figure/table enumerated. Two
  graceful conditionals: tokens/cost in §4 S6 (omit if absent — column
  verified present), and the qual cache in §4 S8 (explicit note if
  absent; 8D unaffected).
- **Internal consistency:** sample = 40 everywhere; outcome counts
  (27/9/3/1) consistent §2 ↔ §4 Section 3. Contrast Ns (20 vs 20 in
  5A/5B, 10×4 in 5C) consistent with the §2 grid. Qual n=20 (agent-mode
  prompts) / 20 (all comments) consistent with the verified data read.
- **Scope:** single `.docx`, one analytic package, one snapshot, plus a
  separate one-shot qual coder whose output is cached + committed. The
  qual coder is the only LLM/network surface; cleanly isolated so the
  report build stays deterministic. Not decomposable further.
- **Ambiguity:** "completed" pinned to completion_code non-null in §2.
  "Exploratory only" pinned in §5. Visualisation libraries pinned in §6.
  Qual reproducibility model (one-shot cache + deterministic build)
  pinned in §4 S8 + §7 + §9.
