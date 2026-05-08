// Core types for the multi-agent runtime.
// Adapted from multi-agent-core/types/core.ts. Engine has zero domain knowledge —
// every domain word lives inside Scenario Packs.

export type ParticipantId = string;
export type SessionId = string;
export type TurnId = string;

// ─── LLM config ────────────────────────────────────────────────────────────

export interface LLMConfig {
  provider: "anthropic" | string;
  model: string;
  temperature?: number;
  thinkingBudget?: number;
  maxTokens?: number;
  apiKeyEnv?: string;
  effort?: "low" | "medium" | "high" | "max" | "xhigh";
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolCall {
  id?: string;
  name: string;
  input: unknown;
}

// ─── Memory ────────────────────────────────────────────────────────────────

export type MemoryPolicy =
  | { type: "verbatim" }
  | { type: "summarized"; keepRecent: number; maxContextTokens: number }
  | { type: "external"; storeKey: string }
  | { type: "none" };

// ─── Decision space ────────────────────────────────────────────────────────

export type DecisionSlot =
  | { name: string; type: "number"; range: [number, number]; unit?: string }
  | { name: string; type: "enum"; options: string[] }
  | { name: string; type: "boolean" }
  | { name: string; type: "text"; maxLength?: number }
  | { name: string; type: "json"; schema: JSONSchema };

export interface DecisionSpace {
  freeText: boolean;
  slots?: DecisionSlot[];
}

// ─── Participant ───────────────────────────────────────────────────────────

/**
 * Visual context attached to a participant — listing photos, supporting
 * documents, etc. Sent as image content blocks on every turn so the agent
 * can reference what it actually sees, not just a text description. Cached
 * via Anthropic prompt caching so subsequent turns get the cache-read
 * discount instead of re-billing every image.
 */
export interface ParticipantImage {
  /** MIME type, e.g. "image/jpeg" or "image/png". */
  mediaType: string;
  /** Base64-encoded image data (no data: URI prefix). */
  data: string;
  /** Optional human-readable label, surfaced to the agent in a preamble line. */
  label?: string;
}

export interface Participant {
  id: ParticipantId;
  role: string;
  /** When this participant is `human:true`, llm may be omitted — the runner
   *  awaits an external human submission instead of invoking an LLM. */
  llm?: LLMConfig;
  systemPromptTemplate: string;
  brief: Record<string, unknown>;
  publicProfile?: Record<string, unknown>;
  tools: ToolDefinition[];
  outputSchema?: JSONSchema;
  memoryPolicy?: MemoryPolicy;
  contextFilterModule?: string;
  /** Marks this side as a real human participant. See session-runner.ts. */
  human?: boolean;
  /** Optional listing photos / supporting images delivered to the agent on
   *  every turn (cached via Anthropic prompt caching). Skipped for human
   *  participants. */
  images?: ParticipantImage[];
}

// ─── Protocol hints ────────────────────────────────────────────────────────

export type OrchestratorMode = "default" | "lazy" | "eager" | "decimated";

export interface ProtocolHints {
  /**
   * Hard cap on participant turns. If unset (or 0), the engine imposes no
   * cap — the orchestrator decides when to terminate via declare_outcome /
   * pause. Stuck-state safety nets (3-strikes orchestrator failure, 5
   * non-terminal decisions in a row) still apply regardless.
   */
  maxTurns?: number;
  maxRounds?: number;
  deadlineMs?: number;
  speakingOrder?: "round-robin" | "alternating" | "free";
  orchestratorMode?: OrchestratorMode;
  decimationK?: number;
  permittedOutcomes: string[];
  /**
   * Hard cap on cumulative orchestrator-call tokens. If unset (or 0), the
   * engine imposes no cap. Same rationale as maxTurns.
   */
  maxOrchestratorTokens?: number;
  maxParticipantTokensPerTurn?: number;
  /**
   * If set, the orchestrator's very first request_turn MUST target this
   * participant id. Engine-enforced via tool-call validation. Use it for
   * scenarios with a structurally fixed opener (e.g. buyer always inquires
   * first in a buyer-seller negotiation).
   */
  firstSpeaker?: ParticipantId;
}

// ─── Scenario pack ─────────────────────────────────────────────────────────

export interface ScenarioPack {
  id: string;
  version: string;
  name: string;
  description: string;
  participants: Participant[];
  decisionSpace: DecisionSpace;
  protocolHints: ProtocolHints;
  agreementCriteria: string;
  agreementDetectorModule?: string;
  utilityModule?: string;
  customMetricsModule?: string;
  ui?: { observer?: string; setup?: string };
  // Engine extension (not in spec types, optional): pin the orchestrator's LLM.
  orchestrator?: LLMConfig;
}

// ─── Turns ─────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreate?: number;
  cacheRead?: number;
  thinking?: number;
}

export type Emitter = "participant" | "orchestrator" | "human";

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;
  emitter: Emitter;
  emitterId: ParticipantId | "orchestrator";
  toolCalls: ToolCall[];
  message?: string;
  thinking?: string;
  tokens: TokenUsage;
  latencyMs: number;
  model: string;
  timestamp: string;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export type OrchestratorToolName =
  | "request_turn"
  | "broadcast_to"
  | "declare_outcome"
  | "compress_context"
  | "pause";

export interface OrchestratorDecision {
  turnNumber: number;
  toolCall: ToolCall;
  rationale?: string;
  commentary?: string;
  thinking?: string;
  timestamp: string;
}

export interface OrchestratorBudget {
  maxTurns: number;
  maxTokens: number;
  maxOrchestratorTokens: number;
  deadline?: string;
}

export interface ConsumedTotals {
  turns: number;
  tokensTotal: number;
  tokensOrchestrator: number;
}

export interface OrchestratorState {
  sessionId: SessionId;
  scenarioPack: ScenarioPack;
  transcript: Turn[];
  decisions: OrchestratorDecision[];
  phase: "setup" | "running" | "paused" | "ended";
  budget: OrchestratorBudget;
  consumed: ConsumedTotals;
  // Pending broadcasts/instructions queued by the orchestrator, attached to
  // the next turn for the named participant. Cleared once delivered.
  pendingBroadcasts: Map<ParticipantId | "all", string[]>;
  // Compressed-context summaries injected on the next request_turn.
  compressedContext: Map<ParticipantId, string>;
  degraded: boolean;
}

// ─── Outcome ───────────────────────────────────────────────────────────────

export interface SessionOutcome {
  type: string;
  summary: string;
  terms?: Record<string, unknown>;
  rationale: string;
  participantUtilities?: Record<ParticipantId, number>;
  customMetrics?: Record<string, number>;
  endedAt: string;
  degraded?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export type ContextFilterFn = (
  transcript: Turn[],
  participantId: ParticipantId,
  scenarioPack: ScenarioPack,
) => string;

export type UtilityFn = (
  participantId: ParticipantId,
  finalState: { transcript: Turn[]; outcome: SessionOutcome; pack: ScenarioPack },
) => number;

export type AgreementDetectorFn = (state: {
  transcript: Turn[];
  pack: ScenarioPack;
}) => boolean;

export type CustomMetricsFn = (state: {
  transcript: Turn[];
  outcome: SessionOutcome;
  pack: ScenarioPack;
}) => Record<string, number>;
