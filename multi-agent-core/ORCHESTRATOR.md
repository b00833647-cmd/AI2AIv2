# LLM Orchestrator — design

The orchestrator is itself an LLM agent. It owns no domain knowledge — it reads the scenario pack, observes turns, and decides what happens next via a fixed set of tools.

## Why an LLM orchestrator

A deterministic state machine handles 2-party alternating turn-taking with structural agreement detection cleanly, but breaks down for:

- **N-party scenarios** where speaking order isn't fixed (free-for-all, moderated, weighted).
- **Semantic agreement** ("Deal." / "OK fine, I accept" / "I'll take it" — none match `action === "accept"`).
- **Adaptive intervention** — knowing when to inject "you've been talking past each other" or "could one of you summarize where you stand?".
- **Domain-specific termination** — debate ends on time/quality, deliberation ends on consensus, role-play ends on goal completion.
- **Context compression decisions** — when to summarize a particular participant's view to fit budget.

A general-purpose LLM with a clear system prompt and structured tools handles all of these uniformly.

## What the orchestrator owns

```ts
interface OrchestratorState {
  sessionId: string;
  scenarioPack: ScenarioPack;       // the rules of the game
  transcript: Turn[];                // every participant turn so far
  decisions: OrchestratorDecision[]; // its own action log
  phase: "setup" | "running" | "paused" | "ended";
  budget: {                          // hard caps
    maxTurns: number;
    maxTokens: number;
    maxOrchestratorTokens: number;
    deadline?: string;
  };
  consumed: {                        // running totals
    turns: number;
    tokensTotal: number;
    tokensOrchestrator: number;
  };
}
```

It does **not** own:
- Participant memories (private to each participant).
- Domain utility math (delegated to the scenario pack).
- The DB or the SSE stream (those are handler actors that subscribe to its broadcasts).

## What the orchestrator sees each step

A single string prompt assembled from:

1. **Static section** (cached for the whole session via Anthropic prompt caching):
   - Scenario name + description
   - Participant roster (id, role, public profile)
   - Decision space spec
   - Agreement criteria (prose)
   - Termination conditions
   - Tool documentation

2. **Dynamic section** (changes each turn):
   - Phase + round/turn counters
   - Recent transcript (full or summarized to fit budget)
   - Recent participant tool calls and messages
   - Budget consumption so far
   - Any pending operator commands (pause/resume from a human)

The orchestrator's own prior decisions are visible to it, so it remembers "I asked Alice to summarize last turn, so now I should let Bob respond."

## Tools the orchestrator can call

Exactly one tool call per orchestrator invocation. Tools:

### `request_turn(participant_id, instruction?, context_override?)`
Ask a participant to take the next turn.
- `participant_id`: must be in the roster.
- `instruction` (optional): a system-injected hint added to the participant's user message ("be specific about your offer", "respond in under 100 words", "address Bob's last point").
- `context_override` (optional): a curated transcript slice — useful for asymmetric info or compressed views.

### `broadcast_to(audience, message)`
Inject a moderator note visible to listed participants on their next turn.
- `audience`: array of participant ids, or `"all"`.
- `message`: prose. Appears as a `[Moderator]:` prefix in the participant's user message.

### `declare_outcome(type, summary, terms?, rationale)`
End the session.
- `type`: scenario-defined string (e.g. `"agreed"`, `"impasse"`, `"timeout"`, `"consensus"`, `"vote_passed"`).
- `summary`: short prose summary for humans.
- `terms` (optional): structured final outcome conforming to the decision space.
- `rationale`: why this outcome was declared, citing transcript turns.

### `compress_context(participant_id, summary)`
Replace older turns in a participant's context with a summary on the next request_turn.
- Used proactively when a participant's context is approaching budget.

### `pause(reason)`
Stop. Wait for human resume. Used when:
- The orchestrator detects deadlock.
- A human-trigger flag is set.
- The orchestrator wants confirmation before declaring outcome.

## Output format

Each invocation produces:
- One `tool_use` block (the action).
- An optional `thinking` block (private to the orchestrator, logged for audit).
- An optional `message` block (a public commentary that appears in the transcript as an orchestrator turn — useful for the observer UI but never sent to participants).

## Decision frequency

By default, the orchestrator is invoked **after every participant turn**. Each turn = 1 participant LLM call + 1 orchestrator LLM call.

Optimizations available per scenario:
- **Decimation**: only consult orchestrator every K turns; let a deterministic round-robin fall through in between.
- **Lazy mode**: orchestrator runs only on signals (participant declared agreement, budget low, deadlock detected).
- **Eager mode**: orchestrator runs before AND after each turn (twice per turn) — for adversarial scenarios where its judgment matters most.

The session config picks the mode.

## Cost & latency analysis

For a typical 10-turn session:

| Mode | Participant calls | Orchestrator calls | Cost mult |
|---|---|---|---|
| Deterministic protocol (no LLM orchestrator) | 10 | 0 | 1.0× |
| Default mode | 10 | 10 | 2.0× |
| Decimated (K=3) | 10 | 4 | 1.4× |
| Lazy mode | 10 | 1–2 (start/end only) | 1.1× |
| Eager mode | 10 | 20 | 3.0× |

Latency: each turn now has serial `participant + orchestrator` round-trips. Mitigation: orchestrator can run in parallel with the *next* participant call when its decision is "request_turn(next_participant)" — but only after the first decision. Net per-turn latency ~+1× orchestrator response time.

## Failure modes & fallbacks

| Failure | Behavior |
|---|---|
| Orchestrator LLM error | Retry up to 3 with exponential backoff |
| Orchestrator hits retry cap | Fall back to **deterministic round-robin** protocol; mark session `degraded`; continue |
| Orchestrator returns invalid tool call (bad participant id, malformed args) | Reject, re-prompt with error message inline, retry |
| Orchestrator returns no tool call | Treat as `pause("no decision")` |
| Orchestrator declares outcome with terms that don't match decision space schema | Reject, re-prompt |
| Budget exhausted before orchestrator can act | Forced `declare_outcome("timeout", ...)` with last known state |

The session never gets stuck because there's always a deterministic fallback path.

## Determinism & reproducibility

LLM orchestrators are non-deterministic. For research replicability:

- **Temperature 0** by default for orchestrator calls.
- **Seed the LLM** when supported by the provider.
- **Record/replay**: every orchestrator decision is logged in the `turns` table with `emitter='orchestrator'`. A replay mode reads decisions from a prior session instead of calling the LLM, allowing exact transcript reproduction with different participant configurations (counterfactuals).
- **Pin model version** in the scenario pack so a session's behavior doesn't drift when models update.

## Bias & ablation

Because the orchestrator is itself an LLM, its choices affect outcomes. Research questions become:

- Does orchestrator model size correlate with joint surplus?
- Does an orchestrator from the same family as participants behave differently than a different family?
- What happens with a deliberately biased orchestrator prompt?

The matrix-mode batch runner extends naturally:

```
buyer_strategy × seller_strategy × orchestrator_model × scenario × N runs
```

This is one of the main research payoffs of the design.

## Sample system prompt

See [prompts/orchestrator-system.md](prompts/orchestrator-system.md). The prompt instructs the orchestrator to:

- Treat the scenario pack as authoritative for goals and termination.
- Be concise — its commentary is overhead.
- Default to letting participants drive; intervene only on stall, drift, or to confirm agreement.
- Never inject information from one participant's brief into another's view.
- Cite specific turns when declaring outcomes.

## What the orchestrator must NOT do

- Reveal a participant's private brief to another participant.
- Make moves on a participant's behalf.
- Modify the scenario pack mid-session.
- Compute utility (that's the scenario pack's job).
- Talk to itself across sessions (each session is fresh).

These are enforced by the tool schema (no tool exposes private briefs) and by the system prompt (explicit prohibitions).
