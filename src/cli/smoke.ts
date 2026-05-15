// Smoke test: exercise the engine paths that don't require an LLM.
//
// Verifies:
//   - All three example scenarios load and pass validation.
//   - SQLite schema initializes.
//   - Orchestrator tool-call validation rejects bad inputs.
//   - Round-robin fallback picks the next participant correctly.
//   - Memory rendering produces a non-empty context.

import { loadScenarioPack, validateScenarioPack, ScenarioValidationError } from "../multi-agent/scenario-loader.ts";
import { openPersistence } from "../multi-agent/persistence.ts";
import { validateOrchestratorToolCall } from "../multi-agent/orchestrator.ts";
import { pickNextRoundRobin } from "../multi-agent/fallback-protocol.ts";
import { buildParticipantContext } from "../multi-agent/memory.ts";
import { ParticipantRuntime } from "../multi-agent/participant.ts";
import type { OrchestratorState, Turn } from "../multi-agent/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok ${name}`);
    pass += 1;
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fail += 1;
  }
}

async function main(): Promise<void> {
  console.log("# scenario validation\n");
  const scenarios = ["buyer-seller-negotiation", "three-party-debate", "consensus-deliberation"];
  for (const id of scenarios) {
    try {
      const pack = await loadScenarioPack(id);
      check(`load ${id}`, pack.id === id, `got id=${pack.id}`);
      check(`${id} has >=2 participants`, pack.participants.length >= 2, `got ${pack.participants.length}`);
    } catch (err) {
      check(`load ${id}`, false, (err as Error).message);
    }
  }

  console.log("\n# scenario validator rejects bad packs\n");
  try {
    validateScenarioPack({ id: "bad", version: "0.0.0", name: "bad", description: "x", participants: [] });
    check("rejects empty participants", false, "should have thrown");
  } catch (err) {
    check("rejects empty participants", err instanceof ScenarioValidationError, (err as Error).message.slice(0, 60));
  }

  console.log("\n# orchestrator tool-call validation\n");
  const pack = await loadScenarioPack("buyer-seller-negotiation");
  const stubState: OrchestratorState = {
    sessionId: "stub",
    scenarioPack: pack,
    transcript: [],
    decisions: [],
    phase: "running",
    budget: { maxTurns: 30, maxTokens: 0, maxOrchestratorTokens: 50000 },
    consumed: { turns: 0, tokensTotal: 0, tokensOrchestrator: 0 },
    pendingBroadcasts: new Map(),
    compressedContext: new Map(),
    degraded: false,
  };
  check(
    "request_turn(buyer) accepted",
    validateOrchestratorToolCall({ name: "request_turn", input: { participant_id: "buyer" } }, stubState).ok,
  );
  check(
    "request_turn(unknown) rejected",
    !validateOrchestratorToolCall({ name: "request_turn", input: { participant_id: "ghost" } }, stubState).ok,
  );
  check(
    "declare_outcome with bad type rejected",
    !validateOrchestratorToolCall(
      { name: "declare_outcome", input: { type: "weirdo", summary: "x", rationale: "y" } },
      stubState,
    ).ok,
  );
  check(
    "declare_outcome with valid type and missing terms accepted",
    validateOrchestratorToolCall(
      { name: "declare_outcome", input: { type: "agreed", summary: "x", rationale: "y" } },
      stubState,
    ).ok,
  );
  check(
    "declare_outcome with bad terms rejected",
    !validateOrchestratorToolCall(
      {
        name: "declare_outcome",
        input: {
          type: "agreed",
          summary: "x",
          rationale: "y",
          terms: { price: 10000, warranty_months: 12, delivery_weeks: 2, accessories: "winter_tires" },
          // price=10000 is below the [12000, 22000] range
        },
      },
      stubState,
    ).ok,
  );
  // Validator is intentionally lenient on broadcast_to audience shape — a
  // bad/unknown audience gets coerced to "all" so the orchestrator never
  // fails 3x on this and degrades to round-robin fallback. Verify the
  // coercion happens (call returns ok and audience is rewritten).
  check(
    "broadcast_to(unknown audience) coerced to 'all'",
    (() => {
      const call = { name: "broadcast_to", input: { audience: ["ghost"], message: "hi" } };
      const r = validateOrchestratorToolCall(call as any, stubState);
      return r.ok === true && (call.input as any).audience === "all";
    })(),
  );
  check(
    "broadcast_to(bare 'buyer' string) coerced to ['buyer']",
    (() => {
      const call = { name: "broadcast_to", input: { audience: "buyer", message: "hi" } };
      const r = validateOrchestratorToolCall(call as any, stubState);
      return r.ok === true && Array.isArray((call.input as any).audience)
        && (call.input as any).audience[0] === "buyer";
    })(),
  );
  check(
    "compress_context valid",
    validateOrchestratorToolCall(
      { name: "compress_context", input: { participant_id: "buyer", summary: "round 1: …" } },
      stubState,
    ).ok,
  );
  check(
    "pause(reason) valid",
    validateOrchestratorToolCall({ name: "pause", input: { reason: "deadlock" } }, stubState).ok,
  );

  console.log("\n# round-robin fallback\n");
  // First fallback with empty transcript → first participant.
  const first = pickNextRoundRobin(stubState);
  check("first fallback = buyer", first === "buyer", `got ${first}`);
  // After buyer turn → next is seller.
  const buyerTurn: Turn = {
    id: "t1",
    sessionId: "stub",
    turnNumber: 1,
    emitter: "participant",
    emitterId: "buyer",
    toolCalls: [],
    tokens: { input: 0, output: 0 },
    latencyMs: 0,
    model: "claude-sonnet-4-6",
    timestamp: new Date().toISOString(),
  };
  stubState.transcript.push(buyerTurn);
  const second = pickNextRoundRobin(stubState);
  check("after buyer = seller", second === "seller", `got ${second}`);

  console.log("\n# memory / context rendering\n");
  const ctx = buildParticipantContext(pack.participants[1]!, stubState.transcript, pack);
  check("seller context non-empty", ctx.length > 0);
  check("seller context mentions buyer", ctx.includes("buyer"));

  console.log("\n# participant template renders\n");
  // ParticipantRuntime construction renders the system prompt, so this fails
  // loudly if Mustache substitution breaks. We don't actually call the LLM.
  try {
    new ParticipantRuntime(pack.participants[0]!);
    check("participant runtime constructs", true);
  } catch (err) {
    // Expected if no API key — but the system-prompt rendering happens before
    // the LLM client is built, so the failure should mention the API key.
    const msg = (err as Error).message;
    if (msg.includes("API key")) {
      check("participant runtime constructs (api key check)", true);
    } else {
      check("participant runtime constructs", false, msg);
    }
  }

  console.log("\n# sqlite persistence schema\n");
  const dir = mkdtempSync(path.join(tmpdir(), "ai2ai-smoke-"));
  const db = openPersistence(path.join(dir, "smoke.db"));
  try {
    const sessions = await db.listSessions(1);
    check("listSessions on empty db returns []", sessions.length === 0);
  } finally {
    db.close();
  }

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
      check("condition_mode written", sp.condition_mode === "delegated");
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
      p.createStudyParticipant({ id: "P3" });
      p.recordAssignment("P3", {
        conditionMode: "direct", conditionRole: "buyer",
        opponentBlock: "easygoing", assignmentSeed: "S",
        assignmentBlockIndex: 0, replicateId: 0,
        assignedAt: "2026-05-15T00:00:00.000Z",
      });
      const sp3 = p.getStudyParticipant("P3")!;
      check("dual-write experiment_mode=human_buyer", sp3.experiment_mode === "human_buyer");
    } finally { p.close(); }
  }

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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
