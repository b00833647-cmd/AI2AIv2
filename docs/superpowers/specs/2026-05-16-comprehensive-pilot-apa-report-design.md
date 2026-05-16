# Design — Comprehensive APA-7 pilot report (built fresh from the database)

**Date:** 2026-05-16
**Author context:** Faraz Ghodratizadeh (ESSEC Business School); supervisor Amir Sepehri.
**Status:** approved — user reviewed the data-driven plan and chose: exhaustive scope (families A–H), APA-7 Word output, proceed to build. Autonomous execution.

## Mandate

Replace the prior APA report. **Do not reuse anything** from the previous
report generators (`scripts/analysis/human_pilot`, `process_report`,
`confirmatory`, `apa_report`, or `core`). The new package is fully
self-contained: its own SQLite access, condition derivation, statistics,
figures, and python-docx builder. Analyses are driven by what the database
empirically contains (profiled directly), not by any prior code's
assumptions.

## What the database actually contains (empirical profile)

10 tables; `outcomes` and `scores` are EMPTY (no utility table, no
LLM-judge scores). Real design: balanced **2×2 Mode {delegated=`agent`,
direct=`human`} × Role {buyer, seller}, N=40, exactly 10/cell**; 59
enrolled, 19 non-completers (funnel only). Nobody excluded; `test_data`
all 0; `attention_check_pass` entirely NULL (not captured). Opponent
personality {easygoing 15, moderate 13, tough 12} was **randomized, not
balanced** within cells → covariate/confound, not a controlled block; no
clean 3-way.

Populated, analyzable sources: `study_participants` (demographics,
device, prolific, timing), `sessions` (outcome_type, terms, tokens,
duration, degraded — 40 completer sessions), `participant_responses`
(9 Likert DVs 1–7 all 40; free_text 20; personal_context 20; per-screen
response times), `participant_events` (6,601: dwell, idle, scroll, listing
inspection, tab-away, integrity attempts, human-turn composition,
quick-actions, likert changes), `turns` (532: tool calls
submit_proposal/send_message, latency, message text), `orchestrator_decisions`
(582: request_turn/declare_outcome/broadcast/pause, rationale, tokens),
`behavior_prompts` (21: raw prompt text only — `match_rating`,
`mapped_signals_json` are NULL), `participants` (engine briefs confirming
fixed reservation values for derived surplus).

## Analyzable inventory (exhaustive — families A–H)

- **A. Sample & flow:** 59→40 funnel; non-completer count; consent;
  2×2 balance; demographics (age, gender, experience, AI familiarity,
  OS/browser, timezone) overall and by Mode/Role with comparability tests.
- **B. Outcomes & economic efficiency:** outcome_type distribution;
  agreement rate by Mode/Role/opponent; settlement price (27 agreed);
  **derived buyer/seller surplus, joint surplus, ZOPA efficiency,
  distributive split** from fixed reservation constants; turns; duration;
  token cost; degraded sessions.
- **C. Subjective experience (9 Likert):** distributions; reliability/
  inter-correlation matrix; per-item Mode, Role, Mode×Role exploratory
  contrasts with effect sizes + bootstrap CIs; opponent sensitivity.
- **D. Negotiation process:** opening anchors, anchor distance,
  concession count/magnitude/trajectory, first-mover, proposal:message
  ratio, rounds, turn latency, orchestrator alternation/interventions,
  degraded fallback.
- **E. Instrumentation:** per-screen dwell, idle episodes/time, scroll
  depth, listing inspection (thumbnail/zoom), tab-away, clipboard/
  right-click integrity attempts, survey answer-changes, quick-accept/walk.
- **F. Direct-mode behavior (20):** compose time, message length,
  priced-turn rate, action mix; deterministic lexical features of typed
  turns.
- **G. Delegated-mode behavior (20):** behavior-prompt length/content;
  personal-context length; lexical features.
- **H. Qualitative:** 20 free-text comments + 20 personal-context texts,
  verbatim and deterministically summarized.

## Statistical strategy

Small N=10/cell ⇒ nonparametric throughout: Mann–Whitney (Mode/Role
contrasts), Kruskal–Wallis (opponent), Fisher exact (agreement),
Scheirer–Ray–Hare (rank-based 2×2 omnibus), Cliff's δ + Romano bands,
percentile bootstrap CIs, Spearman correlations, Cronbach α (coherence
descriptor only), Benjamini–Hochberg q (illustrative). **Framed
explicitly exploratory / hypothesis-generating, never confirmatory**;
opponent personality only as covariate/sensitivity. Deterministic,
offline, reproducible from the frozen snapshot.

## Package structure (new, self-contained)

`scripts/analysis/full_report/`:
- `db.py` — read-only SQLite; completer scoping; Mode/Role/opponent
  derivation; fixed reservation constants (from engine briefs).
- `stats.py` — self-contained tests/effect sizes/CIs (scipy/numpy/pingouin).
- `metrics.py` — every derived frame for families A–H.
- `figures.py` — matplotlib figures → `docs/reports/figures-full/`.
- `apa.py` — fresh APA-7 docx primitives (title page, abstract, leveled
  headings, APA tables/figures, references, page numbers).
- `report.py` — exhaustive APA-7 manuscript →
  `docs/reports/2026-05-16-ai2ai-pilot-comprehensive-apa-report.docx`
  + CSV appendix tables under `docs/reports/tables-full/`.
- `tests/` — deterministic offline tests (structure + honesty guard +
  zero prior-report imports + key empirical facts).

## Proposed report sections

1. Executive summary & data provenance
2. Database & methodology (real 2×2, measures map, derived metrics,
   statistical strategy + limits)
3. Sample, flow & demographic balance
4. Negotiation outcomes & economic efficiency
5. Subjective experience — the nine measures
6. Negotiation process & orchestrator dynamics
7. Attention, effort & engagement instrumentation
8. Mode-specific behavior (direct typing vs delegated prompting)
9. Qualitative comments
10. Synthesis, limitations & requirements for a powered confirmatory study
11. Appendices: data dictionary, all tables, reproducibility

Rendered as one APA-7 manuscript (title page w/ supervisor author note,
abstract+keywords, Introduction/Method/Results/Discussion, References,
Appendices).

## Acceptance criteria

- New `scripts/analysis/full_report/` with **zero imports** from
  `human_pilot`/`process_report`/`confirmatory`/`apa_report`/`core`.
- One APA-7 `.docx` at the path above; exhaustive coverage of A–H with
  figures + tables + derived economic metrics + qualitative.
- Honest framing throughout: legacy small-N pilot, randomized opponent,
  exploratory not confirmatory, empty `outcomes`/`scores` disclosed,
  attention-check-not-captured disclosed.
- Deterministic/offline; new tests pass; full `pytest scripts/analysis`
  stays green; prior suites unaffected.

## Non-goals

- No reuse of prior report modules. No new data collection/simulation.
- No claim of confirmatory results. No modification of the frozen DB or
  existing report packages.
