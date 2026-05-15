# Design — Clean experimental design: methodology keystone (spec 1 of 4)

**Date:** 2026-05-15
**Topic:** Revising the AI2AI platform for a clean experimental design. This is the **methodology keystone** — the first of four sequenced specs in the revision program. It defines the experimental design contract that gates the schema, platform-code, and analysis specs that follow.
**Status:** design approved (defaults locked *for now*, explicitly revisitable before pre-registration is filed); pending spec review.

## Context

The platform currently runs a used-car negotiation study with three structural weaknesses that prevent a clean confirmatory design:

1. **Uncontrolled opponent confound.** The opponent personality (`easygoing` / `moderate` / `tough`) is drawn uniformly at random per session (`pickOpponentPersonality()` in `src/multi-agent/pack-builder.ts`). `multi-agent-core/STATE.md` explicitly flags this as trading experimental control for ecological validity.
2. **Route-based, non-randomized assignment.** Condition is set by entry route (`/blx`, `/slx`, `/bhx`, `/shx`); there is no balanced server-side randomization.
3. **Conditions are inferred, not recorded.** `scripts/analysis/human_pilot/data.py` reverse-engineers Mode by string-mapping `experiment_mode`, and reads opponent personality from a `participant_responses` row (`screen='engine', key='opponent_personality'`). There are no first-class condition fields.

A human pilot (N = 40 completers, frozen at `data/ai2ai-human-pilot-2026-05-15.db`) was collected under the random-opponent build. The pilot remains valid as exploratory data; this program designs the **confirmatory main study**.

## Goal

Define a clean, pre-registerable experimental design and decompose the platform revision into four sequenced, independently reviewable specs, with the methodology as the binding contract.

## Program decomposition (Approach A — approved)

Four sequenced spec → plan → implementation cycles. Each is independently shippable; the methodology gates all downstream work.

1. **Methodology keystone (this spec).** The experimental-design contract: factors, assignment, power, DV hierarchy, checks, pre-registration.
2. **Schema spec.** First-class condition + check fields and migrations; retire inferred conditions.
3. **Platform-code spec.** A single seeded experiment-configuration/assignment module at `/api/p/start`, isolated from the domain-neutral engine; route prefixes demoted to a pilot/debug override.
4. **Analysis spec.** Pipeline reads the clean schema and runs the pre-registered primary + corrected secondary tests; string-inference of conditions removed.

Only spec 1 is brainstormed here. Specs 2–4 are scoped (see "Requirements flowing downstream") but designed in their own cycles.

## Methodology design

### 1. Factors & cell structure
- **Factors of interest — 2×2, between-subjects:** Mode {delegated = AI-to-AI; direct = Human-to-AI} × Role {buyer; seller}.
- **Controlled blocking factor:** Opponent personality {easygoing; moderate; tough}, balanced *within every Mode×Role cell* → **12 assignment strata**. Analyzed as a covariate/blocking factor, not a factor of interest.
- **Held constant:** the locked Camry stimulus and the predetermined, uniform reservation values (bargaining zone constant across all participants and conditions).

### 2. Assignment mechanism
- Server-side **balanced randomization at `/api/p/start`** replaces route-based assignment. Route prefixes (`/blx`, `/slx`, `/bhx`, `/shx`) are retained **only** as an explicit pilot/debug override; research mode is randomized.
- **Block randomization** across the 12 strata with a persisted **RNG seed + block index**; the full assignment sequence is deterministic and reproducible from the seed.
- **Replacement policy:** non-completers and pre-registered exclusions are replaced to preserve stratum balance; the assignment service backfills the emptied stratum rather than free-running.

### 3. Sample size & power (locked-for-now defaults)
- **Primary confirmatory test:** Mode main effect on **`satisfaction`** (delegated vs. direct, collapsing Role and opponent) — a two-group rank-based contrast (**Mann–Whitney U**, **two-sided**). The 2×2 Scheirer–Ray–Hare omnibus (Mode, Role, Mode×Role) is reported as **secondary**, consistent with the existing pipeline. Power is computed via the t-approximation with a nonparametric efficiency margin.
- **Parameters:** smallest effect of interest **d = 0.40**, **power = 0.90**, **α = .05** → ≈ 132 per Mode group.
- **Balanced N:** **n = 24 per stratum → 288 completers** (12 strata × 24). Mode groups = 144 each (≥ 132, with margin for nonparametric efficiency loss).
- **Enrollment:** pilot non-completion ≈ 32%; over-recruit to ≈ **425–445 enrolled**, with the replacement policy preserving stratum balance.
- **Stated honesty constraint:** at n = 24/stratum the **Mode×Role interaction and the Role main effect are secondary and underpowered** for small interaction effects (an interaction needs ≈ 4× the N for an equivalent standardized effect). They are pre-specified secondary, not primary.

### 4. DV hierarchy & multiplicity
- **Primary:** `satisfaction` — single pre-registered test, no multiplicity correction.
- **Secondary (pre-specified):** the other 8 survey items (`would_use_again`, `agent_represented`, `control`, `emot_pleasant`, `emot_anxious`, `effort_invested`, `engage_engaged`, `outfair_share`) plus negotiation outcomes (agreement, final price, turns, duration), with multiplicity control (Holm or Benjamini–Hochberg across the secondary family). `agent_represented` is not cleanly comparable in the direct condition and is reported as delegated-only or with an explicit caveat.
- **Exploratory:** process metrics, telemetry, qualitative — explicitly labeled, uncorrected.

### 5. Manipulation / attention / exclusions (pre-specified)
- Add a **delegation manipulation check**: whether the participant correctly perceives that they delegated to an agent vs. negotiated directly.
- Pre-registered exclusion rules: failed attention check, failed manipulation check, speeding, scenario-comprehension failure, non-completion → excluded **and replaced** to maintain balance.
- All exclusion outcomes recorded as first-class flags (flows to the schema spec).

### 6. Pre-registration & analysis lock
- The study is **pre-registered** (OSF or AsPredicted): factors, primary DV/test/direction, fixed-N stopping rule (no optional stopping), exclusion criteria, and the analysis are locked before data collection. Pre-registration is the artifact that makes the design "clean," not merely tidier. The locked-for-now power defaults (§3) and the two-sided primary test (§3) are revisitable until the pre-registration is filed; after filing they are frozen.

### 7. Requirements flowing downstream (scoped, not designed here)
- **Schema spec:** first-class fields `condition_mode`, `condition_role`, `opponent_block`, `assignment_seed`, `assignment_block_index`, `replicate_id`, `manipulation_check`, `exclusion_flags`; idempotent migrations; the legacy mapped-signals column stays untouched (already legacy).
- **Platform-code spec:** one seeded `experiment-config`/assignment module invoked at `/api/p/start`; **no domain leakage into `src/multi-agent/`** (engine stays domain-neutral per `multi-agent-core` invariant #1); route prefixes become a debug override.
- **Analysis spec:** read clean condition fields; pre-registered primary test + corrected secondary family + labeled exploratory; remove `experiment_mode` string-inference and the `participant_responses` opponent lookup.

## Non-goals
- The negotiation engine protocol, the five-tool orchestrator contract, and engine domain-neutrality are unchanged.
- The stimulus (Camry listing) and reservation values are unchanged.
- No new survey constructs except the delegation manipulation check.
- The frozen pilot dataset and its reports are not modified; this design governs the *next* study.
- Specs 2–4 are not designed in this document.

## Acceptance criteria (methodology spec)
- The design specifies factors, the 12-stratum balanced structure, a deterministic seeded assignment mechanism, a power-justified balanced N with the primary test fully defined, a primary/secondary/exploratory DV hierarchy with multiplicity handling, pre-specified manipulation/attention/exclusion rules with a replacement policy, and a pre-registration commitment.
- Every claim about current behavior is accurate against the code (`pack-builder.ts` random opponent; route-based assignment; `data.py` string-inference).
- Downstream requirements for specs 2–4 are enumerated precisely enough to start the schema spec without re-deciding methodology.
- No code or non-spec files are modified by this spec.

## Open items deferred to follow-on specs / pre-registration
- Exact manipulation-check item wording (finalized with the schema spec and the pre-registration).
- Choice between Holm and Benjamini–Hochberg for the secondary family (analysis spec; stated in pre-registration).
- Final enrollment number and Prolific configuration (operational; constrained by §3).
