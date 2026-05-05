# Implementation guide

A concrete build plan for taking this spec from documentation to running code in a host project. Tech-stack-agnostic; pick the language that matches the host project.

## Before you start

Confirm with the user (if not already in [STATE.md](STATE.md)):

1. **Language / runtime** — TypeScript/Node, Python, Go, Rust, etc.
2. **LLM provider(s)** — Anthropic SDK is the reference, but OpenAI / OpenRouter / Bedrock / local models all work.
3. **Persistence** — SQLite for a single-machine research rig, Postgres for production, in-memory for v0.
4. **UI** — yes / later / never.
5. **First scenario** — pick one of the [examples](examples/) to drive end-to-end first. Buyer-seller is the simplest.

Update [STATE.md](STATE.md) with the choices.

## Minimum viable version

The smallest thing that proves the design works. Aim for this in the first session.

**Scope:**
- 1 scenario (the buyer-seller example).
- 2 participants.
- 1 LLM Orchestrator with 2 of the 5 tools (`request_turn` and `declare_outcome` only).
- No persistence; transcript lives in memory.
- No UI; output goes to stdout.
- No batch runner; one session at a time.

**What you build:**
1. The `Participant`, `Turn`, `ScenarioPack`, `OrchestratorState` types.
2. A simple LLM client wrapper (just enough to call your provider with system + messages + tools).
3. A participant runner: receives a context string, calls the LLM with the tools, returns a structured turn.
4. An orchestrator runner: receives transcript + scenario pack, calls the LLM with the orchestrator system prompt + tools, returns a tool call.
5. A session runner: loops between orchestrator and participants until `declare_outcome`.
6. A scenario loader: reads the JSON file, validates required fields, returns the typed object.
7. A driver: loads the scenario, runs the session, prints the transcript.

**Success criterion:** the buyer-seller scenario runs end-to-end. The orchestrator picks turns, the participants negotiate, the orchestrator declares an outcome with terms. Transcript looks coherent.

## Build phases

### Phase 1 — Minimum viable version (above)

~1–2 days of focused work. Output: a working CLI that runs one scenario.

### Phase 2 — All 5 orchestrator tools

Add `broadcast_to`, `compress_context`, `pause`. Test with the consensus-deliberation scenario, where these tools matter more.

### Phase 3 — Persistence

Wire up the DB. Every participant turn and every orchestrator decision becomes a row. `sessions`, `participants`, `turns`, `outcomes` tables per [ARCHITECTURE.md](ARCHITECTURE.md).

### Phase 4 — Deterministic fallback

When the orchestrator fails 3× consecutively (LLM error or invalid tool call), fall back to a round-robin protocol that just rotates through participants until `maxRounds` or until a participant emits an action that scenario's `agreementDetector` accepts. Mark the session `degraded` in the DB.

### Phase 5 — Replay mode

Add a flag/option to the session runner: instead of calling the orchestrator LLM, read its decisions from a prior session's `turns` table. This enables exact transcript reproduction with different participant configurations (counterfactuals).

### Phase 6 — Batch runner

A CLI that runs N sessions in parallel, varying participant configs across a matrix. Aggregate metrics into a results JSON / DB table. Support concurrency limits (don't blow up your API rate limits).

### Phase 7 — Optional UI

Default observer UI: shows transcript live, highlights orchestrator decisions, allows pause / resume. Scenario-specific UIs override via the `ui.observer` field in the pack.

### Phase 8 — Optional LLM-as-judge scoring

After session ends, a separate LLM call rates each participant's behavior on a fixed rubric (persuasiveness, adaptiveness, fairness, communication quality, etc.). Store in `scores` table.

## What to defer indefinitely

Features that sound nice but rarely justify the cost:

- **Real-time multi-user observation.** Single observer per session is fine for a research rig.
- **Multi-tenancy / accounts.** This is a research artifact; one user is enough.
- **Auth.** Local rig.
- **Distributed execution.** Single-process is fine until you have 1000+ sessions per hour.
- **Scenario hot-reload during a session.** Versioned packs are pinned at session start; change the version, run a new session.

## Recommended dependencies (TypeScript reference)

If you go TypeScript/Node:

```
@anthropic-ai/sdk           // or whichever provider
zod                         // runtime validation of scenario packs
better-sqlite3 + drizzle    // persistence (or skip for v0)
nanoid                      // ids
```

For Python:

```
anthropic                   // or openai
pydantic                    // runtime validation
sqlalchemy + sqlite         // persistence
nanoid                      // ids
```

Keep the dependency surface small. You don't need a framework — this is a few hundred lines of plumbing around LLM calls.

## File layout (suggested, TypeScript)

```
src/
  multi-agent/                  -- the engine
    types.ts                    -- from types/core.ts
    actor.ts                    -- minimal actor/message kernel
    llm.ts                      -- provider abstraction
    memory.ts                   -- conversation memory + summarization
    participant.ts              -- participant runtime
    orchestrator.ts             -- LLM orchestrator runtime
    fallback-protocol.ts        -- deterministic round-robin fallback
    session-runner.ts           -- ties it all together
    scenario-loader.ts          -- JSON / TS module loading + validation
    persistence.ts              -- DB writes (or noop for v0)
    judge.ts                    -- post-session LLM scoring (Phase 8)
  scenarios/                    -- user-supplied packs
    buyer-seller-negotiation/
      pack.json                 -- the Scenario Pack (or pack.ts)
      agreement.ts              -- optional fast-path detector
      utility.ts                -- optional utility function
      ui/                       -- optional UI components
    three-party-debate/
      ...
  cli/
    run.ts                      -- run a single session: tsx cli/run.ts <scenario-id>
    batch.ts                    -- run N sessions in parallel
```

Substitute extensions / module conventions for your language.

## Testing strategy

**Unit tests** for:
- Scenario pack validation (fail loudly on bad packs).
- Memory summarization (does context stay under budget?).
- Tool-call validation (orchestrator can't declare an outcome with a missing required slot).
- Fallback protocol transitions.

**Integration tests** for:
- Run a scenario with a mocked LLM that returns scripted responses. Verify the orchestrator routes correctly, persistence writes correctly, replay reproduces.

**End-to-end tests** for:
- Run the buyer-seller scenario with real LLMs, deterministic seeds, and a small max-turns. Snapshot the transcript. Re-run later: snapshot should match (or be close enough).

Don't test against unmocked LLMs in your normal CI — too slow, too expensive, too flaky. Run E2E manually or in a nightly job.

## Cost & time budget

| Component | Effort (one focused dev) |
|---|---|
| Phase 1 (MVP) | 1–2 days |
| Phase 2 (full tools) | 1 day |
| Phase 3 (persistence) | 1 day |
| Phase 4 (fallback) | 0.5 day |
| Phase 5 (replay) | 1 day |
| Phase 6 (batch) | 1–2 days |
| Phase 7 (UI) | 3–5 days (depends on framework) |
| Phase 8 (judge scoring) | 1 day |
| **Total to fully built** | **~10–15 days** |

Phase 1 alone delivers value. Subsequent phases are independently mergeable.

## When to ask for help

If after a few hours of work in a session you realize:

- A design invariant is in your way → bring it up with the user; don't quietly violate it.
- The Scenario Pack format doesn't fit your domain → propose an extension; the spec is yours to shape.
- The orchestrator is making bad decisions → check the system prompt in [prompts/orchestrator-system.md](prompts/orchestrator-system.md), then check the tool descriptions, then consider that the scenario's `agreementCriteria` may be too vague.
- Latency is unacceptable for an interactive UI → switch the orchestrator to `decimated` or `lazy` mode for that scenario.

Update [STATE.md](STATE.md) before you stop.
