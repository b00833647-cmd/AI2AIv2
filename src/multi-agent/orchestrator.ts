// LLM Orchestrator runtime.
//
// One LLM call per orchestrator turn. Always emits exactly one tool call from
// the five-tool vocabulary. All five tools are validated engine-side; on
// failure the engine re-prompts with the validation error.

import type {
  DecisionSlot,
  LLMConfig,
  OrchestratorDecision,
  OrchestratorState,
  OrchestratorToolName,
  ParticipantId,
  ToolCall,
  Turn,
} from "./types.ts";
import { createLLMClient, type LLMClient } from "./llm.ts";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./orchestrator-prompt.ts";
import { ORCHESTRATOR_TOOLS } from "./orchestrator-tools.ts";

const ORCH_TOOL_NAMES = new Set<OrchestratorToolName>([
  "request_turn",
  "broadcast_to",
  "declare_outcome",
  "compress_context",
  "pause",
]);

export const DEFAULT_ORCHESTRATOR_LLM: LLMConfig = {
  provider: "anthropic",
  model: "claude-opus-4-7",
  thinkingBudget: 4000,
  effort: "high",
  maxTokens: 8000,
  apiKeyEnv: "ORCHESTRATOR_ANTHROPIC_API_KEY",
};

export interface OrchestratorRunResult {
  decision: OrchestratorDecision;
  tokensUsed: number;
  latencyMs: number;
  /** Validation errors encountered before a successful tool call. */
  validationErrors: string[];
  /** True if the engine had to fall back to round-robin. */
  fellBack: boolean;
}

export class OrchestratorRuntime {
  private readonly llm: LLMClient;

  constructor(cfg: LLMConfig = DEFAULT_ORCHESTRATOR_LLM) {
    this.llm = createLLMClient(cfg);
  }

  /**
   * Run one orchestrator decision.
   * - Validates the returned tool call.
   * - On invalid: re-prompts up to `maxRetries` times with the error inline.
   * - On exhaustion: throws so the session runner can fall back to round-robin.
   */
  async decide(state: OrchestratorState, maxRetries = 3): Promise<OrchestratorRunResult> {
    const validationErrors: string[] = [];
    let tokensUsed = 0;
    let latencyMs = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const userMessage = buildOrchestratorUserMessage(state, validationErrors);
      const response = await this.llm.call({
        systemStatic: ORCHESTRATOR_SYSTEM_PROMPT,
        userMessage,
        tools: ORCHESTRATOR_TOOLS,
        toolChoice: "any",
      });

      tokensUsed += response.tokens.input + response.tokens.output;
      latencyMs += response.latencyMs;

      // Find the first orchestrator-tool call in the response.
      const toolCall = response.toolCalls.find((t) => ORCH_TOOL_NAMES.has(t.name as OrchestratorToolName));
      if (!toolCall) {
        validationErrors.push(
          "No orchestrator tool call found in response. You must call exactly one of: request_turn, broadcast_to, declare_outcome, compress_context, pause.",
        );
        continue;
      }

      const validation = validateOrchestratorToolCall(toolCall, state);
      if (!validation.ok) {
        validationErrors.push(`Invalid '${toolCall.name}' call: ${validation.error}`);
        continue;
      }

      const decision: OrchestratorDecision = {
        turnNumber: state.consumed.turns + 1,
        toolCall,
        rationale: extractRationale(toolCall),
        thinking: response.thinking,
        timestamp: new Date().toISOString(),
      };

      return { decision, tokensUsed, latencyMs, validationErrors, fellBack: false };
    }

    throw new OrchestratorFailure(
      `Orchestrator failed after ${maxRetries} attempts. Last errors: ${validationErrors.slice(-3).join(" | ")}`,
      validationErrors,
    );
  }
}

export class OrchestratorFailure extends Error {
  validationErrors: string[];
  constructor(message: string, errors: string[]) {
    super(message);
    this.name = "OrchestratorFailure";
    this.validationErrors = errors;
  }
}

// ─── User message construction ─────────────────────────────────────────────

function buildOrchestratorUserMessage(state: OrchestratorState, prevErrors: string[]): string {
  const parts: string[] = [];

  parts.push(formatScenarioBrief(state));
  parts.push(formatBudget(state));
  parts.push(formatTranscript(state.transcript));
  parts.push(formatOrchestratorLog(state.decisions));
  parts.push(formatPending(state));

  if (prevErrors.length > 0) {
    const recent = prevErrors.slice(-3).map((e) => `- ${e}`).join("\n");
    parts.push(`<validation_errors>\nYour previous decision was rejected. Fix and try again:\n${recent}\n</validation_errors>`);
  }

  return parts.join("\n\n");
}

function formatScenarioBrief(state: OrchestratorState): string {
  const p = state.scenarioPack;
  const roster = p.participants
    .map((part) => {
      const profile = part.publicProfile ? ` profile=${JSON.stringify(part.publicProfile)}` : "";
      const model = part.human ? "human" : part.llm?.model ?? "?";
      return `  - id="${part.id}" role="${part.role}" model="${model}"${profile}`;
    })
    .join("\n");

  const firstSpeakerLine = p.protocolHints.firstSpeaker
    ? `firstSpeaker: ${p.protocolHints.firstSpeaker}   ← your first request_turn MUST target this participant`
    : `firstSpeaker: (unspecified — choose whoever is most natural to open)`;

  return `<scenario_brief>
name: ${p.name}
description: ${p.description}

participants:
${roster}

decisionSpace: ${JSON.stringify(p.decisionSpace)}

protocolHints: ${JSON.stringify(p.protocolHints)}
${firstSpeakerLine}

agreementCriteria: ${p.agreementCriteria}
</scenario_brief>`;
}

function formatBudget(state: OrchestratorState): string {
  const cap = (n: number) => (Number.isFinite(n) && n > 0 ? String(n) : "unlimited");
  return `<budget>
max_turns: ${cap(state.budget.maxTurns)}
max_orchestrator_tokens: ${cap(state.budget.maxOrchestratorTokens)}
turns_consumed: ${state.consumed.turns}
tokens_total: ${state.consumed.tokensTotal}
tokens_orchestrator: ${state.consumed.tokensOrchestrator}
deadline: ${state.budget.deadline ?? "none"}
</budget>`;
}

function formatTranscript(turns: Turn[]): string {
  if (turns.length === 0) {
    return `<transcript>
(no turns yet — this is the start of the session)
</transcript>`;
  }
  const items = turns.map((t) => formatTurnForOrchestrator(t)).join("\n\n");
  return `<transcript>
${items}
</transcript>`;
}

export function formatTurnForOrchestrator(t: Turn): string {
  const header = `Turn #${t.turnNumber} [${t.emitter}: ${t.emitterId}]`;
  const lines: string[] = [header];
  if (t.message) lines.push(`message: ${t.message}`);
  for (const call of t.toolCalls) {
    lines.push(`tool_call: ${call.name} ${JSON.stringify(call.input)}`);
  }
  return lines.join("\n");
}

function formatOrchestratorLog(decisions: OrchestratorDecision[]): string {
  if (decisions.length === 0) {
    return `<orchestrator_log>
(no prior decisions)
</orchestrator_log>`;
  }
  const items = decisions
    .map(
      (d) =>
        `Decision #${d.turnNumber} [${d.toolCall.name}] ${JSON.stringify(d.toolCall.input)}${
          d.rationale ? ` rationale="${d.rationale}"` : ""
        }`,
    )
    .join("\n");
  return `<orchestrator_log>
${items}
</orchestrator_log>`;
}

function formatPending(state: OrchestratorState): string {
  // Phase 1: no operator commands yet. Reserved for future human-in-the-loop.
  void state;
  return `<pending>
(no pending operator commands)
</pending>`;
}

// ─── Validation ────────────────────────────────────────────────────────────

interface Validation {
  ok: boolean;
  error?: string;
}

export function validateOrchestratorToolCall(
  call: ToolCall,
  state: OrchestratorState,
): Validation {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const knownIds = new Set<ParticipantId>(state.scenarioPack.participants.map((p) => p.id));

  switch (call.name as OrchestratorToolName) {
    case "request_turn": {
      const pid = input["participant_id"];
      if (typeof pid !== "string") return { ok: false, error: "participant_id must be a string" };
      if (!knownIds.has(pid)) return { ok: false, error: `participant_id '${pid}' is not in the roster` };
      const instr = input["instruction"];
      if (instr !== undefined) {
        if (typeof instr !== "string") return { ok: false, error: "instruction must be a string" };
        if (instr.length > 500) return { ok: false, error: "instruction must be <= 500 chars" };
      }
      // First-speaker directive: when the scenario pins firstSpeaker and no
      // participant has spoken yet, the very first request_turn must target
      // that participant. Engine-enforced; orchestrator gets re-prompted.
      // Both LLM-participant ('participant') and human ('human') emitters
      // count as "someone has spoken" — only orchestrator decisions are skipped.
      const firstSpeaker = state.scenarioPack.protocolHints.firstSpeaker;
      const noTurnsYet = state.transcript.every((t) => t.emitter !== "participant" && t.emitter !== "human");
      if (firstSpeaker && noTurnsYet && pid !== firstSpeaker) {
        return {
          ok: false,
          error: `protocolHints.firstSpeaker is '${firstSpeaker}' — the first request_turn MUST target that participant. You requested '${pid}'. Retry with participant_id='${firstSpeaker}'.`,
        };
      }
      return { ok: true };
    }
    case "broadcast_to": {
      const audience = input["audience"];
      const message = input["message"];
      if (typeof message !== "string" || message.length === 0) {
        return { ok: false, error: "message must be a non-empty string" };
      }
      if (message.length > 500) return { ok: false, error: "message must be <= 500 chars" };

      // Maximally lenient audience normalization. The orchestrator LLM
      // occasionally invents shapes the strict schema doesn't allow
      // (e.g. "both", "everyone", "buyer,seller", a bare known id, etc.).
      // Rather than failing 3x and degrading to round-robin fallback, we
      // coerce every reasonable shape to something downstream code accepts.
      // Mutates input.audience in place so session-runner sees the
      // canonical form. Unrecognised garbage falls back to "all" — the
      // moderator note still lands; we just lose targeting precision.

      // 1. Already-canonical "all"
      if (audience === "all") return { ok: true };

      // 2. String forms
      if (typeof audience === "string") {
        const trimmed = audience.trim();
        // 2a. Synonyms for "all" — common LLM word choices
        if (/^(all|both|everyone|all\s*participants?|both\s*sides?|both\s*parties)$/i.test(trimmed)) {
          input["audience"] = "all";
          return { ok: true };
        }
        // 2b. Single known participant id (e.g. "buyer", "seller")
        if (knownIds.has(trimmed)) {
          input["audience"] = [trimmed];
          return { ok: true };
        }
        // 2c. Comma-separated list of ids (e.g. "buyer,seller" or "buyer, seller")
        if (trimmed.includes(",")) {
          const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
          const validParts = parts.filter((p) => knownIds.has(p));
          if (validParts.length > 0) {
            input["audience"] = validParts;
            return { ok: true };
          }
        }
        // 2d. Unknown string — fall back to "all" rather than failing
        input["audience"] = "all";
        return { ok: true };
      }

      // 3. Array forms
      if (Array.isArray(audience)) {
        // Filter to only known ids; tolerate unknown entries instead of failing.
        const validIds = audience.filter((id): id is string => typeof id === "string" && knownIds.has(id));
        if (validIds.length > 0) {
          input["audience"] = validIds;
          return { ok: true };
        }
        // Empty or all-unknown array — fall back to "all"
        input["audience"] = "all";
        return { ok: true };
      }

      // 4. Missing/null/object/etc. — fall back to "all"
      input["audience"] = "all";
      return { ok: true };
    }
    case "declare_outcome": {
      const type = input["type"];
      const summary = input["summary"];
      const rationale = input["rationale"];
      if (typeof type !== "string") return { ok: false, error: "type must be a string" };
      if (typeof summary !== "string" || summary.length === 0) return { ok: false, error: "summary required" };
      if (typeof rationale !== "string" || rationale.length === 0) return { ok: false, error: "rationale required" };
      const permitted = state.scenarioPack.protocolHints.permittedOutcomes;
      if (!permitted.includes(type)) {
        return { ok: false, error: `type '${type}' not in permittedOutcomes [${permitted.join(", ")}]` };
      }
      const terms = input["terms"];
      if (terms !== undefined) {
        if (typeof terms !== "object" || terms === null) {
          return { ok: false, error: "terms must be an object" };
        }
        const slotErr = validateTermsAgainstSlots(terms as Record<string, unknown>, state.scenarioPack.decisionSpace.slots);
        if (slotErr) return { ok: false, error: slotErr };
      }
      return { ok: true };
    }
    case "compress_context": {
      const pid = input["participant_id"];
      const summary = input["summary"];
      if (typeof pid !== "string" || !knownIds.has(pid)) {
        return { ok: false, error: `participant_id '${String(pid)}' invalid or unknown` };
      }
      if (typeof summary !== "string" || summary.length === 0) {
        return { ok: false, error: "summary must be a non-empty string" };
      }
      return { ok: true };
    }
    case "pause": {
      const reason = input["reason"];
      if (typeof reason !== "string" || reason.length === 0) {
        return { ok: false, error: "reason must be a non-empty string" };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown orchestrator tool '${call.name}'` };
  }
}

function validateTermsAgainstSlots(
  terms: Record<string, unknown>,
  slots: DecisionSlot[] | undefined,
): string | null {
  if (!slots || slots.length === 0) return null;
  for (const slot of slots) {
    const value = terms[slot.name];
    if (value === undefined) {
      return `terms missing required slot '${slot.name}'`;
    }
    switch (slot.type) {
      case "number": {
        if (typeof value !== "number") return `slot '${slot.name}' must be a number`;
        const [min, max] = slot.range;
        if (value < min || value > max) return `slot '${slot.name}' value ${value} outside [${min}, ${max}]`;
        break;
      }
      case "enum": {
        if (typeof value !== "string" || !slot.options.includes(value)) {
          return `slot '${slot.name}' must be one of [${slot.options.join(", ")}]`;
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") return `slot '${slot.name}' must be a boolean`;
        break;
      }
      case "text": {
        if (typeof value !== "string") return `slot '${slot.name}' must be text`;
        if (slot.maxLength && value.length > slot.maxLength) {
          return `slot '${slot.name}' exceeds maxLength ${slot.maxLength}`;
        }
        break;
      }
      case "json":
        // JSON-shape validation is left to the scenario-side detectors. We
        // accept anything here.
        break;
    }
  }
  return null;
}

function extractRationale(call: ToolCall): string | undefined {
  if (call.input && typeof call.input === "object") {
    const r = (call.input as Record<string, unknown>)["rationale"];
    if (typeof r === "string") return r;
  }
  return undefined;
}
