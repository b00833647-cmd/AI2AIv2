# Scenario Packs

A Scenario Pack is a self-contained spec that tells the engine everything it needs to run a session. Same engine, different packs → different research domains.

## The shape

```ts
interface ScenarioPack {
  // Identity
  id: string;                           // stable identifier for batch runs / replay
  version: string;                      // semver — bump when changing semantics
  name: string;                         // human-readable
  description: string;                  // 1-2 paragraphs — orchestrator reads this

  // Who's playing
  participants: Participant[];          // 2..N agents

  // What's being decided
  decisionSpace: DecisionSpace;

  // Rules of the game
  protocolHints: ProtocolHints;

  // How we know it's over
  agreementCriteria: string;            // prose, given to orchestrator system prompt
  agreementDetector?: string;           // optional: reference to a JS module path
                                        // for fast-path detection before LLM judges

  // Per-participant utility (optional)
  utility?: UtilityFunction | string;   // inline or module path

  // Custom metrics on top of universal ones (optional)
  customMetrics?: string;               // module path

  // UI plugin (optional)
  ui?: { observer: string; setup: string };  // React component paths
}

interface Participant {
  id: string;                           // unique within scenario, e.g. "alice"
  role: string;                         // free-form label, e.g. "Plaintiff" or "Devil's Advocate"
  llm: { model: string; provider: string; thinkingBudget?: number };
  systemPromptTemplate: string;         // Mustache-like placeholders {{role}}, {{brief}}, etc.
  brief: Record<string, unknown>;       // private to this participant — domain-specific JSON
  publicProfile?: Record<string, unknown>;  // visible in roster shared with other participants
  tools: ToolDefinition[];              // what THIS participant can do
  memoryPolicy?: MemoryPolicy;
  contextFilter?: string;               // module path: (transcript, participantId) => string
}

interface DecisionSpace {
  // Free-text by default
  freeText: boolean;

  // Optional structured slots — orchestrator uses these for `declare_outcome.terms`
  slots?: Array<
    | { name: string; type: "number"; range: [number, number]; unit?: string }
    | { name: string; type: "enum"; options: string[] }
    | { name: string; type: "boolean" }
    | { name: string; type: "text"; maxLength?: number }
    | { name: string; type: "json"; schema: JSONSchema }
  >;
}

interface ProtocolHints {
  maxTurns: number;
  maxRounds?: number;
  deadlineMs?: number;
  speakingOrder?: "round-robin" | "alternating" | "free";  // hint to orchestrator
  orchestratorMode?: "default" | "lazy" | "eager" | "decimated";
  decimationK?: number;
  permittedOutcomes: string[];          // e.g. ["agreed", "impasse", "timeout"]
}
```

## How participants are programmable

Each participant is a fully programmable agent shell. Nothing is fixed:

- **System prompt template**: written by the scenario author, with placeholders interpolated from `brief`. Strategy, persona, tone, and goals live here.
- **Tools**: declare what actions this participant can take. A negotiator gets `submit_proposal` + `send_message`. A debater gets `make_argument` + `cite_evidence` + `concede_point`. A coder gets `propose_change`. A voter gets `cast_vote`.
- **Brief**: opaque JSON. The system prompt template references it. The engine never inspects it.
- **Memory policy**: `verbatim` (full history), `summarized` (default), `external` (notes file), or `none`.
- **Context filter**: a function that decides what this participant sees of the transcript. Default: full text channel. Asymmetric games override this.

The engine doesn't know what "negotiation" or "debate" mean. The participants encode the domain in their prompts and tools.

## The agreement question

The orchestrator decides agreement by reading `agreementCriteria` and the transcript. Examples:

- **Negotiation**: `"Both participants explicitly accept the same set of terms, OR one accepts and the other does not respond with a counter within the same round."`
- **Debate**: `"The judge participant declares a winner, OR all sides have presented their final statements."`
- **Consensus**: `"All N participants explicitly agree to the same proposal, OR one or more participants formally object after a final call."`
- **Code review**: `"All reviewers approve, OR a maintainer overrides."`

For speed and reproducibility, scenarios can supply a code-level `agreementDetector` that the engine checks before calling the orchestrator. If it returns `true`, the orchestrator is invoked specifically to confirm and produce structured `terms`. If it returns `false`, the orchestrator may still independently declare agreement.

## The utility question

Two paths:

1. **Code-level utility**: scenario supplies `utility(participantId, finalState) => number`. Used for game-theoretic metrics (Pareto efficiency, joint surplus, Nash distance). Required for negotiation-style research.

2. **LLM-judged utility**: skip the function. The post-session LLM judge scores the outcome on each participant's behalf using the rubric. Used for fuzzy domains (debate quality, consensus health).

Both can run together; the comparison itself is interesting research.

## Three example scenarios

See:
- [examples/buyer-seller-negotiation.json](examples/buyer-seller-negotiation.json) — the current car-sale, ported.
- [examples/three-party-debate.json](examples/three-party-debate.json) — moderator + 2 debaters.
- [examples/consensus-deliberation.json](examples/consensus-deliberation.json) — 4-party consensus with mediator-style orchestrator.

## Authoring guidance

- Keep the `description` rich. The orchestrator reads it as authority.
- Make `agreementCriteria` unambiguous. The orchestrator quotes it back in rationales.
- Pin `model` versions. Don't say `"claude-sonnet-latest"` — say `"claude-sonnet-4-6"`.
- Test in `lazy` orchestrator mode first (cheap), then default mode.
- For new domains, start by writing the participant system prompts as if you were instructing a human role-player. Then declare the matching tools.

## Loading and validation

A pack can be:
- A JSON file in `scenarios/`.
- A TypeScript module that exports `ScenarioPack`.
- A row in a `scenario_packs` table (for dynamic / user-authored scenarios).

The engine validates the pack at session start:
- All participant ids unique.
- All `tools` schemas valid.
- `protocolHints.permittedOutcomes` non-empty.
- `agreementCriteria` non-empty.
- If `decisionSpace.freeText === false`, then `slots` must be defined.
- If `utility` is supplied, it must be loadable.
- All referenced module paths must resolve.

A failed validation prevents session start; the user gets a precise error.

## Versioning

Pack version is part of the session record. Re-running an old session uses the *original* pack version, not the current one. This protects research replicability.

When a pack version changes:
- Old sessions remain comparable to their cohort.
- New sessions use the new version.
- Cross-version comparisons are flagged in the analysis UI.
