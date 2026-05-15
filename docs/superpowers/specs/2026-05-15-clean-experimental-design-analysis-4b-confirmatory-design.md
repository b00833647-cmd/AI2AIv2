# Design — Clean experimental design: analysis spec 4b (pre-registered confirmatory analysis)

**Date:** 2026-05-15 (program artifact date; authored in the 2026-05-15 clean-experimental-design program)
**Topic:** Sub-part 4b of Spec 4: the pre-registered confirmatory analysis for the main study, built on the 4a shared condition-reader. Written and frozen **before** main-study data exists (correct pre-registration practice).
**Position:** Final sub-spec of the 4-spec platform-revision program. Gated by methodology (`7614c72`), schema (`4503057`), platform-code (`fda0194`), and 4a shared reader (merged to `main`, HEAD `6938a35`).
**Status:** approved — user pre-authorized autonomous execution on recommended options; substantive methodology already fixed by spec 1. Proceeding.

## Context

Spec 1 (methodology) locked the confirmatory design: 2×2 **Mode** {delegated=AI-to-AI, direct=Human-to-AI} × **Role** {buyer, seller}; opponent personality {easygoing, moderate, tough} as a **controlled blocking covariate**; primary confirmatory DV **`satisfaction`**, primary test a **two-sided Mann–Whitney** on the Mode contrast (collapsing Role/opponent) with the **2×2 Scheirer–Ray–Hare** omnibus (Mode/Role/Mode×Role) reported secondary; secondary family = the other 8 survey DVs + negotiation outcomes with multiplicity correction; exploratory = labeled/uncorrected; pre-registered exclusions applied; power-target N≈288 (24/stratum) — the **main study**, not the pilot.

4a delivered the canonical `scripts/analysis/core/conditions.py` `resolve_conditions(con)` (dual NULL-means-legacy path; surfaces `condition_mode/role`, `opponent_block`, `condition_source`, `mode2`, and `excl_*`/`manipulation_check_pass` as NA-for-legacy). 4a explicitly **deferred the exclusion-policy/analyzable-sample decision to 4b**.

`scripts/analysis/core/stats.py` provides `mann_whitney` (two-sided), `kruskal_wallis`, `cliff_delta`, `bootstrap_ci`, `fdr_bh` (Benjamini–Hochberg), `cohens_d`, `effect_size_band`, `cronbach_alpha`, `welch_t`, `anova_one_way` — all dict-returning. It has **no `scheirer_ray_hare` and no `fisher_2x2`** (those exist only as duplicated copies in `human_pilot/stats_ext.py` and `process_report/stats.py`).

**Data reality:** the only available DB is the frozen legacy pilot (40 completers, NULL `condition_*`/`excl_*`, random opponent). It does **not** satisfy the clean 2×2 design. 4b is pre-registered analysis code written ahead of main-study collection; it is verifiable now on synthetic main-shaped fixtures + a pilot **dry-run** that must be guard-stamped as not-a-confirmatory-result.

## Goal

A frozen, deterministic, offline pre-registered confirmatory-analysis package that consumes the 4a canonical reader, applies the pre-registered exclusion policy, runs the spec-1 primary/secondary/exploratory tests with opponent as a controlled covariate, emits a DOCX report + CSV result tables, and hard-guards against presenting non-clean (legacy/unbalanced) data as a confirmatory result.

## Design

### 1. Canonical stats addition (scoped sub-part)
Add to `scripts/analysis/core/stats.py` (genuine gap; the methodology mandates these and the only copies are non-canonical duplicates):
- `scheirer_ray_hare(df, dv, a, b) -> dict` — rank-based 2×2 omnibus returning per-term H, p (χ², df=1), η², N. Behavior must match the existing `process_report/stats.py`/`human_pilot/stats_ext.py` implementations (pin with a parity test against one of them on a shared fixture).
- `fisher_2x2(success_a, n_a, success_b, n_b) -> dict` — odds ratio + p (for binary DVs e.g. agreement rate).
The `human_pilot`/`process_report` copies are left as-is (out of 4b scope; their clean-room/pinned-test status is unchanged). 4b uses the **canonical** core versions.

### 2. New `scripts/analysis/confirmatory/` package
Parallel to `human_pilot`/`process_report`; **may import `scripts.analysis.core`** (it is not clean-room). Modules:
- `sample.py` — `analyzable(con) -> DataFrame`: start from `core.conditions.resolve_conditions(con)`, join the survey/outcome data, apply the **pre-registered exclusion policy** (§3), return the analyzable sample + an audit of who/why excluded + a `clean: bool` design flag (§5).
- `tests.py` — the pre-registered test battery (§4) over the analyzable sample, using `core.stats` (`mann_whitney`, `scheirer_ray_hare`, `fdr_bh`, `cliff_delta`, `bootstrap_ci`, `fisher_2x2`, `kruskal_wallis`).
- `report.py` — orchestration → `docs/reports/2026-05-15-confirmatory-report.docx` + CSV tables under `docs/reports/tables-confirmatory/`; runnable `python -m scripts.analysis.confirmatory.report`. Reuses a small python-docx helper (mirror `process_report/docx_build.py` style; confirmatory is allowed to import core but a thin local docx helper keeps it self-describing).

### 3. Pre-registered exclusion policy (the 4a-deferred boundary)
Analyzable sample = completers, minus any participant with: `excl_attention`, `excl_manipulation`, `excl_speeding`, `excl_comprehension`, or `excl_noncompletion` set (== 1), or `manipulation_check_pass == 0`. (Replacement/over-recruitment is a data-collection concern, out of analysis scope.) **Legacy rows** (`condition_source=='legacy'`, NULL `excl_*`/`manipulation_check_pass`): the structured exclusions cannot be applied (not collected); only completion applies, and such rows force the design `clean=False` flag (§5). `sample.analyzable` returns the filtered frame plus an exclusions audit table (n excluded per reason).

### 4. Pre-registered test battery
- **Primary (single, no correction):** `satisfaction` ~ Mode (delegated vs direct, collapsing Role+opponent): two-sided `core.mann_whitney` + Cliff's δ with `core.bootstrap_ci` 95% CI. Designated primary endpoint.
- **Primary structural omnibus (secondary report):** `core.scheirer_ray_hare(sample, 'satisfaction', 'condition_mode', 'condition_role')` → Mode/Role/Mode×Role H,p,η².
- **Secondary family (multiplicity-corrected):** the other 8 survey DVs (`would_use_again, agent_represented, control, emot_pleasant, emot_anxious, effort_invested, engage_engaged, outfair_share`) Mode contrasts (MW + Cliff's δ) AND negotiation outcomes (final price MW; agreement rate via `fisher_2x2`); the family's p-values corrected together with `core.fdr_bh` (Benjamini–Hochberg; Holm is the noted pre-registration alternative). `agent_represented` flagged not-comparable-in-direct → reported delegated-only with an explicit caveat (per spec 1).
- **Opponent as controlled covariate:** opponent_block reported as a balancing/blocking factor — descriptive cell breakdown + a KW across opponent within Mode as a sensitivity check; opponent is NOT a factor of interest.
- **Exploratory:** any other measure, explicitly labeled "exploratory, uncorrected".
- All tests run only on the analyzable sample; every table notes n, the test, and (for the family) the correction.

### 5. Hard dry-run guard (methodological integrity)
`sample.analyzable` computes `clean: bool` = (every analyzable row `condition_source=='main'`) AND (the 12 Mode×Role×opponent strata are all present and balanced within tolerance) AND (pre-registered exclusion fields are non-NULL). `report.py` MUST:
- If `clean` is True → normal confirmatory report.
- If `clean` is False (e.g. the legacy pilot, or partial/unbalanced data) → run the pipeline structurally but stamp every page/table header and the filename/first heading with **"DRY RUN — NOT A CONFIRMATORY RESULT (non-clean/legacy data)"**, and emit the reason. It must be impossible to produce an unstamped confirmatory report from non-clean data. A test asserts the guard fires on the frozen pilot and is absent on a synthetic clean fixture.

### 6. Testing
- `core.scheirer_ray_hare`/`fisher_2x2`: unit tests + a parity test vs the existing `process_report/stats.py` copy on a shared fixture (canonical must match the vetted copy).
- `sample.analyzable`: synthetic in-memory SQLite — clean main-shaped data (exclusions applied correctly, audit counts, `clean=True`); legacy-shaped data (`clean=False`, only completion applied); mixed.
- `tests.py`: synthetic clean fixture with a known injected Mode effect → primary MW detects it, SRH terms sane, secondary BH-corrected, exploratory labeled.
- `report.py`: pilot dry-run test — runs end-to-end on the frozen pilot, asserts the DRY-RUN stamp present and no unstamped confirmatory artifact; synthetic-clean test asserts a normal (unstamped) report is produced. Deterministic/offline (no LLM, no network).
- Full `python -m pytest scripts/analysis -q` stays green (existing 54 + new); pre-existing human_pilot/process_report suites unchanged.

## Non-goals
- Does not collect or simulate main-study data; does not fabricate a "result". The pilot is only a structural dry-run, guard-stamped.
- Does not modify `human_pilot`/`process_report` (incl. their SRH/Fisher copies) or the frozen pilot DB.
- Does not change 4a's reader contract (consumes it as-is).
- No power/recruitment tooling (spec 1; operational), no replacement logic (data-collection concern).
- Not clean-room: `confirmatory/` deliberately depends on `core/` (DRY); only `process_report` is clean-room.

## Acceptance criteria
- `core/stats.py` gains `scheirer_ray_hare` + `fisher_2x2`, dict-returning, with unit tests and a parity test matching the existing vetted `process_report/stats.py` copy on a shared fixture.
- `scripts/analysis/confirmatory/` exists (`sample.py`, `tests.py`, `report.py`), importing `core.conditions` + `core.stats`; runnable `python -m scripts.analysis.confirmatory.report`.
- Pre-registered exclusion policy applied exactly per §3 with an exclusions audit; legacy rows handled gracefully and force `clean=False`.
- Primary = two-sided MW on Mode for `satisfaction` + Cliff's δ/bootstrap CI; SRH 2×2 secondary; secondary family BH-corrected together; exploratory labeled; opponent as covariate (sensitivity only). `agent_represented` delegated-only caveat present.
- The dry-run guard makes it impossible to emit an unstamped confirmatory report from non-clean/legacy data; tests prove it fires on the frozen pilot and is absent on a synthetic clean fixture.
- `python -m pytest scripts/analysis -q` all green; existing suites unchanged; the report build is deterministic/offline; no docs/reports churn committed by task commits (only intended source/test files).

## Open items (for pre-registration / when main data exists)
- Final Holm-vs-BH choice and exact balance tolerance in the `clean` check — locked at pre-registration filing; spec defaults BH + exact-equality strata presence.
- Exact DOCX prose/tables polish — finalized when real main-study data is available; structure fixed here.
