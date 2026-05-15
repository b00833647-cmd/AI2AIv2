# Design — Clean experimental design: analysis spec 4a (shared condition-reader)

**Date:** 2026-05-15
**Topic:** Sub-part 4a of Spec 4 (analysis-pipeline realignment): a shared, contract-defined condition-reader implementing the NULL-means-legacy dual path, with a behavior-preserving refactor of the existing pilot pipeline onto it.
**Position:** Spec 4 of the platform-revision program, decomposed into **4a (this — shared reader)** and **4b (pre-registered confirmatory analysis, follow-on cycle)**. Gated by methodology (`7614c72`), schema (`4503057`), platform-code (`fda0194`) specs and their implementation (merged to `main`, HEAD `27a1924`).
**Status:** approved (Approach A; canonical-in-core + clean-room copy; sequenced 4a→4b) — user pre-authorized autonomous execution; proceeding.

## Context

`scripts/analysis/` has two report generators that each derive experimental conditions independently:
- `human_pilot/data.py` — `_MODE2` string-maps `experiment_mode` (`agent`→"AI-to-AI", `human_buyer`/`human_seller`→"Human-to-AI"), reads `role`, and reads opponent personality from `participant_responses(screen='engine', key='opponent_personality')`. Completer = `completion_code IS NOT NULL`. Imports `core/`.
- `process_report/db.py` — its own `completers()` + `mode2 · role` cell labels; **deliberately clean-room: zero imports from `core/` or `human_pilot/`** (a reproducibility invariant from the negotiation-process-report spec).

Specs 2/3 (now implemented on `main`) added first-class `condition_mode`/`condition_role`/`opponent_block`, `assignment_*`, `manipulation_check_pass`, `excl_*` to `study_participants`, plus `assignment_log`. The frozen pilot DB `data/ai2ai-human-pilot-2026-05-15.db` predates this — every pilot row has NULL `condition_*` (legacy). First-class fields are only ever populated by the future main study. The schema spec's NULL-means-legacy contract: `condition_mode IS NULL` ⇒ legacy (use `experiment_mode` inference); non-NULL ⇒ main (use first-class fields).

## Goal

Provide one documented condition-resolution contract with a dual NULL-means-legacy path, retire `human_pilot`'s inline `experiment_mode` string-inference and `participant_responses` opponent lookup by refactoring it onto the canonical reader, and give `process_report` a behavior-identical clean-room copy — all with the frozen pilot reports provably byte-unchanged.

## Design (Approach A)

### 1. Modules & placement
- **Canonical:** new `scripts/analysis/core/conditions.py`. Used by `human_pilot/` and (later) the 4b confirmatory module.
- **Clean-room copy:** new `scripts/analysis/process_report/conditions.py` — self-contained, no import of `core`/`human_pilot`; same documented contract. The two copies are kept in lockstep by a shared contract (this spec) + parallel test suites asserting identical behavior on identical fixtures.

### 2. Contract / API
`resolve_conditions(con) -> pandas.DataFrame`, one row per completer (completer definition unchanged: `completion_code IS NOT NULL AND != ''`). Columns:
- `participant_id`
- `condition_mode` ∈ {`delegated`,`direct`} — canonical (clean-schema vocabulary)
- `condition_role` ∈ {`buyer`,`seller`}
- `opponent_block` ∈ {`easygoing`,`moderate`,`tough`}
- `condition_source` ∈ {`legacy`,`main`}
- `mode2` ∈ {`AI-to-AI`,`Human-to-AI`} — convenience label kept so existing `human_pilot` code/tests don't churn; mapping: `delegated`→`AI-to-AI`, `direct`→`Human-to-AI` (exact inverse of the legacy `_MODE2`, so legacy & main unify under one vocabulary)
- main-only provenance/flags, NULL/NA for legacy rows: `assignment_seed`, `assignment_block_index`, `replicate_id`, `manipulation_check_pass`, `excl_attention`, `excl_manipulation`, `excl_speeding`, `excl_comprehension`, `excl_noncompletion`

### 3. Dual path (NULL-means-legacy)
Per completer row:
- **`condition_mode IS NULL` → legacy branch:** reproduce the existing `human_pilot/data.py` derivation **exactly** — `experiment_mode` `agent`⇒`delegated`/`AI-to-AI`, `human_buyer`/`human_seller`⇒`direct`/`Human-to-AI`; `condition_role` from `role`; `opponent_block` from the `participant_responses(screen='engine', key='opponent_personality')` lookup; `condition_source='legacy'`; main-only columns NA.
- **`condition_mode IS NOT NULL` → main branch:** read first-class `condition_mode`/`condition_role`/`opponent_block` + the provenance/flag columns directly; `condition_source='main'`.

### 4. Behavior-preserving refactor of `human_pilot`
`human_pilot/data.py` stops inlining `_MODE2` + the opponent lookup and calls `core.conditions.resolve_conditions`; downstream frames (`completers_frame`, etc.) consume its columns. The full existing `human_pilot` test suite (pins frozen-pilot facts: 40 completers, 10/cell balance, outcomes 27/9/3/1, agreed-price band, `mode2` collapse, survey coverage) must stay green **unchanged**. Characterization tests are written **first** to snapshot current condition-derived outputs on the frozen pilot, proving the refactor is byte-identical on legacy data.

### 5. `process_report` clean-room copy
`process_report/conditions.py` independently implements the same contract; `process_report/db.py`'s `completers()`/cell-labeling refactors onto it. process_report's existing tests stay green. No import of `core`/`human_pilot` (clean-room invariant preserved). Parallel tests assert the copy behaves identically to the canonical reader on the same synthetic fixtures.

### 6. Exclusion-policy boundary
4a only **surfaces** raw fields (`excl_*`, `manipulation_check_pass`, `completion_code`). It does **not** decide analyzability or apply pre-registered exclusion rules — that is 4b's responsibility (exclusion criteria are a methodology decision, not a data-read concern).

### 7. Testing
- **Characterization first:** snapshot `human_pilot` and `process_report` condition-derived outputs on the frozen pilot DB; lock them before refactor.
- **Unit (synthetic in-memory SQLite, both legacy- and main-shaped rows):** legacy branch reproduces `_MODE2` exactly; main branch reads first-class fields; `condition_source` discriminator; `mode2` mapping; main-only columns NA on legacy; completer filter unchanged.
- **Parallel-copy test:** canonical vs `process_report` copy produce identical DataFrames on identical fixtures.
- Existing `human_pilot` + `process_report` suites remain green unchanged.

## Non-goals
- No statistical-test changes, no pre-registered primary/secondary/exploratory analysis, no new confirmatory report — all **4b**.
- Does not apply exclusions or compute analyzability — **4b**.
- Does not modify the frozen pilot DB or change any existing report's DOCX/figure/table output (must be identical for the pilot).
- Does not relax `process_report` clean-room (copy, not import).

## Acceptance criteria
- `core/conditions.py` + `process_report/conditions.py` exist, implement the §2 contract with the §3 dual path; the two are behavior-identical on shared fixtures (parallel test passes).
- `human_pilot` no longer inlines `experiment_mode` string-inference / the opponent lookup; it consumes the canonical reader; **its entire existing test suite passes unchanged**, and characterization tests prove pilot condition-derived outputs are byte-identical pre/post refactor.
- `process_report` consumes its clean-room copy; its existing suite passes unchanged; still zero imports from `core`/`human_pilot`.
- Legacy rows → `condition_source='legacy'`, exact `_MODE2` behavior, main-only cols NA. Main-shaped rows → `condition_source='main'`, first-class fields.
- No frozen-pilot DB writes; no DOCX/figure/table output changes for the pilot.
- Python analysis test commands (the `scripts/analysis/**` pytest suites) pass.

## Open items deferred to 4b
- Pre-registered primary (satisfaction) test, secondary family + Holm/BH correction, exploratory labeling, opponent-as-controlled-block modeling.
- Exclusion-rule application / analyzable-sample definition for the main study.
- Any new confirmatory report generator/output.
