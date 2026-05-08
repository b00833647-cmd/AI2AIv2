// Deterministic round-robin fallback.
//
// Activates when the LLM Orchestrator fails 3× consecutively. Picks the next
// participant in a stable rotation and signals the session runner to flag the
// session as `degraded`.
//
// While in fallback, the engine still calls the orchestrator on each
// subsequent turn — if the orchestrator recovers and emits a valid tool call,
// control returns to it (the session stays flagged as degraded for the
// record).

import type { OrchestratorState, ParticipantId, ToolCall } from "./types.ts";

export function pickNextRoundRobin(state: OrchestratorState): ParticipantId {
  const ids = state.scenarioPack.participants.map((p) => p.id);
  if (ids.length === 0) throw new Error("Round-robin fallback: no participants");

  // Find the most recent participant turn; next is the one after them.
  // Both LLM ("participant") and human ("human") emitters count as the
  // most-recent speaker for round-robin rotation purposes.
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const t = state.transcript[i];
    if (t === undefined) continue;
    if (t.emitter !== "participant" && t.emitter !== "human") continue;
    const idx = ids.indexOf(String(t.emitterId));
    if (idx >= 0) {
      const nextIdx = (idx + 1) % ids.length;
      const next = ids[nextIdx];
      if (next !== undefined) return next;
    }
  }
  // No prior turn — start with the first participant.
  const first = ids[0];
  if (first === undefined) throw new Error("Round-robin fallback: no participants");
  return first;
}

export function buildFallbackToolCall(state: OrchestratorState): ToolCall {
  const next = pickNextRoundRobin(state);
  return {
    name: "request_turn",
    input: {
      participant_id: next,
      instruction: "[Round-robin fallback active] Take your turn normally.",
    },
  };
}
