# Clean Experimental Design — Schema + Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace URL-driven, request-time-random condition assignment with a seeded, balanced, auditable server-side assignment, backed by first-class schema fields.

**Architecture:** Phase A adds nullable condition/assignment/check columns + an append-only `assignment_log` table + typed accessors to `src/multi-agent/persistence.ts` (idempotent migrations; legacy/pilot rows stay `NULL`). Phase B adds a new isolated `src/server/assignment.ts` (pure permuted-block generator + a persistence-wrapped atomic claim) and wires it into `/api/p/start`, replacing the two request-time `pickOpponentPersonality()` calls and demoting `/api/p/mode`. The engine (`src/multi-agent/` except the existing study-specific `persistence.ts`/`pack-builder.ts`) gains no domain logic.

**Tech Stack:** TypeScript/Node 24 (ESM, run via `tsx`), better-sqlite3 (synchronous), no test framework — the no-API smoke harness `src/cli/smoke.ts` (`check(name, ok, detail)`), `npm run typecheck` (`tsc --noEmit`).

**Specs:** `docs/superpowers/specs/2026-05-15-clean-experimental-design-methodology-design.md` (1/4), `…-schema-design.md` (2/4 → Phase A), `…-platform-code-design.md` (3/4 → Phase B).

**Conventions for every task:** tests are appended to `src/cli/smoke.ts` immediately **before** the final summary line `console.log(\`\n${pass} passed, ${fail} failed\`);` (stable anchor). The no-API test command is `npx tsx src/cli/smoke.ts`. Type check is `npm run typecheck`. Commit after each task with the shown message.

---

## Phase A — Schema (spec 2/4)

### Task A1: Add nullable condition/assignment/check columns to `study_participants`

**Files:**
- Modify: `src/multi-agent/persistence.ts` (the `const MIGRATIONS: string[]` array, ends ≈ L211)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor in `src/cli/smoke.ts`:

```ts
console.log("\n# clean-design schema: study_participants columns\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    const cols = (p as any)["db"]
      .prepare("PRAGMA table_info(study_participants)")
      .all()
      .map((r: any) => r.name as string);
    for (const c of [
      "condition_mode", "condition_role", "opponent_block",
      "assignment_seed", "assignment_block_index", "replicate_id",
      "manipulation_check_pass", "excl_attention", "excl_manipulation",
      "excl_speeding", "excl_comprehension", "excl_noncompletion",
    ]) {
      check(`study_participants.${c} exists`, cols.includes(c));
    }
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL lines `FAIL study_participants.condition_mode exists` (columns absent).

- [ ] **Step 3: Add the migrations** — in `src/multi-agent/persistence.ts`, append to the `MIGRATIONS` array (after the `prolific_session_id` line, before the closing `];`):

```ts
  // Clean experimental design (spec 2/4) — first-class condition,
  // assignment provenance, and pre-registered checks. All NULLABLE with
  // no DEFAULT: pre-existing/pilot rows stay NULL, which is the legacy
  // discriminator (NULL condition_mode ⇒ analysis uses experiment_mode).
  "ALTER TABLE study_participants ADD COLUMN condition_mode TEXT",
  "ALTER TABLE study_participants ADD COLUMN condition_role TEXT",
  "ALTER TABLE study_participants ADD COLUMN opponent_block TEXT",
  "ALTER TABLE study_participants ADD COLUMN assignment_seed TEXT",
  "ALTER TABLE study_participants ADD COLUMN assignment_block_index INTEGER",
  "ALTER TABLE study_participants ADD COLUMN replicate_id INTEGER",
  "ALTER TABLE study_participants ADD COLUMN manipulation_check_pass INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_attention INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_manipulation INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_speeding INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_comprehension INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_noncompletion INTEGER",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS for all 12 `study_participants.<col> exists` checks; final line shows `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): add nullable condition/assignment/check columns"
```

---

### Task A2: Add the append-only `assignment_log` table

**Files:**
- Modify: `src/multi-agent/persistence.ts` (the `const SCHEMA = \`…\`` template, before its closing `` ` `` ≈ L183)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design schema: assignment_log\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    const t = (p as any)["db"]
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assignment_log'")
      .get();
    check("assignment_log table exists", !!t);
    const cols = (p as any)["db"]
      .prepare("PRAGMA table_info(assignment_log)")
      .all().map((r: any) => r.name as string);
    for (const c of ["id","participant_id","event_type","condition_mode",
      "condition_role","opponent_block","assignment_seed",
      "assignment_block_index","replicate_id","void_reason",
      "assigned_at","server_ts"]) {
      check(`assignment_log.${c} exists`, cols.includes(c));
    }
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL `assignment_log table exists`.

- [ ] **Step 3: Add the table** — in `src/multi-agent/persistence.ts`, inside the `SCHEMA` template string, immediately before the closing `` `; `` that ends the template (after the `participant_events` indexes), insert:

```sql

CREATE TABLE IF NOT EXISTS assignment_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id         TEXT NOT NULL,
  event_type             TEXT NOT NULL,        -- 'assigned' | 'voided' | 'replaced'
  condition_mode         TEXT,
  condition_role         TEXT,
  opponent_block         TEXT,
  assignment_seed        TEXT,
  assignment_block_index INTEGER,
  replicate_id           INTEGER,
  void_reason            TEXT,
  assigned_at            TEXT NOT NULL,
  server_ts              TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assignment_log_by_participant ON assignment_log(participant_id);
CREATE INDEX IF NOT EXISTS assignment_log_by_cell ON assignment_log(condition_mode, condition_role, opponent_block);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `assignment_log table exists` and all 12 column checks.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): add append-only assignment_log table"
```

---

### Task A3: `recordAssignment` accessor (condition columns + dual-write + log row)

**Files:**
- Modify: `src/multi-agent/persistence.ts` (add a method on `class SqlitePersistence`, e.g. directly after `setTestData` ≈ L1282)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: recordAssignment\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.recordAssignment("P1", {
      conditionMode: "delegated", conditionRole: "buyer",
      opponentBlock: "moderate", assignmentSeed: "S",
      assignmentBlockIndex: 0, replicateId: 0,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    const sp = p.getStudyParticipant("P1")!;
    check("condition_mode written", (sp as any).condition_mode === "delegated");
    check("dual-write experiment_mode=agent", sp.experiment_mode === "agent");
    check("dual-write role=buyer", sp.role === "buyer");
    const log = (p as any)["db"]
      .prepare("SELECT * FROM assignment_log WHERE participant_id='P1'").all();
    check("one assigned row", log.length === 1 && log[0].event_type === "assigned");
    check("log carries seed", log[0].assignment_seed === "S");
    p.createStudyParticipant({ id: "P2" });
    p.recordAssignment("P2", {
      conditionMode: "direct", conditionRole: "seller",
      opponentBlock: "tough", assignmentSeed: "S",
      assignmentBlockIndex: 0, replicateId: 0,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    const sp2 = p.getStudyParticipant("P2")!;
    check("dual-write experiment_mode=human_seller", sp2.experiment_mode === "human_seller");
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.recordAssignment is not a function`.

- [ ] **Step 3: Implement the method** — add to `class SqlitePersistence` in `src/multi-agent/persistence.ts`:

```ts
  /**
   * Persist a resolved condition assignment: writes the first-class
   * condition_* columns, dual-writes legacy experiment_mode/role (for the
   * admin dashboard + Prolific-code lookup), and appends one append-only
   * 'assigned' row to assignment_log. Atomic.
   */
  recordAssignment(
    participantId: string,
    a: {
      conditionMode: "delegated" | "direct";
      conditionRole: "buyer" | "seller";
      opponentBlock: "easygoing" | "moderate" | "tough";
      assignmentSeed: string;
      assignmentBlockIndex: number;
      replicateId: number;
      assignedAt: string;
    },
  ): void {
    const experimentMode =
      a.conditionMode === "delegated" ? "agent" : `human_${a.conditionRole}`;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE study_participants
              SET condition_mode = ?, condition_role = ?, opponent_block = ?,
                  assignment_seed = ?, assignment_block_index = ?,
                  replicate_id = ?, experiment_mode = ?, role = ?
            WHERE id = ?`,
        )
        .run(
          a.conditionMode, a.conditionRole, a.opponentBlock,
          a.assignmentSeed, a.assignmentBlockIndex, a.replicateId,
          experimentMode, a.conditionRole, participantId,
        );
      this.db
        .prepare(
          `INSERT INTO assignment_log
             (participant_id, event_type, condition_mode, condition_role,
              opponent_block, assignment_seed, assignment_block_index,
              replicate_id, void_reason, assigned_at, server_ts)
           VALUES (?, 'assigned', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          participantId, a.conditionMode, a.conditionRole, a.opponentBlock,
          a.assignmentSeed, a.assignmentBlockIndex, a.replicateId,
          a.assignedAt, new Date().toISOString(),
        );
    });
    tx();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 6 `recordAssignment` checks.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): recordAssignment with dual-write + log row"
```

---

### Task A4: `recordAssignmentEvent` (voided / replaced)

**Files:**
- Modify: `src/multi-agent/persistence.ts` (after `recordAssignment`)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: recordAssignmentEvent\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.recordAssignment("P1", {
      conditionMode: "delegated", conditionRole: "buyer",
      opponentBlock: "moderate", assignmentSeed: "S",
      assignmentBlockIndex: 0, replicateId: 0,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    p.recordAssignmentEvent("P1", "voided", "attention_fail");
    const log = (p as any)["db"]
      .prepare("SELECT event_type, void_reason FROM assignment_log WHERE participant_id='P1' ORDER BY id").all();
    check("two log rows", log.length === 2);
    check("second row voided", log[1].event_type === "voided" && log[1].void_reason === "attention_fail");
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.recordAssignmentEvent is not a function`.

- [ ] **Step 3: Implement** — add to `class SqlitePersistence`:

```ts
  /** Append a 'voided' or 'replaced' assignment_log row (audit + frees the
   *  stratum so the next claimant re-fills it). Copies the participant's
   *  current condition so the log row is self-describing. */
  recordAssignmentEvent(
    participantId: string,
    eventType: "voided" | "replaced",
    voidReason: string,
  ): void {
    const sp = this.db
      .prepare(
        `SELECT condition_mode, condition_role, opponent_block,
                assignment_seed, assignment_block_index, replicate_id
           FROM study_participants WHERE id = ?`,
      )
      .get(participantId) as
      | {
          condition_mode: string | null; condition_role: string | null;
          opponent_block: string | null; assignment_seed: string | null;
          assignment_block_index: number | null; replicate_id: number | null;
        }
      | undefined;
    this.db
      .prepare(
        `INSERT INTO assignment_log
           (participant_id, event_type, condition_mode, condition_role,
            opponent_block, assignment_seed, assignment_block_index,
            replicate_id, void_reason, assigned_at, server_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        participantId, eventType, sp?.condition_mode ?? null,
        sp?.condition_role ?? null, sp?.opponent_block ?? null,
        sp?.assignment_seed ?? null, sp?.assignment_block_index ?? null,
        sp?.replicate_id ?? null, voidReason,
        new Date().toISOString(), new Date().toISOString(),
      );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `two log rows`, `second row voided`.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): recordAssignmentEvent (voided/replaced)"
```

---

### Task A5: `setManipulationCheck`

**Files:**
- Modify: `src/multi-agent/persistence.ts` (after `recordAssignmentEvent`)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: setManipulationCheck\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.setManipulationCheck("P1", true);
    check("manip pass=1",
      (p.getStudyParticipant("P1") as any).manipulation_check_pass === 1);
    p.setManipulationCheck("P1", false);
    check("manip pass=0",
      (p.getStudyParticipant("P1") as any).manipulation_check_pass === 0);
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.setManipulationCheck is not a function`.

- [ ] **Step 3: Implement** — add to `class SqlitePersistence`:

```ts
  /** Set the derived delegation manipulation-check pass flag (mirrors the
   *  existing attention_check_pass). The raw response is stored separately
   *  via the existing participant_responses path. */
  setManipulationCheck(participantId: string, pass: boolean): void {
    this.db
      .prepare(`UPDATE study_participants SET manipulation_check_pass = ? WHERE id = ?`)
      .run(pass ? 1 : 0, participantId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `manip pass=1`, `manip pass=0`.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): setManipulationCheck"
```

---

### Task A6: `setExclusionFlags` (+ derived `excluded`/`excluded_reason` rollup)

**Files:**
- Modify: `src/multi-agent/persistence.ts` (after `setManipulationCheck`)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: setExclusionFlags\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.setExclusionFlags("P1", { attention: true, speeding: true });
    const sp = p.getStudyParticipant("P1")! as any;
    check("excl_attention=1", sp.excl_attention === 1);
    check("excl_speeding=1", sp.excl_speeding === 1);
    check("excl_manipulation null/0", !sp.excl_manipulation);
    check("rollup excluded=1", sp.excluded === 1);
    check("rollup reason mentions flags",
      typeof sp.excluded_reason === "string" &&
      sp.excluded_reason.includes("attention") &&
      sp.excluded_reason.includes("speeding"));
    p.setExclusionFlags("P1", { attention: false, speeding: false });
    check("rollup clears when none set",
      (p.getStudyParticipant("P1") as any).excluded === 0);
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.setExclusionFlags is not a function`.

- [ ] **Step 3: Implement** — add to `class SqlitePersistence`:

```ts
  /** Set structured exclusion booleans and recompute the derived
   *  excluded / excluded_reason rollup (excluded=1 iff any excl_* is set). */
  setExclusionFlags(
    participantId: string,
    flags: Partial<{
      attention: boolean; manipulation: boolean; speeding: boolean;
      comprehension: boolean; noncompletion: boolean;
    }>,
  ): void {
    const map: Record<string, string> = {
      attention: "excl_attention", manipulation: "excl_manipulation",
      speeding: "excl_speeding", comprehension: "excl_comprehension",
      noncompletion: "excl_noncompletion",
    };
    const tx = this.db.transaction(() => {
      for (const [k, col] of Object.entries(map)) {
        const v = (flags as Record<string, boolean | undefined>)[k];
        if (v === undefined) continue;
        this.db
          .prepare(`UPDATE study_participants SET ${col} = ? WHERE id = ?`)
          .run(v ? 1 : 0, participantId);
      }
      const row = this.db
        .prepare(
          `SELECT excl_attention, excl_manipulation, excl_speeding,
                  excl_comprehension, excl_noncompletion
             FROM study_participants WHERE id = ?`,
        )
        .get(participantId) as Record<string, number | null> | undefined;
      const set = Object.entries(row ?? {})
        .filter(([, v]) => v === 1)
        .map(([c]) => c.replace("excl_", ""));
      this.db
        .prepare(
          `UPDATE study_participants
              SET excluded = ?, excluded_reason = ?
            WHERE id = ?`,
        )
        .run(
          set.length > 0 ? 1 : 0,
          set.length > 0 ? `auto: ${set.join(", ")}` : null,
          participantId,
        );
    });
    tx();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 6 `setExclusionFlags` checks.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): setExclusionFlags with derived rollup"
```

---

### Task A7: Readers — `getAssignment`, `getAssignmentLog`, `netResearchAssignmentPosition`

**Files:**
- Modify: `src/multi-agent/persistence.ts` (after `setExclusionFlags`)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: assignment readers\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    check("empty net position = 0", p.netResearchAssignmentPosition() === 0);
    p.createStudyParticipant({ id: "P1" });
    p.recordAssignment("P1", {
      conditionMode: "delegated", conditionRole: "buyer",
      opponentBlock: "moderate", assignmentSeed: "S",
      assignmentBlockIndex: 0, replicateId: 0,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    check("net position = 1 after one assign",
      p.netResearchAssignmentPosition() === 1);
    check("getAssignment returns it",
      p.getAssignment("P1")?.conditionMode === "delegated");
    check("getAssignmentLog has 1 row",
      p.getAssignmentLog("P1").length === 1);
    // test_data participant must NOT count toward the position
    p.createStudyParticipant({ id: "PT" });
    p.setTestData("PT", true);
    p.recordAssignment("PT", {
      conditionMode: "direct", conditionRole: "seller",
      opponentBlock: "tough", assignmentSeed: "S",
      assignmentBlockIndex: 0, replicateId: 0,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    check("test_data excluded from position",
      p.netResearchAssignmentPosition() === 1);
    p.recordAssignmentEvent("P1", "voided", "x");
    check("void decrements net position",
      p.netResearchAssignmentPosition() === 0);
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.netResearchAssignmentPosition is not a function`.

- [ ] **Step 3: Implement** — add to `class SqlitePersistence`:

```ts
  /** Net research slots consumed = (#'assigned') − (#'voided'|'replaced'),
   *  counting only non-test_data participants. This is the next
   *  permuted-block position. */
  netResearchAssignmentPosition(): number {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN al.event_type='assigned' THEN 1 ELSE 0 END) -
           SUM(CASE WHEN al.event_type IN ('voided','replaced') THEN 1 ELSE 0 END)
             AS pos
         FROM assignment_log al
         JOIN study_participants sp ON sp.id = al.participant_id
        WHERE sp.test_data = 0`,
      )
      .get() as { pos: number | null };
    return row.pos ?? 0;
  }

  getAssignment(participantId: string): {
    conditionMode: string; conditionRole: string; opponentBlock: string;
    assignmentSeed: string; assignmentBlockIndex: number; replicateId: number;
  } | null {
    const r = this.db
      .prepare(
        `SELECT condition_mode, condition_role, opponent_block,
                assignment_seed, assignment_block_index, replicate_id
           FROM study_participants WHERE id = ?`,
      )
      .get(participantId) as Record<string, unknown> | undefined;
    if (!r || r["condition_mode"] == null) return null;
    return {
      conditionMode: r["condition_mode"] as string,
      conditionRole: r["condition_role"] as string,
      opponentBlock: r["opponent_block"] as string,
      assignmentSeed: r["assignment_seed"] as string,
      assignmentBlockIndex: r["assignment_block_index"] as number,
      replicateId: r["replicate_id"] as number,
    };
  }

  getAssignmentLog(participantId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM assignment_log WHERE participant_id = ? ORDER BY id`)
      .all(participantId) as Array<Record<string, unknown>>;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 6 reader checks.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): assignment readers + net position"
```

---

### Task A8: Atomic `claimAssignment` persistence primitive

**Files:**
- Modify: `src/multi-agent/persistence.ts` (after the Task A7 readers)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor:

```ts
console.log("\n# clean-design: claimAssignment primitive\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.createStudyParticipant({ id: "P2" });
    const seen: number[] = [];
    const compute = (pos: number) => {
      seen.push(pos);
      return {
        conditionMode: "delegated" as const, conditionRole: "buyer" as const,
        opponentBlock: "moderate" as const, assignmentSeed: "S",
        assignmentBlockIndex: pos, replicateId: pos,
        assignedAt: "2026-05-15T00:00:00.000Z",
      };
    };
    p.claimAssignment("P1", compute);
    p.claimAssignment("P2", compute);
    check("positions were 0 then 1", seen[0] === 0 && seen[1] === 1);
    check("P2 stored block index 1",
      p.getAssignment("P2")?.assignmentBlockIndex === 1);
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `p.claimAssignment is not a function`.

- [ ] **Step 3: Implement** — add to `class SqlitePersistence`. This wraps read-position → compute → write in ONE transaction (better-sqlite3 is synchronous + single-process, so the transaction is atomic against concurrent `/api/p/start`):

```ts
  /** Atomically: read the next permuted-block position, call `compute(pos)`
   *  to resolve the condition, and persist it. The randomization policy is
   *  injected (kept out of the storage layer); see src/server/assignment.ts. */
  claimAssignment(
    participantId: string,
    compute: (position: number) => {
      conditionMode: "delegated" | "direct";
      conditionRole: "buyer" | "seller";
      opponentBlock: "easygoing" | "moderate" | "tough";
      assignmentSeed: string;
      assignmentBlockIndex: number;
      replicateId: number;
      assignedAt: string;
    },
  ): ReturnType<typeof compute> {
    const tx = this.db.transaction(() => {
      const pos = this.netResearchAssignmentPosition();
      const a = compute(pos);
      this.recordAssignment(participantId, a);
      return a;
    });
    return tx();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `positions were 0 then 1`, `P2 stored block index 1`.

- [ ] **Step 5: Commit**

```bash
git add src/multi-agent/persistence.ts src/cli/smoke.ts
git commit -m "feat(schema): atomic claimAssignment primitive"
```

---

## Phase B — Assignment module + wiring (spec 3/4)

### Task B1: Pure permuted-block generator `src/server/assignment.ts`

**Files:**
- Create: `src/server/assignment.ts`
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — add the import near the top of `src/cli/smoke.ts` (after the existing imports, line ≈ 19):

```ts
import { nextAssignment, STRATA } from "../server/assignment.ts";
```

Then append before the summary anchor:

```ts
console.log("\n# clean-design: nextAssignment generator\n");
{
  check("12 strata", STRATA.length === 12);
  // Determinism
  const a = nextAssignment("seedX", 5);
  const b = nextAssignment("seedX", 5);
  check("deterministic", JSON.stringify(a) === JSON.stringify(b));
  // Balance: positions 0..11 cover every stratum exactly once
  const cells = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const r = nextAssignment("seedX", i);
    cells.add(`${r.conditionMode}|${r.conditionRole}|${r.opponentBlock}`);
    check(`pos ${i} block index 0`, r.assignmentBlockIndex === 0);
  }
  check("block 0 perfectly balanced (12 unique cells)", cells.size === 12);
  // Second block also balanced, block index increments
  const cells2 = new Set<string>();
  for (let i = 12; i < 24; i++) {
    const r = nextAssignment("seedX", i);
    cells2.add(`${r.conditionMode}|${r.conditionRole}|${r.opponentBlock}`);
    check(`pos ${i} block index 1`, r.assignmentBlockIndex === 1);
  }
  check("block 1 perfectly balanced", cells2.size === 12);
  // Different seed ⇒ (very likely) different order within a block
  const order1 = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify(nextAssignment("seedX", i)));
  const order2 = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify(nextAssignment("seedY", i)));
  check("different seed reorders block",
    order1.join() !== order2.join());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — cannot find module `../server/assignment.ts`.

- [ ] **Step 3: Create `src/server/assignment.ts`:**

```ts
// Seeded, deterministic permuted-block assignment over the 12 strata
// (Mode × Role × Opponent). Pure: no I/O, no Date, no globals. Same
// (seed, position) ⇒ identical output. Every block of 12 consecutive
// positions contains each stratum exactly once (exact balance at every
// block boundary). Spec: docs/superpowers/specs/2026-05-15-clean-
// experimental-design-platform-code-design.md (3/4).

export type ConditionMode = "delegated" | "direct";
export type ConditionRole = "buyer" | "seller";
export type OpponentBlock = "easygoing" | "moderate" | "tough";

export interface Stratum {
  conditionMode: ConditionMode;
  conditionRole: ConditionRole;
  opponentBlock: OpponentBlock;
}

export interface Assignment extends Stratum {
  assignmentBlockIndex: number;
  replicateId: number;
}

const MODES: ConditionMode[] = ["delegated", "direct"];
const ROLES: ConditionRole[] = ["buyer", "seller"];
const OPPS: OpponentBlock[] = ["easygoing", "moderate", "tough"];

/** The 12 strata in a fixed canonical order. */
export const STRATA: readonly Stratum[] = MODES.flatMap((conditionMode) =>
  ROLES.flatMap((conditionRole) =>
    OPPS.map((opponentBlock) => ({ conditionMode, conditionRole, opponentBlock })),
  ),
);

// --- tiny deterministic PRNG (no deps) ---
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic permutation of [0..11] for a given seed + block index. */
function blockPermutation(seed: string, blockIndex: number): number[] {
  const seedFn = xmur3(`${seed}:${blockIndex}`);
  const rng = mulberry32(seedFn());
  const idx = STRATA.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/** Resolve the assignment for a 0-based sequence position. */
export function nextAssignment(seed: string, position: number): Assignment {
  const blockLen = STRATA.length; // 12
  const blockIndex = Math.floor(position / blockLen);
  const within = position % blockLen;
  const perm = blockPermutation(seed, blockIndex);
  const stratum = STRATA[perm[within]!]!;
  return {
    ...stratum,
    assignmentBlockIndex: blockIndex,
    replicateId: blockIndex, // each stratum appears once per block
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all generator checks (12 strata, deterministic, both blocks balanced, seed reorders).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/server/assignment.ts src/cli/smoke.ts
git commit -m "feat(assignment): pure deterministic permuted-block generator"
```

---

### Task B2: `claimAssignment` policy wrapper in `src/server/assignment.ts`

**Files:**
- Modify: `src/server/assignment.ts`
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — update the import line in `src/cli/smoke.ts` to include `claimSeededAssignment`:

```ts
import { nextAssignment, STRATA, claimSeededAssignment } from "../server/assignment.ts";
```

Append before the summary anchor:

```ts
console.log("\n# clean-design: claimSeededAssignment\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    p.createStudyParticipant({ id: "P2" });
    const a1 = claimSeededAssignment(p, "P1", "seedX");
    const a2 = claimSeededAssignment(p, "P2", "seedX");
    check("P1 = nextAssignment(seedX,0)",
      JSON.stringify({ m: a1.conditionMode, r: a1.conditionRole, o: a1.opponentBlock })
      === JSON.stringify({
        m: nextAssignment("seedX", 0).conditionMode,
        r: nextAssignment("seedX", 0).conditionRole,
        o: nextAssignment("seedX", 0).opponentBlock }));
    check("P2 consumed position 1",
      p.getAssignment("P2")?.assignmentBlockIndex ===
      nextAssignment("seedX", 1).assignmentBlockIndex);
    check("seed persisted on row",
      p.getAssignment("P1")?.assignmentSeed === "seedX");
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `claimSeededAssignment` is not exported.

- [ ] **Step 3: Implement** — append to `src/server/assignment.ts`:

```ts
import type { SqlitePersistence } from "../multi-agent/persistence.ts";

/** Atomically claim the next seeded assignment for a participant and
 *  persist it. Randomization policy lives here; the storage layer only
 *  provides the atomic read-position→write primitive. */
export function claimSeededAssignment(
  db: SqlitePersistence,
  participantId: string,
  seed: string,
): Assignment {
  return db.claimAssignment(participantId, (position) => {
    const a = nextAssignment(seed, position);
    return {
      conditionMode: a.conditionMode,
      conditionRole: a.conditionRole,
      opponentBlock: a.opponentBlock,
      assignmentSeed: seed,
      assignmentBlockIndex: a.assignmentBlockIndex,
      replicateId: a.replicateId,
      assignedAt: new Date().toISOString(),
    };
  }) as unknown as Assignment;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 3 `claimSeededAssignment` checks.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/server/assignment.ts src/cli/smoke.ts
git commit -m "feat(assignment): seeded claim policy wrapper"
```

---

### Task B3: Boot fail-fast when `AI2AI_ASSIGNMENT_SEED` is unset

**Files:**
- Modify: `src/server/assignment.ts` (add `requireAssignmentSeed`)
- Modify: `src/server/server.ts` (call it inside `validateBootEnv`, before its end ≈ L404 where `validateBootEnv();` is invoked)
- Modify: `.env.example` (document the variable)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — update the smoke import to add `requireAssignmentSeed`:

```ts
import { nextAssignment, STRATA, claimSeededAssignment, requireAssignmentSeed } from "../server/assignment.ts";
```

Append before the summary anchor:

```ts
console.log("\n# clean-design: requireAssignmentSeed\n");
{
  let threw = false;
  try { requireAssignmentSeed(undefined); } catch { threw = true; }
  check("throws when seed unset", threw);
  check("returns seed when set",
    requireAssignmentSeed("abc") === "abc");
  let threwEmpty = false;
  try { requireAssignmentSeed("   "); } catch { threwEmpty = true; }
  check("throws on blank seed", threwEmpty);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `requireAssignmentSeed` is not exported.

- [ ] **Step 3a: Implement the validator** — append to `src/server/assignment.ts`:

```ts
/** Returns the trimmed seed or throws. The server calls this at boot so a
 *  study can never run unseeded (an unseeded study is unreproducible). */
export function requireAssignmentSeed(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (s === "") {
    throw new Error(
      "AI2AI_ASSIGNMENT_SEED is unset. Set a fixed non-empty value " +
      "(any stable string) so condition assignment is reproducible.",
    );
  }
  return s;
}
```

- [ ] **Step 3b: Wire it into boot** — in `src/server/server.ts`, find the function `function validateBootEnv(): void {` (≈ L285). Add an import at the top of the file alongside the other `../server`/local imports:

```ts
import { requireAssignmentSeed } from "./assignment.ts";
```

Then inside `validateBootEnv`, immediately before its closing brace, add:

```ts
  try {
    requireAssignmentSeed(process.env["AI2AI_ASSIGNMENT_SEED"]);
  } catch (e) {
    console.error(`[boot] ${(e as Error).message}`);
    process.exit(1);
  }
```

- [ ] **Step 3c: Document** — append to `.env.example`:

```
# Reproducible condition assignment (clean experimental design). REQUIRED.
# Any fixed non-empty string; changing it changes the assignment sequence.
AI2AI_ASSIGNMENT_SEED=change-me-to-a-fixed-study-seed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `throws when seed unset`, `returns seed when set`, `throws on blank seed`.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/assignment.ts src/server/server.ts .env.example src/cli/smoke.ts
git commit -m "feat(assignment): boot fail-fast on missing AI2AI_ASSIGNMENT_SEED"
```

---

### Task B4: Wire assignment into `/api/p/start` (research vs debug route)

**Context:** `handleParticipantStart` (server.ts; the `/api/p/start` handler dispatched at ≈ L118) creates the participant row via `withDb((db) => { db.createStudyParticipant(...); db.updateStudyParticipant(...) })` ≈ L1109–1130. The SPA is loaded from `/blx|/slx|/bhx|/shx` (debug) or the neutral entry. The client must tell the server which entry it used; the request body gains an `entry` string (the `window.location.pathname` the SPA booted from). Research entry ⇒ seeded assignment; debug routes ⇒ forced cell + `test_data=1`, not counted.

**Files:**
- Modify: `src/server/server.ts` (`handleParticipantStart`, just after the `withDb((db) => { db.createStudyParticipant … })` block ≈ L1130)
- Modify: `web/study.html` (the `/api/p/start` fetch — add `entry: location.pathname`)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor (tests the pure mapping helper this task introduces):

```ts
import { resolveEntry } from "../server/assignment.ts";
console.log("\n# clean-design: resolveEntry\n");
{
  check("/blx → debug delegated buyer", JSON.stringify(resolveEntry("/blx"))
    === JSON.stringify({ kind: "debug", conditionMode: "delegated", conditionRole: "buyer" }));
  check("/shx → debug direct seller", JSON.stringify(resolveEntry("/shx"))
    === JSON.stringify({ kind: "debug", conditionMode: "direct", conditionRole: "seller" }));
  check("/ (neutral) → research", resolveEntry("/")?.kind === "research");
  check("/study → research", resolveEntry("/study")?.kind === "research");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `resolveEntry` is not exported.

- [ ] **Step 3a: Add `resolveEntry`** — append to `src/server/assignment.ts`:

```ts
export type Entry =
  | { kind: "research" }
  | { kind: "debug"; conditionMode: ConditionMode; conditionRole: ConditionRole };

const DEBUG_ROUTES: Record<string, { conditionMode: ConditionMode; conditionRole: ConditionRole }> = {
  "/blx": { conditionMode: "delegated", conditionRole: "buyer" },
  "/slx": { conditionMode: "delegated", conditionRole: "seller" },
  "/bhx": { conditionMode: "direct", conditionRole: "buyer" },
  "/shx": { conditionMode: "direct", conditionRole: "seller" },
};

/** Map the SPA entry path to research (seeded) vs debug (forced) assignment. */
export function resolveEntry(pathname: string): Entry {
  const d = DEBUG_ROUTES[pathname];
  return d ? { kind: "debug", ...d } : { kind: "research" };
}
```

- [ ] **Step 3b: Wire into the handler** — in `src/server/server.ts`, locate the end of the `withDb((db) => { db.createStudyParticipant({ id, userAgent: ua }); db.updateStudyParticipant(id, { … }); })` block in `handleParticipantStart` (≈ L1109–1130). Immediately after that block, add:

```ts
  const entry = resolveEntry(typeof body.entry === "string" ? body.entry : "/");
  const seed = requireAssignmentSeed(process.env["AI2AI_ASSIGNMENT_SEED"]);
  withDb((db) => {
    if (entry.kind === "debug") {
      db.setTestData(id, true);
      db.recordAssignment(id, {
        conditionMode: entry.conditionMode,
        conditionRole: entry.conditionRole,
        opponentBlock: "moderate",
        assignmentSeed: `debug:${seed}`,
        assignmentBlockIndex: -1,
        replicateId: -1,
        assignedAt: new Date().toISOString(),
      });
    } else {
      claimSeededAssignment(db, id, seed);
    }
  });
```

Add to the imports at the top of `src/server/server.ts` (extend the existing `./assignment.ts` import from Task B3):

```ts
import { requireAssignmentSeed, resolveEntry, claimSeededAssignment } from "./assignment.ts";
```

- [ ] **Step 3c: Client passes entry** — in `web/study.html`, find the `fetch('/api/p/start'` call and add `entry: location.pathname` to the JSON body object it POSTs (alongside the existing `userAgent`/`viewport` fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 4 `resolveEntry` checks.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts src/server/assignment.ts web/study.html src/cli/smoke.ts
git commit -m "feat(assignment): wire seeded assignment into /api/p/start"
```

---

### Task B5: Opponent seam — use the persisted `opponent_block`

**Context:** `pickOpponentPersonality()` is called at request time twice in `src/server/server.ts` (≈ L801 and ≈ L1444) and the result is passed to `buildPack({ …, opponentPersonality })`. After Task B4 the opponent is fixed at `/api/p/start` and stored. Replace both call sites with the persisted value.

**Files:**
- Modify: `src/server/server.ts` (both `pickOpponentPersonality()` call sites)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor (verifies the persisted opponent round-trips, which is what the seam will read):

```ts
console.log("\n# clean-design: opponent seam source\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    p.createStudyParticipant({ id: "P1" });
    claimSeededAssignment(p, "P1", "seedX");
    const opp = p.getAssignment("P1")?.opponentBlock;
    check("persisted opponent is a valid block",
      ["easygoing","moderate","tough"].includes(opp as string));
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run test to verify it fails (or passes trivially) then proceed**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS (this guards the data the seam depends on; it should already pass after B2). If it FAILS, stop and fix B2 before editing the seam.

- [ ] **Step 3: Replace both call sites** — in `src/server/server.ts`:

At call site 1 (≈ L800–803), replace:

```ts
    // 1. Pick opponent personality (free-text mode — no behavior mapping).
    const opponentPersonality = pickOpponentPersonality();
```

with:

```ts
    // 1. Opponent personality is the seeded assignment made at /api/p/start.
    const opponentPersonality = withDb((db) => db.getAssignment(participantId))
      ?.opponentBlock as ("easygoing" | "moderate" | "tough");
    if (!opponentPersonality) throw new Error("no assignment for participant");
```

At call site 2 (≈ L1444), replace:

```ts
  const opponentPersonality = pickOpponentPersonality();
```

with (use the participant id in scope at that site — it is the same `participant`/id used for the surrounding `buildPack`; read it via `getAssignment`):

```ts
  const opponentPersonality = withDb((db) => db.getAssignment(participant.id))
    ?.opponentBlock as ("easygoing" | "moderate" | "tough");
  if (!opponentPersonality) throw new Error("no assignment for participant");
```

If the variable in scope at site 2 is not named `participant`, use whatever the surrounding code already uses as the study participant id for that request (the same id passed to the nearby `buildPack`/`insertParticipantResponses`). Remove the now-unused `pickOpponentPersonality` import if `npm run typecheck` flags it as unused; otherwise leave it (still used by debug/tests).

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors (fix the site-2 id reference if tsc reports an unknown identifier).
Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `persisted opponent is a valid block` and all prior checks.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts src/cli/smoke.ts
git commit -m "feat(assignment): read persisted opponent_block instead of random pick"
```

---

### Task B6: Demote `/api/p/mode` to debug-only

**Context:** `/api/p/mode` currently does `withDb((db) => db.updateStudyParticipant(body.participantId, { experiment_mode: body.mode }))` (≈ L1281). Under server-side assignment, mode is authoritative from `condition_mode`; the research SPA must not override it. Make the endpoint a no-op for participants that already have a `condition_mode` (research), and only honor it for `test_data` participants (debug).

**Files:**
- Modify: `src/server/server.ts` (the `/api/p/mode` handler ≈ L1281)
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the failing test** — append before the summary anchor (tests the guard helper this task adds):

```ts
import { modeOverrideAllowed } from "../server/assignment.ts";
console.log("\n# clean-design: /api/p/mode guard\n");
{
  check("research participant blocks override",
    modeOverrideAllowed({ condition_mode: "delegated", test_data: 0 }) === false);
  check("debug/test_data participant allows override",
    modeOverrideAllowed({ condition_mode: "delegated", test_data: 1 }) === true);
  check("legacy (no condition) allows override",
    modeOverrideAllowed({ condition_mode: null, test_data: 0 }) === true);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/cli/smoke.ts`
Expected: FAIL — `modeOverrideAllowed` is not exported.

- [ ] **Step 3a: Add the guard** — append to `src/server/assignment.ts`:

```ts
/** /api/p/mode may only mutate experiment_mode for legacy rows (no
 *  first-class condition) or debug/test_data participants. A research
 *  participant's mode is fixed by the seeded assignment. */
export function modeOverrideAllowed(
  sp: { condition_mode: string | null; test_data: number },
): boolean {
  if (sp.test_data === 1) return true;
  return sp.condition_mode == null;
}
```

- [ ] **Step 3b: Apply the guard** — in `src/server/server.ts`, replace the `/api/p/mode` body line:

```ts
  withDb((db) => db.updateStudyParticipant(body.participantId, { experiment_mode: body.mode }));
```

with:

```ts
  withDb((db) => {
    const sp = db.getStudyParticipant(body.participantId);
    if (sp && modeOverrideAllowed({ condition_mode: (sp as any).condition_mode ?? null, test_data: sp.test_data })) {
      db.updateStudyParticipant(body.participantId, { experiment_mode: body.mode });
    }
  });
```

Extend the `./assignment.ts` import in `src/server/server.ts` to include `modeOverrideAllowed`.

- [ ] **Step 4: Verify**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS all 3 `/api/p/mode guard` checks.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts src/server/assignment.ts src/cli/smoke.ts
git commit -m "feat(assignment): demote /api/p/mode to debug-only"
```

---

### Task B7: End-to-end balance integration check

**Files:**
- Test: `src/cli/smoke.ts`

- [ ] **Step 1: Write the test** — append before the summary anchor:

```ts
console.log("\n# clean-design: end-to-end balance\n");
{
  const d = mkdtempSync(path.join(tmpdir(), "ai2ai-cd-"));
  const p = openPersistence(path.join(d, "cd.db"));
  try {
    // 24 research claims = 2 full blocks ⇒ each of 12 strata exactly twice.
    for (let i = 0; i < 24; i++) {
      p.createStudyParticipant({ id: `R${i}` });
      claimSeededAssignment(p, `R${i}`, "studySeed");
    }
    // 1 debug participant must NOT perturb the sequence/counts.
    p.createStudyParticipant({ id: "D1" });
    p.setTestData("D1", true);
    p.recordAssignment("D1", {
      conditionMode: "delegated", conditionRole: "buyer",
      opponentBlock: "moderate", assignmentSeed: "debug:studySeed",
      assignmentBlockIndex: -1, replicateId: -1,
      assignedAt: "2026-05-15T00:00:00.000Z",
    });
    const counts = (p as any)["db"].prepare(
      `SELECT sp.condition_mode m, sp.condition_role r, sp.opponent_block o,
              COUNT(*) n
         FROM study_participants sp
        WHERE sp.test_data = 0 AND sp.condition_mode IS NOT NULL
        GROUP BY m, r, o`).all() as Array<{ n: number }>;
    check("12 research cells populated", counts.length === 12);
    check("every cell has exactly 2", counts.every((c) => c.n === 2));
    check("net position back-computes to 24",
      p.netResearchAssignmentPosition() === 24);
  } finally { p.close(); }
}
```

- [ ] **Step 2: Run**

Run: `npx tsx src/cli/smoke.ts`
Expected: PASS `12 research cells populated`, `every cell has exactly 2`, `net position back-computes to 24`; final summary `0 failed`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/smoke.ts
git commit -m "test(assignment): end-to-end balance + debug isolation"
```

---

## Self-Review

**1. Spec coverage:**
- Schema spec §1 columns → A1. §2 `assignment_log` → A2. §3 manipulation check (derived pass) → A5 (raw response uses the existing `participant_responses` path, unchanged — no task needed). §1 exclusion booleans + rollup → A6. §4 NULL-legacy (nullable, no default) → A1 (assertion that pre-existing rows stay NULL is implicit in the additive ALTERs; analysis-side handling is spec 4). §5 migration mechanics → A1/A2 (existing try/catch + `IF NOT EXISTS`). §6 accessors → A3–A8.
- Platform-code spec §2 pure generator → B1. §3 transactional claim → A8 + B2. §4 seed + boot fail-fast → B3. §5 `/api/p/start` wiring + debug routes → B4. §6 opponent seam → B5. §7 `/api/p/mode` demotion → B6. §8 tests → tests in every task + B7.
- Methodology spec: 12 strata / balance → B1, B7. Replacement frees stratum → A4 + A7 (net position) + B7 reasoning. Pre-registration/power are not code (spec 1, no task).
- Gaps: none blocking. Manipulation-check item *wording/screen* is an explicit Open item in the spec (pre-registration), not this plan.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step has complete code. Test code is concrete.

**3. Type consistency:** `recordAssignment`’s arg object (A3) matches `claimAssignment`’s `compute` return (A8) and `claimSeededAssignment` (B2). `getAssignment` field names (`conditionMode`, `opponentBlock`, …) are used identically in B2/B5/B7. `nextAssignment`/`Assignment`/`STRATA` (B1) are consumed with the same names in B2/B4/B7. `resolveEntry`/`Entry` (B4), `requireAssignmentSeed` (B3), `modeOverrideAllowed` (B6) are each defined before first use. `pickOpponentPersonality` is only *removed from call sites* (B5), not deleted (still imported by tests/debug), avoiding dangling references.

One known soft spot called out inline: Task B5 site-2's participant-id identifier may not literally be `participant.id`; the step explicitly instructs the engineer to use the id already in scope for the surrounding `buildPack`, and to verify via `npm run typecheck`. This is a deliberate, signposted instruction rather than a hidden placeholder.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-clean-experimental-design-assignment.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
