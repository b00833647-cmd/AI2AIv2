/**
 * core-v2 type sketches.
 *
 * NOT FOR RUNTIME USE. These are the proposed types for the v2 core, written
 * here for design review. The implementation lives elsewhere (Phase 1 of the
 * migration plan); this file is documentation.
 */

// ─── Identity ──────────────────────────────────────────────────────────────

export type ParticipantId = string;       // free-form, e.g. "alice", "team_red"
export type SessionId = string;
export type TurnId = string;

// ─── Participant (programmable agent shell) ────────────────────────────────

export interface Participant {
  id: ParticipantId;
  role: string;                            // free-form label, NOT a literal union

  llm: LLMConfig;

  /** Mustache-like template; placeholders interpolated from `brief`. */
  systemPromptTemplate: string;

  /** Opaque to the engine. The system prompt template references it. */
  brief: Record<string, unknown>;

  /** What other participants can see in the roster. */
  publicProfile?: Record<string, unknown>;

  /** Action vocabulary available to this participant. */
  tools: ToolDefinition[];

  /** What this participant emits that the orchestrator considers structured. */
  outputSchema?: JSONSchema;

  memoryPolicy?: MemoryPolicy;

  /** Optional module path for a function: (transcript, participantId) => filtered transcript */
  contextFilterModule?: string;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | string;
  model: string;                           // pinned, e.g. "claude-sonnet-4-6"
  temperature?: number;
  thinkingBudget?: number;
  maxTokens?: number;
  apiKeyEnv?: string;                      // env var name for the key
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export type MemoryPolicy =
  | { type: "verbatim" }
  | { type: "summarized"; keepRecent: number; maxContextTokens: number }
  | { type: "external"; storeKey: string }
  | { type: "none" };

// ─── Decision space ────────────────────────────────────────────────────────

export interface DecisionSpace {
  freeText: boolean;
  slots?: DecisionSlot[];
}

export type DecisionSlot =
  | { name: string; type: "number"; range: [number, number]; unit?: string }
  | { name: string; type: "enum"; options: string[] }
  | { name: string; type: "boolean" }
  | { name: string; type: "text"; maxLength?: number }
  | { name: string; type: "json"; schema: JSONSchema };

// ─── Protocol hints (orchestrator reads these) ─────────────────────────────

export interface ProtocolHints {
  maxTurns: number;
  maxRounds?: number;
  deadlineMs?: number;
  speakingOrder?: "round-robin" | "alternating" | "free";
  orchestratorMode?: "default" | "lazy" | "eager" | "decimated";
  decimationK?: number;
  permittedOutcomes: string[];             // e.g. ["agreed", "impasse", "timeout"]
  maxOrchestratorTokens?: number;
  maxParticipantTokensPerTurn?: number;
}

// ─── Scenario Pack ─────────────────────────────────────────────────────────

export interface ScenarioPack {
  id: string;
  version: string;                         // semver
  name: string;
  description: string;                     // 1-2 paragraphs

  participants: Participant[];

  decisionSpace: DecisionSpace;

  protocolHints: ProtocolHints;

  /** Prose, given to orchestrator system prompt. */
  agreementCriteria: string;

  /** Optional fast-path detector: module path to a (state) => boolean. */
  agreementDetectorModule?: string;

  /** Optional per-participant utility: module path to (participantId, finalState) => number. */
  utilityModule?: string;

  /** Optional custom metrics: module path to (state) => Record<string, number>. */
  customMetricsModule?: string;

  /** Optional UI plugin paths. */
  ui?: { observer?: string; setup?: string };
}

// ─── Turns ─────────────────────────────────────────────────────────────────

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;
  emitter: "participant" | "orchestrator";
  emitterId: ParticipantId | "orchestrator";

  toolCalls: ToolCall[];                   // structured actions

  message?: string;                        // public natural language
  thinking?: string;                       // private to emitter

  tokens: TokenUsage;
  latencyMs: number;
  model: string;
  timestamp: string;                       // ISO 8601
}

export interface ToolCall {
  name: string;
  input: unknown;                          // validated against the tool's inputSchema
}

export interface TokenUsage {
  input: number;
  output: number;
  thinking?: number;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export interface OrchestratorState {
  sessionId: SessionId;
  scenarioPack: ScenarioPack;
  transcript: Turn[];
  decisions: OrchestratorDecision[];

  phase: "setup" | "running" | "paused" | "ended";

  budget: {
    maxTurns: number;
    maxTokens: number;
    maxOrchestratorTokens: number;
    deadline?: string;
  };
  consumed: {
    turns: number;
    tokensTotal: number;
    tokensOrchestrator: number;
  };
}

export interface OrchestratorDecision {
  turnNumber: number;
  toolCall: ToolCall;
  rationale?: string;
  timestamp: string;
}

/** The fixed set of orchestrator tool names. */
export type OrchestratorToolName =
  | "request_turn"
  | "broadcast_to"
  | "declare_outcome"
  | "compress_context"
  | "pause";

// ─── Outcome ───────────────────────────────────────────────────────────────

export interface SessionOutcome {
  type: string;                            // scenario-defined, must be in permittedOutcomes
  summary: string;
  terms?: Record<string, unknown>;         // matches DecisionSpace slots
  rationale: string;
  participantUtilities?: Record<ParticipantId, number>;
  customMetrics?: Record<string, number>;
  endedAt: string;
}

// ─── Request/response messages between actors ──────────────────────────────

export type ActorMessage =
  | { type: "RequestTurn"; participantId: ParticipantId; instruction?: string; contextOverride?: string; round: number }
  | { type: "ParticipantTurnReady"; turn: Turn }
  | { type: "ParticipantTurnFailed"; participantId: ParticipantId; error: string; retryCount: number }
  | { type: "OrchestratorDecisionReady"; decision: OrchestratorDecision }
  | { type: "BroadcastToParticipants"; audience: ParticipantId[] | "all"; message: string }
  | { type: "DeclareOutcome"; outcome: SessionOutcome }
  | { type: "PauseRequest"; reason: string }
  | { type: "ResumeRequest" }
  | { type: "AbortRequest"; reason: string };

// ─── Helpers ───────────────────────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

/**
 * The function signature a contextFilter module must export.
 * It receives the raw transcript and returns the slice/transformation
 * this participant should see for its next turn.
 */
export type ContextFilterFn = (
  transcript: Turn[],
  participantId: ParticipantId,
  scenarioPack: ScenarioPack
) => string;

/**
 * The function signature a utility module must export.
 */
export type UtilityFn = (
  participantId: ParticipantId,
  finalState: { transcript: Turn[]; outcome: SessionOutcome; pack: ScenarioPack }
) => number;

/**
 * The function signature an agreementDetector module must export.
 * Returns true if the orchestrator should be invoked to confirm
 * and produce structured terms. Conservative: false-negatives
 * are fine (orchestrator still gets called normally).
 */
export type AgreementDetectorFn = (state: {
  transcript: Turn[];
  pack: ScenarioPack;
}) => boolean;
