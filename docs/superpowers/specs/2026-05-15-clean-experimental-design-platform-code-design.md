# Design — Clean experimental design: platform code / assignment (spec 3 of 4)

**Date:** 2026-05-15
**Topic:** A seeded, server-side balanced-assignment module and the `/api/p/start` wiring that replaces URL-driven, request-time-random condition assignment.
**Position:** Spec 3 of 4. Gated by the methodology keystone (`2026-05-15-clean-experimental-design-methodology-design.md`, commit `7614c72`) and the schema spec (`2026-05-15-clean-experimental-design-schema-design.md`, commit `4503057`).
**Status:** design approved (Approach A; permuted-block; debug-override-excluded); pending spec review.

## Context

Verified current behaviour:

- `src/server/server.ts`: routes `/blx`, `/slx`, `/bhx`, `/shx` are recognised (≈ L66–69) and `/` 302-redirects to `/blx` (≈ L87); researchers distribute the per-cell URLs directly — i.e. assignment is URL-driven and self-selected, not randomised. `/api/p/start` handler ≈ L117. `experiment_mode` is set from the client via `/api/p/mode` (`updateStudyParticipant(participantId, { experiment_mode })` ≈ L1281) and read with default `'agent'` (≈ L1407). `pickOpponentPersonality()` is called at request time in two places (≈ L801 and ≈ L1444) and the result is passed to `buildPack({ …, opponentPersonality })`. Prolific completion codes are keyed by `experiment_mode + role` (≈ L1653–1680).
- `src/multi-agent/pack-builder.ts`: `OpponentPersonality` (L75); `pickOpponentPersonality(rng = Math.random)` (L84, RNG already injectable); `buildPack(args: PackBuildArgs)` where `PackBuildArgs = { answers: IntakeAnswers, opponentPersonality }` (L110–111, L237–238) — so the opponent is already an explicit `buildPack` parameter; the only change needed is *where the value comes from*.
- Spec 2 provides the persistence accessors: `recordAssignment`, `recordAssignmentEvent`, `setManipulationCheck`, `setExclusionFlags`, `getAssignment`, `getAssignmentLog`, `countAssignedByCell`, and the `assignment_log` append-only table.
- Engine invariant (multi-agent-core #1): no domain knowledge in `src/multi-agent/`.

Locked decisions: **permuted-block** randomisation over the 12 strata, deterministic and reconstructible from seed + position, replacement re-inserts the voided stratum; **debug-override-excluded** route semantics (forced cell, `test_data=1`, not counted, excluded from the main sample); research participants enter via one neutral URL that triggers seeded assignment.

## Goal

Make condition assignment server-side, balanced, seeded, reproducible, and auditable, with the assignment policy isolated from both the engine and the storage layer, changing no analysis/admin behaviour beyond what the dual-write already preserves.

## Design (Approach A)

### 1. New isolated module `src/server/assignment.ts`
Lives outside `src/multi-agent/` to preserve engine domain-neutrality. Depends only on the spec-2 persistence accessors and config. Pre-existing observation: `pack-builder.ts` is domain-specific yet sits in `src/multi-agent/`; this is **flagged, not refactored** (out of scope).

### 2. Pure generator (no I/O, deterministic)
`nextAssignment(seed: string, position: number) → { conditionMode, conditionRole, opponentBlock, assignmentBlockIndex, replicateId }`.
The 12 strata = 2 Mode (`delegated`|`direct`) × 2 Role (`buyer`|`seller`) × 3 Opponent (`easygoing`|`moderate`|`tough`). A deterministic permuted-block sequence is generated from `seed`; one block = a permutation of all 12 strata (block size = the 12-stratum set; a configurable integer multiple is allowed). `assignmentBlockIndex` = floor(position / blockLen); `replicateId` = occurrence count of that stratum so far. Same `(seed, position)` ⇒ identical output. Pure and unit-testable.

### 3. Transactional claim
`claimAssignment(participantId) → ResolvedCondition` runs one synchronous `BEGIN IMMEDIATE` transaction:
1. `position` = net non-`test_data` `assigned` rows in `assignment_log` (`assigned` − `voided` − `replaced`), via a `countAssignedByCell`-style reader.
2. `nextAssignment(seed, position)`.
3. `recordAssignment(...)` (writes `condition_*` columns, dual-writes `experiment_mode`/`role`, appends the `assigned` `assignment_log` row).
4. COMMIT.
better-sqlite3 is synchronous and the server is a single process, so the transaction is atomic against concurrent `/api/p/start` calls — no double-allocation, no skipped positions. Replacement: an exclusion/non-completion appends a `voided`/`replaced` row (spec-2 accessor), which lowers `position` so the next claimant re-fills exactly that stratum at the next block.

### 4. Seed source & reproducibility
`AI2AI_ASSIGNMENT_SEED` (config/env; documented in `.env.example`). The resolved seed is written to `assignment_seed` on every `assignment_log` row (per spec 2), so the full sequence is reconstructible from the log alone. The server **fails fast at boot if the seed is unset** (unconditionally — there is no boot-time notion of "research mode", and per-request gating cannot prevent an unseeded study), mirroring the existing API-key boot validation. Local/debug use simply sets any fixed seed.

### 5. `/api/p/start` wiring
- **Neutral research entry** (a single distributable URL; the `/` redirect target changes from `/blx` to this neutral path) → `claimAssignment`; persist; the SPA receives its resolved condition from the server.
- **Debug routes** `/blx|/slx|/bhx|/shx` → forced condition, `test_data=1`, an `assignment_log` row written for audit but **excluded from the position count** and from the main sample. They never consume a permuted-block slot.

### 6. Opponent seam
Replace both request-time `pickOpponentPersonality()` calls (server.ts ≈ L801, ≈ L1444) with the persisted assigned `opponent_block`, passed to `buildPack({ …, opponentPersonality })` (already its parameter). `pickOpponentPersonality()` is not called in the research path; it remains available for debug routes/tests.

### 7. `/api/p/mode` demotion
Mode is server-assigned, so `/api/p/mode` is restricted to debug/`test_data` flows; the research SPA no longer POSTs mode. `experiment_mode`/`role` remain populated through the spec-2 dual-write, so the admin dashboard and the Prolific-code lookup keyed on `experiment_mode + role` keep working unchanged.

### 8. Testing (no-API-key smoke suite)
Deterministic unit tests: identical `(seed, position)` ⇒ identical sequence; exact balance of all 12 strata at every block boundary; replacement re-inserts the correct stratum; a concurrent-claim simulation yields no duplicate or missing positions; the debug-override path sets `test_data=1` and leaves the research sequence unperturbed; boot fails fast when the seed is unset in research mode.

## Non-goals
- Analysis pipeline read-path / dual-path — **spec 4**.
- Admin dashboard changes — **spec 4** (dual-write keeps it functional now).
- Schema DDL/migrations/accessor implementations — **spec 2** (done; this spec consumes the accessors).
- Methodology/power — **spec 1**.
- Relocating `pack-builder.ts` out of `src/multi-agent/` — pre-existing, deliberately out of scope.
- Manipulation-check UI/item wording — surfaced with spec 4 / pre-registration; this spec only ensures the assignment/condition plumbing.

## Acceptance criteria
- A pure `nextAssignment` exists with no I/O; same `(seed, position)` is reproducible; all 12 strata are exactly balanced at every block boundary.
- `claimAssignment` is atomic under concurrent `/api/p/start` (no double-allocation, no gaps) and persists via spec-2 accessors only.
- Research entry is a single neutral URL that triggers seeded assignment; `/blx|/slx|/bhx|/shx` force a cell, set `test_data=1`, are excluded from the count and sample, and do not perturb the sequence.
- The two `pickOpponentPersonality()` request-time calls are replaced by the persisted `opponent_block`; the research path never random-draws the opponent.
- `experiment_mode`/`role` remain correct via dual-write; admin and Prolific-code lookup are unchanged in behaviour.
- Server fails fast at boot (unconditionally) when `AI2AI_ASSIGNMENT_SEED` is unset.
- No file in `src/multi-agent/` gains domain logic; `src/server/assignment.ts` is the only new source file; `src/server/server.ts` is modified only for entry/opponent/mode wiring; no analysis or admin code is changed.
- Smoke-suite tests above pass with no API key.

## Open items deferred
- Exact neutral entry path string (e.g. `/study` vs `/s`) — finalised in the implementation plan; trivial, no design impact.
- Whether debug routes also allow forcing a specific `opponent_block` (vs Mode/Role only) — decided in the plan against QA needs.
- Block-size multiple (1× vs k×12) — default 1×; configurable; final value set at pre-registration.
