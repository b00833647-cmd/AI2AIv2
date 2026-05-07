// Session runner — wires the scenario, participants, and orchestrator into
// a running session.
//
// Loop, per turn:
//   1. Orchestrator decides next action (1 LLM call).
//   2. If declare_outcome → record outcome, end.
//   3. If pause → record, end (no human-in-loop yet — pause = stop).
//   4. If broadcast_to → enqueue note, loop back.
//   5. If compress_context → store summary, loop back.
//   6. If request_turn → call participant (1 LLM call), append turn, loop.

import { nanoid } from "nanoid";
import type {
  ConsumedTotals,
  LLMConfig,
  OrchestratorDecision,
  OrchestratorState,
  OrchestratorToolName,
  ParticipantId,
  ScenarioPack,
  SessionId,
  SessionOutcome,
  ToolCall,
  Turn,
} from "./types.ts";
import { OrchestratorRuntime, OrchestratorFailure, DEFAULT_ORCHESTRATOR_LLM } from "./orchestrator.ts";
import { ParticipantRuntime } from "./participant.ts";
import { buildParticipantContext } from "./memory.ts";
import { buildFallbackToolCall } from "./fallback-protocol.ts";
import type { Persistence } from "./persistence.ts";

export type SessionEvent =
  | { type: "session_start"; sessionId: SessionId; pack: ScenarioPack; orchestratorModel: string }
  | { type: "orchestrator_decision"; decision: OrchestratorDecision; tokensUsed: number }
  | { type: "turn_starting"; participantId: ParticipantId; turnNumber: number }
  | {
      type: "human_turn_required";
      participantId: ParticipantId;
      turnNumber: number;
      instruction?: string;
      /** Compact serialization of what the human needs to see / respond to. */
      lastOpponentTurn?: Turn;
    }
  | { type: "participant_turn"; turn: Turn }
  | { type: "fallback_triggered"; reason: string }
  | { type: "session_end"; outcome: SessionOutcome; degraded: boolean; consumed: ConsumedTotals };

/**
 * Provider that the SessionRunner calls whenever it needs a human-side turn.
 * Resolves once the human (UI client) has submitted their action via the
 * server's external endpoint. Returns the same shape an LLM participant
 * would emit (message + toolCalls).
 */
export interface HumanTurnRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  turnNumber: number;
  instruction?: string;
  lastOpponentTurn?: Turn;
}
export interface HumanTurnResponse {
  message: string;
  toolCalls: ToolCall[];
  /** Latency from when we started waiting to when the human submitted (ms). */
  latencyMs: number;
}
export type HumanTurnProvider = (req: HumanTurnRequest) => Promise<HumanTurnResponse>;

export interface SessionRunnerOpts {
  pack: ScenarioPack;
  /** Override the orchestrator's LLM. Falls back to pack.orchestrator, then DEFAULT_ORCHESTRATOR_LLM. */
  orchestratorLLM?: LLMConfig;
  /** Optional persistence backend. If omitted, the run is in-memory only. */
  persistence?: Persistence;
  /** Optional pre-loaded orchestrator decision log for replay mode. */
  replayDecisions?: OrchestratorDecision[];
  /** Print transcript events to stdout as they happen. */
  verbose?: boolean;
  /**
   * Optional listener for streaming events. Called as each major step happens.
   * Throw or stay synchronous — the runner doesn't await this callback's return.
   */
  onEvent?: (event: SessionEvent) => void;
  /** Override the orchestrator's `decide` for replay or scripted runs. */
  decisionOverride?: (state: OrchestratorState) => Promise<{
    decision: OrchestratorDecision;
    tokensUsed: number;
    fellBack: boolean;
  }>;
  /**
   * Required when any participant in the pack has `human: true`. Called when
   * the orchestrator routes a turn to a human; the runner pauses and awaits
   * the returned promise before recording the turn and resuming.
   */
  humanTurnProvider?: HumanTurnProvider;
}

export interface SessionResult {
  sessionId: SessionId;
  pack: ScenarioPack;
  transcript: Turn[];
  decisions: OrchestratorDecision[];
  outcome: SessionOutcome;
  degraded: boolean;
  consumed: OrchestratorState["consumed"];
}

const MAX_CONSECUTIVE_ORCHESTRATOR_FAILURES = 3;
const MAX_DECISIONS_PER_TURN = 5; // broadcast/compress decisions before a participant turn

/**
 * Normalize an optional cap. `undefined`, `0`, and any non-finite value mean
 * "no cap" → `Infinity`, which makes the < and >= comparisons in the engine
 * loop trivially never trigger.
 */
function normalizeCap(value: number | undefined): number {
  if (value === undefined || value <= 0 || !Number.isFinite(value)) return Infinity;
  return value;
}

export async function runSession(opts: SessionRunnerOpts): Promise<SessionResult> {
  const sessionId: SessionId = nanoid();
  const pack = opts.pack;
  const verbose = opts.verbose ?? true;

  // Spawn participants once. Skip the LLM-runtime construction for human
  // participants — their turns are gated on opts.humanTurnProvider.
  const participants = new Map<ParticipantId, ParticipantRuntime>();
  for (const p of pack.participants) {
    if (p.human) continue;
    participants.set(p.id, new ParticipantRuntime(p));
  }
  // Sanity-check: if any participant is human, a humanTurnProvider must be wired.
  const hasHuman = pack.participants.some((p) => p.human);
  if (hasHuman && !opts.humanTurnProvider) {
    throw new Error("Pack has a human participant but no opts.humanTurnProvider was supplied.");
  }

  // Spawn orchestrator.
  const orchestratorCfg: LLMConfig = opts.orchestratorLLM ?? pack.orchestrator ?? DEFAULT_ORCHESTRATOR_LLM;
  const orchestrator = new OrchestratorRuntime(orchestratorCfg);

  // Build initial state. maxTurns and maxOrchestratorTokens are optional —
  // an unset (or 0) value means no engine-side cap; the orchestrator decides
  // when to terminate. We still keep numeric fields on the budget for downstream
  // consumers; Infinity is the in-memory representation of "no cap".
  const turnCap = normalizeCap(pack.protocolHints.maxTurns);
  const orchTokenCap = normalizeCap(pack.protocolHints.maxOrchestratorTokens);
  const state: OrchestratorState = {
    sessionId,
    scenarioPack: pack,
    transcript: [],
    decisions: [],
    phase: "running",
    budget: {
      maxTurns: turnCap,
      maxTokens: 0, // not enforced separately yet
      maxOrchestratorTokens: orchTokenCap,
    },
    consumed: { turns: 0, tokensTotal: 0, tokensOrchestrator: 0 },
    pendingBroadcasts: new Map(),
    compressedContext: new Map(),
    degraded: false,
  };

  if (opts.persistence) await opts.persistence.startSession(state);

  const log = (s: string) => {
    if (verbose) console.log(s);
  };
  const emit = (event: SessionEvent) => {
    if (!opts.onEvent) return;
    try {
      opts.onEvent(event);
    } catch (err) {
      // Don't let a misbehaving listener kill the session.
      log(`[onEvent] listener threw: ${(err as Error).message}`);
    }
  };

  log(`\n=== Session ${sessionId} ===`);
  log(`Scenario: ${pack.name} v${pack.version} (${pack.id})`);
  log(`Participants: ${pack.participants.map((p) => `${p.id}(${p.role})`).join(", ")}`);
  log(`Orchestrator: ${orchestratorCfg.model}\n`);
  emit({ type: "session_start", sessionId, pack, orchestratorModel: orchestratorCfg.model });

  let consecutiveFailures = 0;
  let outcome: SessionOutcome | null = null;
  const replayQueue = (opts.replayDecisions ?? []).slice();

  outer: while (state.consumed.turns < state.budget.maxTurns) {
    if (state.consumed.tokensOrchestrator >= state.budget.maxOrchestratorTokens) {
      log(`[budget] orchestrator token cap reached (${state.consumed.tokensOrchestrator}/${state.budget.maxOrchestratorTokens})`);
      outcome = forcedOutcome(pack, state, "timeout", "Orchestrator token budget exhausted.");
      break;
    }

    // Phase A: orchestrator decides what's next. May emit non-terminal tool
    // calls (broadcast, compress) before we get a request_turn or terminal.
    let actedOnTurn = false;
    for (let inner = 0; inner < MAX_DECISIONS_PER_TURN; inner++) {
      let decision: OrchestratorDecision;
      let tokensUsed = 0;
      let fellBack = false;

      try {
        if (replayQueue.length > 0) {
          // Replay mode: pop the next pre-recorded decision instead of LLM call.
          const popped = replayQueue.shift();
          if (popped === undefined) throw new Error("replay queue underrun");
          decision = popped;
        } else if (opts.decisionOverride) {
          const result = await opts.decisionOverride(state);
          decision = result.decision;
          tokensUsed = result.tokensUsed;
          fellBack = result.fellBack;
        } else {
          const result = await orchestrator.decide(state);
          decision = result.decision;
          tokensUsed = result.tokensUsed;
        }
        consecutiveFailures = 0;
        if (fellBack) state.degraded = true;
      } catch (err) {
        consecutiveFailures += 1;
        log(`[orchestrator] failure ${consecutiveFailures}: ${(err as Error).message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_ORCHESTRATOR_FAILURES) {
          log(`[orchestrator] max consecutive failures reached — falling back to round-robin`);
          state.degraded = true;
          emit({ type: "fallback_triggered", reason: (err as Error).message });
          decision = {
            turnNumber: state.consumed.turns + 1,
            toolCall: buildFallbackToolCall(state),
            rationale: "round-robin fallback (orchestrator failed)",
            timestamp: new Date().toISOString(),
          };
          consecutiveFailures = 0;
        } else {
          continue;
        }
      }

      state.decisions.push(decision);
      state.consumed.tokensOrchestrator += tokensUsed;
      state.consumed.tokensTotal += tokensUsed;
      if (opts.persistence) await opts.persistence.recordOrchestratorDecision(state, decision, tokensUsed);

      log(`[orch] ${decision.toolCall.name} ${shortenJson(decision.toolCall.input)}`);
      emit({ type: "orchestrator_decision", decision, tokensUsed });

      const action = decision.toolCall.name as OrchestratorToolName;

      if (action === "declare_outcome") {
        outcome = buildOutcome(decision.toolCall, pack, state);
        break outer;
      }
      if (action === "pause") {
        outcome = forcedOutcome(pack, state, "paused", `Paused: ${(decision.toolCall.input as Record<string, unknown>)["reason"]}`);
        break outer;
      }
      if (action === "broadcast_to") {
        const inp = decision.toolCall.input as { audience: string | string[]; message: string };
        enqueueBroadcast(state, inp.audience, inp.message);
        continue;
      }
      if (action === "compress_context") {
        const inp = decision.toolCall.input as { participant_id: ParticipantId; summary: string };
        state.compressedContext.set(inp.participant_id, inp.summary);
        continue;
      }
      if (action === "request_turn") {
        const inp = decision.toolCall.input as {
          participant_id: ParticipantId;
          instruction?: string;
          context_override?: string;
        };
        const targetParticipant = pack.participants.find((p) => p.id === inp.participant_id);
        const isHumanTurn = !!targetParticipant?.human;
        if (isHumanTurn) {
          // Notify listeners that a human is about to be prompted, with the
          // last opponent turn so the SPA can re-display context.
          emit({
            type: "human_turn_required",
            participantId: inp.participant_id,
            turnNumber: state.consumed.turns + 1,
            instruction: inp.instruction,
            lastOpponentTurn: state.transcript[state.transcript.length - 1],
          });
        } else {
          // Existing LLM path — emit "typing…" so the UI can animate.
          emit({
            type: "turn_starting",
            participantId: inp.participant_id,
            turnNumber: state.consumed.turns + 1,
          });
        }
        const turn = isHumanTurn
          ? await runHumanTurn(state, inp, opts.humanTurnProvider!)
          : await runParticipantTurn(state, inp, participants);
        state.transcript.push(turn);
        state.consumed.turns += 1;
        state.consumed.tokensTotal += turn.tokens.input + turn.tokens.output;
        if (opts.persistence) await opts.persistence.recordTurn(state, turn);
        log(`[turn #${turn.turnNumber}] ${turn.emitterId}: ${formatTurnLine(turn)}`);
        emit({ type: "participant_turn", turn });
        actedOnTurn = true;
        break;
      }
    }

    if (!actedOnTurn) {
      // Stuck in non-terminal decisions for too long — force-pause.
      log(`[engine] orchestrator emitted ${MAX_DECISIONS_PER_TURN} non-turn decisions in a row; aborting.`);
      outcome = forcedOutcome(pack, state, "aborted", "Orchestrator failed to advance the dialogue.");
      break;
    }
  }

  if (!outcome) {
    log(`[engine] reached maxTurns (${state.budget.maxTurns}) without an outcome`);
    outcome = forcedOutcome(pack, state, "timeout", `Reached maxTurns (${state.budget.maxTurns}).`);
  }

  state.phase = "ended";
  outcome.degraded = state.degraded;

  if (opts.persistence) await opts.persistence.endSession(state, outcome);

  log(`\n=== Outcome: ${outcome.type} ===`);
  log(outcome.summary);
  if (outcome.terms) log(`Terms: ${JSON.stringify(outcome.terms)}`);
  log(`Rationale: ${outcome.rationale}`);
  if (state.degraded) log(`(session was degraded — orchestrator fell back to round-robin at some point)`);

  emit({ type: "session_end", outcome, degraded: state.degraded, consumed: state.consumed });

  return {
    sessionId,
    pack,
    transcript: state.transcript,
    decisions: state.decisions,
    outcome,
    degraded: state.degraded,
    consumed: state.consumed,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function runParticipantTurn(
  state: OrchestratorState,
  input: { participant_id: ParticipantId; instruction?: string; context_override?: string },
  participants: Map<ParticipantId, ParticipantRuntime>,
): Promise<Turn> {
  const runtime = participants.get(input.participant_id);
  if (!runtime) throw new Error(`Unknown participant '${input.participant_id}'`);
  const participant = state.scenarioPack.participants.find((p) => p.id === input.participant_id);
  if (!participant) throw new Error(`Participant '${input.participant_id}' missing from pack`);

  const broadcasts = drainBroadcastsFor(state, input.participant_id);
  const compressedSummary = state.compressedContext.get(input.participant_id);
  if (compressedSummary) state.compressedContext.delete(input.participant_id);

  const context = buildParticipantContext(participant, state.transcript, state.scenarioPack, {
    contextOverride: input.context_override,
    compressedSummary,
  });

  const turn = await runtime.takeTurn({
    sessionId: state.sessionId,
    turnNumber: state.consumed.turns + 1,
    context,
    instruction: input.instruction,
    broadcasts: broadcasts.length > 0 ? broadcasts : undefined,
    compressedSummary,
  });
  return turn;
}

async function runHumanTurn(
  state: OrchestratorState,
  input: { participant_id: ParticipantId; instruction?: string },
  provider: HumanTurnProvider,
): Promise<Turn> {
  const t0 = Date.now();
  const last = state.transcript[state.transcript.length - 1];
  const response = await provider({
    sessionId: state.sessionId,
    participantId: input.participant_id,
    turnNumber: state.consumed.turns + 1,
    instruction: input.instruction,
    lastOpponentTurn: last,
  });
  return {
    id: nanoid(),
    sessionId: state.sessionId,
    turnNumber: state.consumed.turns + 1,
    emitter: "human",
    emitterId: input.participant_id,
    toolCalls: response.toolCalls,
    message: response.message,
    tokens: { input: 0, output: 0 },
    latencyMs: response.latencyMs ?? Date.now() - t0,
    model: "human",
    timestamp: new Date().toISOString(),
  };
}

function enqueueBroadcast(state: OrchestratorState, audience: string | string[], message: string): void {
  if (audience === "all") {
    appendBroadcast(state.pendingBroadcasts, "all", message);
    return;
  }
  for (const id of audience) {
    appendBroadcast(state.pendingBroadcasts, id, message);
  }
}

function appendBroadcast(map: Map<string, string[]>, key: string, message: string): void {
  const arr = map.get(key) ?? [];
  arr.push(message);
  map.set(key, arr);
}

function drainBroadcastsFor(state: OrchestratorState, pid: ParticipantId): string[] {
  const direct = state.pendingBroadcasts.get(pid) ?? [];
  const all = state.pendingBroadcasts.get("all") ?? [];
  state.pendingBroadcasts.delete(pid);
  // 'all' broadcasts are delivered once per recipient — but spec is ambiguous.
  // We keep them in the queue so subsequent participants on this round see
  // them too. Clear them on outcome instead.
  return [...all, ...direct];
}

function buildOutcome(call: ToolCall, pack: ScenarioPack, state: OrchestratorState): SessionOutcome {
  const inp = call.input as { type: string; summary: string; terms?: Record<string, unknown>; rationale: string };
  return {
    type: inp.type,
    summary: inp.summary,
    terms: inp.terms,
    rationale: inp.rationale,
    endedAt: new Date().toISOString(),
    degraded: state.degraded,
  };
  void pack;
}

function forcedOutcome(
  pack: ScenarioPack,
  state: OrchestratorState,
  preferred: string,
  summary: string,
): SessionOutcome {
  const permitted = pack.protocolHints.permittedOutcomes;
  const type = permitted.includes(preferred) ? preferred : (permitted[permitted.length - 1] ?? "timeout");
  return {
    type,
    summary,
    rationale: `Forced by engine. consumed=${JSON.stringify(state.consumed)}`,
    endedAt: new Date().toISOString(),
    degraded: state.degraded,
  };
}

function shortenJson(input: unknown, max = 200): string {
  const s = JSON.stringify(input);
  if (s === undefined) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatTurnLine(t: Turn): string {
  const message = t.message ? shortenJson(t.message, 200) : "";
  const tools = t.toolCalls.map((c) => c.name).join("+");
  return `${tools} ${message}`;
}
