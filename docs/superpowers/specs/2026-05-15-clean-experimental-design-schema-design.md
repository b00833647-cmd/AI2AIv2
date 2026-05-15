# Design — Clean experimental design: schema spec (spec 2 of 4)

**Date:** 2026-05-15
**Topic:** SQLite schema changes that make the experimental conditions, assignment provenance, and pre-registered checks first-class. Implements the "Schema spec" requirements scoped by the methodology keystone.
**Position:** Spec 2 of 4 in the platform-revision program. Gated by the methodology keystone (`docs/superpowers/specs/2026-05-15-clean-experimental-design-methodology-design.md`, commit `7614c72`).
**Status:** design approved (Approach A; hybrid placement; NULL-means-legacy); pending spec review.

## Context

Persistence is `src/multi-agent/persistence.ts`. Current relevant state:

- **`study_participants`** (CREATE TABLE) columns: `id` PK, `external_id`, `created_at`, `finished_at`, `role`, `consent`, `age`, `gender`, `experience`, `ai_familiarity`, `attention_check_pass`, `session_id`, `completion_code`, `excluded` (INTEGER NOT NULL DEFAULT 0), `excluded_reason` (TEXT), `user_agent`. Added via the `MIGRATIONS` list: browser/device metadata, `test_data` (INTEGER NOT NULL DEFAULT 0), `experiment_mode` (TEXT NOT NULL DEFAULT 'agent'; values `agent` | `human_buyer` | `human_seller`), `prolific_pid` / `prolific_study_id` / `prolific_session_id`.
- **`behavior_prompts`**: `mapped_signals_json` is `TEXT NOT NULL` — a legacy artifact (the behavior-mapper was removed 2026-05-06); left exactly as-is.
- **`participant_responses`**: PK `(participant_id, screen, key)`. Opponent personality is currently written as `screen='engine', key='opponent_personality'`.
- **Migration mechanism:** `const MIGRATIONS: string[]` of `ALTER TABLE … ADD COLUMN …` statements; the constructor runs `db.exec(SCHEMA)` then each migration wrapped in `try { } catch {}` (idempotent — SQLite throws if the column exists).
- **Overloading:** `experiment_mode` conflates Mode and Role (`agent` = delegated; `human_buyer`/`human_seller` = direct + role). `scripts/analysis/human_pilot/data.py` reverse-engineers Mode by string-mapping `experiment_mode` and reads opponent personality from the `participant_responses` lookup.

Locked decisions from brainstorming: **hybrid placement** (1:1 condition/check/exclusion columns on `study_participants`; a new append-only `assignment_log`); **NULL-means-legacy** back-compat (the frozen pilot DB `data/ai2ai-human-pilot-2026-05-15.db` is never written to); **Approach A** (additive idempotent migration + typed accessor contract; writer wiring and analysis changes deferred to specs 3/4).

## Goal

Make experimental condition, assignment provenance, manipulation check, and structured exclusions first-class and reproducible in the schema, additively and idempotently, without modifying the frozen pilot dataset and without bleeding into spec 3/4 scope.

## Design

### 1. New `study_participants` columns
Added through the existing `MIGRATIONS` list (each its own `ALTER TABLE study_participants ADD COLUMN …`, try/catch idempotent). **All nullable, no DEFAULT** — a legacy/pilot row therefore has these as `NULL`, which is the legacy discriminator (see §4).

- `condition_mode` TEXT — `delegated` | `direct`. Source of truth for the main study.
- `condition_role` TEXT — `buyer` | `seller`.
- `opponent_block` TEXT — `easygoing` | `moderate` | `tough`.
- `assignment_seed` TEXT.
- `assignment_block_index` INTEGER.
- `replicate_id` INTEGER.
- `manipulation_check_pass` INTEGER — derived pass/fail, mirroring the existing `attention_check_pass`.
- `excl_attention`, `excl_manipulation`, `excl_speeding`, `excl_comprehension`, `excl_noncompletion` INTEGER — structured exclusion booleans.

`experiment_mode` and `role` continue to be **dual-written** for the admin dashboard and back-compat: on assignment, `role := condition_role` and `experiment_mode := 'agent'` when `condition_mode='delegated'` else `'human_' || condition_role`. `condition_*` is authoritative for the main study; `experiment_mode`/`role` are a derived mirror.

The existing `excluded` (INTEGER) / `excluded_reason` (TEXT) remain the **derived rollup** (`excluded = 1` iff any `excl_*` is set; `excluded_reason` a human-readable summary). They are reused, not duplicated.

### 2. New `assignment_log` table
Added to `SCHEMA` as `CREATE TABLE IF NOT EXISTS` (idempotent like the other tables), mirroring the append-only `participant_events` pattern:

```
assignment_log(
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id         TEXT NOT NULL,
  event_type             TEXT NOT NULL,         -- 'assigned' | 'voided' | 'replaced'
  condition_mode         TEXT,
  condition_role         TEXT,
  opponent_block         TEXT,
  assignment_seed        TEXT,
  assignment_block_index INTEGER,
  replicate_id           INTEGER,
  void_reason            TEXT,                   -- set when event_type in ('voided','replaced')
  assigned_at            TEXT NOT NULL,          -- logical assignment timestamp (ISO 8601)
  server_ts              TEXT NOT NULL,          -- when the row was written
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
)
CREATE INDEX assignment_log_by_participant ON assignment_log(participant_id);
CREATE INDEX assignment_log_by_cell ON assignment_log(condition_mode, condition_role, opponent_block);
```

Append-only: every assignment writes one `assigned` row; exclusions/replacements append `voided`/`replaced` rows (never UPDATE/DELETE). This makes the methodology spec's replacement policy fully auditable and the assignment sequence reconstructible from `assignment_seed` + ordered `assigned` rows. The `_by_cell` index supports the balance-count reader the assignment service (spec 3) will use.

### 3. Manipulation check representation
The delegation manipulation-check **raw response** is stored in `participant_responses` like every other survey item, using the existing generic `(participant_id, screen, key)` shape (the exact `screen`/`key` strings are an Open item, finalized with the pre-registration; the schema needs no change to accommodate them). The **derived pass** is `study_participants.manipulation_check_pass`, parallel to the existing `attention_check_pass`. No bespoke table.

### 4. NULL-means-legacy contract (documented invariant)
- `condition_mode IS NULL` ⇒ legacy/pilot row → analysis (spec 4) uses the existing `experiment_mode` string-inference path.
- `condition_mode IS NOT NULL` ⇒ main-study row → analysis uses the first-class `condition_*` fields.
- The frozen pilot DB is **never written to**; no discriminator column is added; `behavior_prompts.mapped_signals_json` (legacy `NOT NULL`) is left unchanged.

### 5. Migration mechanics
- New columns are appended to the `MIGRATIONS` array as individual `ALTER TABLE … ADD COLUMN …` statements with **no `NOT NULL` and no `DEFAULT`**, so applying them to an existing DB leaves prior rows `NULL` (the legacy marker). Idempotency is the existing try/catch.
- `assignment_log` (+ its indexes) is added inside the `SCHEMA` template string as `CREATE TABLE/INDEX IF NOT EXISTS`, so a fresh DB and an existing DB converge without bespoke migration code.
- Migration order is irrelevant (independent additive columns); they are listed grouped with a comment block, consistent with the existing file style.

### 6. Persistence accessor contract (signatures only)
Implementations and call sites are **spec 3**; this spec fixes the interface so spec 3 can proceed without re-deciding schema:

- `recordAssignment(participantId, { conditionMode, conditionRole, opponentBlock, assignmentSeed, assignmentBlockIndex, replicateId, assignedAt })` — writes the `study_participants` condition columns, dual-writes `experiment_mode`/`role`, and appends an `assignment_log` `assigned` row.
- `recordAssignmentEvent(participantId, 'voided' | 'replaced', voidReason)` — appends an `assignment_log` row.
- `setManipulationCheck(participantId, pass: boolean)` — sets `manipulation_check_pass`.
- `setExclusionFlags(participantId, { attention?, manipulation?, speeding?, comprehension?, noncompletion? })` — sets the `excl_*` columns and recomputes the `excluded`/`excluded_reason` rollup.
- Readers: `getAssignment(participantId)`, `getAssignmentLog(participantId)`, and `countAssignedByCell()` (grouped counts over `assignment_log` `assigned` rows minus `voided`/`replaced`, for the balance logic in spec 3).

## Non-goals
- The assignment RNG/algorithm, block-randomization logic, and the `/api/p/start` server wiring — **spec 3**.
- Analysis pipeline read-path / dual-path implementation, admin dashboard updates — **spec 4** (and spec 3 for admin).
- Replacing the ad-hoc `MIGRATIONS` array with a versioned migration framework — deliberately deferred (out of program scope).
- Any write to the frozen pilot DB; any change to `behavior_prompts.mapped_signals_json`.
- Backfilling or normalizing legacy rows.

## Acceptance criteria
- Applying the migrations to a fresh DB and to an existing DB (incl. a copy of the pilot DB) both succeed idempotently and leave pre-existing rows with `NULL` `condition_*` (legacy marker), with no error and no data mutation in the pilot copy.
- `study_participants` exposes the listed nullable condition/assignment/check/exclusion columns; `experiment_mode`/`role` still populated by the dual-write rule; `excluded`/`excluded_reason` reused as the derived rollup.
- `assignment_log` exists as an append-only table with the specified columns and indexes and `ON DELETE CASCADE`.
- The manipulation-check raw response has a defined `participant_responses` location and a derived `manipulation_check_pass` column.
- The persistence accessor signatures in §6 are defined precisely enough that spec 3 can implement assignment + wiring without revisiting schema decisions.
- No code outside `src/multi-agent/persistence.ts` is changed by the implementation of this spec; no analysis/server/admin behavior changes here.

## Open items deferred
- Exact `participant_responses` `key` (and screen) for the manipulation-check item — finalized with the pre-registration / methodology (referenced by spec 3).
- Whether `countAssignedByCell()` returns Mode×Role×Opponent (12 cells) only, or also collapsed margins — decided in spec 3 against the assignment algorithm’s needs.
- Holm vs Benjamini–Hochberg and other analysis specifics — spec 4.
