# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Scenario Pack (user-supplied JSON / TS / etc.)             │
│  · participants spec  · decision space  · protocol hints    │
│  · agreement criteria  · utility function (opt) · UI (opt)  │
└──────────────────────┬──────────────────────────────────────┘
                       │ loaded once at session start, validated
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Session Runner                                              │
│  · spawns N participant agents from spec                    │
│  · spawns the LLM Orchestrator agent                        │
│  · spawns logger + streamer handlers                        │
│  · wires actor refs                                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   ┌─────────┐    ┌─────────┐    ┌──────────┐   ┌──────────┐
   │Agent #1 │    │Agent #2 │    │ Agent #N │   │Orchestr. │
   │ (LLM)   │    │ (LLM)   │ ...│  (LLM)   │   │  (LLM)   │
   └────┬────┘    └────┬────┘    └────┬─────┘   └────┬─────┘
        │              │              │              │
        └──────────────┴──────┬───────┴──────────────┘
                              ▼
                   ┌────────────────────┐
                   │  Message dispatch  │
                   │  (actor kernel)    │
                   └─────────┬──────────┘
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
         ┌───────────┐             ┌───────────┐
         │  Logger   │             │  Streamer │
         │   (DB)    │             │ (UI/SSE)  │
         └───────────┘             └───────────┘
```

## Component responsibilities

### Scenario Pack (input)

A static spec — JSON, TS module, or whatever the host language supports — that fully describes a runnable scenario:

- **Participants**: id, role label, model, system prompt template, tools, optional private brief, optional context filter.
- **Decision space**: what's being decided. Free-text by default; can declare structured slots (issues with types/ranges/enums) or arbitrary JSON schemas.
- **Protocol hints**: termination conditions, max turns, max tokens budget, expected outcome shape. The orchestrator reads these but is not bound to them.
- **Agreement criteria**: a description (in prose) of what constitutes agreement, plus an optional code-level detector for fast-path detection before invoking the orchestrator.
- **Utility function**: optional — if supplied, the engine computes per-participant utility on completion. If not, only LLM-judge scoring runs.
- **UI plugin**: optional — a component reference for custom observation. Default UI handles all scenarios generically.

### Session Runner

Translates a Scenario Pack into a running session. Owns no domain logic. Stateless beyond the actor system it spawns.

### Participant Agents (1..N)

Each is a programmable shell:

- **Owns**: `id`, system prompt, tool schemas, output validator, memory policy, LLM config, context filter.
- **Receives**: `RequestTurn` from the orchestrator, with the orchestrator-curated context.
- **Emits**: a structured turn (tool calls + optional message + private thinking) to the orchestrator.
- **State**: holds private memory. Never reads other agents' memory.

### LLM Orchestrator

A first-class agent that decides:

- Whose turn is next (`request_turn`).
- What context to give that participant (`request_turn` includes a curated view).
- Whether to inject a moderator note (`broadcast_to`).
- Whether agreement / impasse / abort has occurred (`declare_outcome`).
- Whether to compress an agent's view (`compress_context`).
- When to pause for human input (`pause`).

Has its own LLM, system prompt, and memory of session-level decisions. Sees the full transcript by default; scenario can restrict.

See [ORCHESTRATOR.md](ORCHESTRATOR.md) for full design.

### Actor / Message Layer

Pure message routing. Each agent is an actor; the orchestrator is an actor; logger and streamer are actors. Nothing language-specific — implement with whatever async primitive your host language offers (event loop, async/await, goroutines, threads).

### Logger / Streamer

Side-effect handlers. Persist turns to a database, push events to a UI. Subscribe to orchestrator broadcasts.

## Data flow: one turn

```
1. Orchestrator (LLM) receives: transcript, scenario spec, last completed turn
2. Orchestrator decides next action via a single tool call:
   ├─ request_turn(participant_id, instruction?, context_override?)  → continue
   ├─ broadcast_to(audience, message)                                 → moderator note
   ├─ declare_outcome(type, summary, terms?, rationale)               → end session
   ├─ compress_context(participant_id, summary)                       → manage tokens
   └─ pause(reason)                                                    → wait for human
3. If request_turn:
   a. Orchestrator sends curated context to participant
   b. Participant LLM generates response (tools + message + thinking)
   c. Participant emits ParticipantTurnReady to orchestrator
   d. Orchestrator broadcasts TurnCompleted to handlers
   e. Logger persists turn; streamer pushes to UI
4. Loop back to step 1.
```

The orchestrator runs once per turn. The participant runs once per turn. Cost: 2× the per-turn LLM calls of a deterministic protocol, in exchange for full programmability and semantic agreement detection.

## Type system (sketch)

See [types/core.ts](types/core.ts) for full TypeScript reference. High-level shapes:

```ts
type ParticipantId = string;

interface Participant {
  id: ParticipantId;
  role: string;                      // free-form label, NOT a literal union
  systemPromptTemplate: string;
  tools: ToolDefinition[];
  outputSchema?: JSONSchema;
  memory: MemoryPolicy;
  llm: LLMConfig;
  contextFilter?: (transcript) => string;  // what THIS participant sees
}

interface DecisionSpace {
  freeText: boolean;
  slots?: Array<{ name, type, range?, options?, schema? }>;
}

interface ScenarioPack {
  id: string;
  name: string;
  description: string;
  participants: Participant[];
  decisionSpace: DecisionSpace;
  protocolHints: ProtocolHints;
  agreementCriteria: string;            // prose, given to orchestrator
  agreementDetector?: (state) => boolean;  // optional fast-path
  utility?: (participantId, state) => number;
}

interface OrchestratorState {
  sessionId: string;
  scenarioPack: ScenarioPack;
  transcript: Turn[];
  phase: "setup" | "running" | "paused" | "ended";
  decisions: OrchestratorDecision[];   // its own log
}

interface Turn {
  id: string;
  emitter: "participant" | "orchestrator";
  emitterId: ParticipantId | "orchestrator";
  turnNumber: number;
  toolCalls: ToolCall[];                // structured actions
  message?: string;                     // public natural language
  thinking?: string;                    // private to emitter
  tokens: TokenUsage;
  latencyMs: number;
  timestamp: string;
}
```

## Persistence schema (reference)

Adapt to your DB of choice. SQLite is the simplest; Postgres works fine; in-memory is acceptable for v0.

```sql
sessions(
  id, scenario_id, scenario_pack_json, status,
  started_at, ended_at, outcome_type, outcome_terms_json
)

participants(
  session_id, participant_id, role, model, strategy,
  brief_json, system_prompt
)

turns(
  id, session_id, turn_number,
  emitter ENUM('participant', 'orchestrator'),
  emitter_id,                           -- participant id, or 'orchestrator'
  tool_calls_json, message, thinking,
  tokens_json, latency_ms, model, timestamp
)

outcomes(
  session_id, participant_id, utility, custom_metrics_json
)

api_archives(turn_id, raw_request_json, raw_response_json, model, timestamp)

scores(...)                             -- post-hoc LLM-judge scoring
```

Note: `turns` stores both participant and orchestrator turns. The orchestrator's reasoning is auditable and replayable.

## Isolation properties

- Each participant has its own LLM provider client, system prompt, memory, brief.
- Each participant sees only what its `contextFilter` allows. Default: own messages plus orchestrator-curated views.
- The orchestrator sees the full transcript by default. Its decisions are logged.
- API keys may be per-participant (true isolation) or shared. Either is fine; per-participant is the safer default for research.
- The orchestrator is the only inter-participant channel. No participant can directly invoke another, share state with another, or read another's memory.

## Failure modes & handling

| Failure | Handling |
|---|---|
| Participant LLM error | Retry up to 3, then orchestrator decides (skip turn? abort? declare impasse?) |
| Orchestrator LLM error | Retry up to 3, then fall back to deterministic round-robin protocol; flag session as `degraded` |
| Orchestrator declares invalid outcome (bad type, bad terms shape) | Reject and re-prompt orchestrator with the validation error |
| Orchestrator returns no tool call | Treat as `pause("no decision")` |
| Token budget exhausted | Force `compress_context` or `declare_outcome` |
| Hung session (no progress N rounds) | Hard timeout per session; orchestrator gets a final-decision prompt before forced abort |

## Domain neutrality

The engine, orchestrator, persistence schema, streamer, batch runner — none of these contain the words "buyer", "seller", "negotiation", "price", "offer", "agreement" as anything other than scenario-supplied strings. Every domain term lives inside Scenario Packs.

If you find yourself writing engine code that hardcodes a domain assumption, that's a bug in the design — push it down into the Scenario Pack.
