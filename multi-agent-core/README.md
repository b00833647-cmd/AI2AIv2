# multi-agent-core

A portable, context-agnostic spec for building a **multi-agent LLM dialogue runtime**. Drop this folder into any project and use it as the design + planning artifact for an engine that can run negotiations, debates, deliberations, role-plays, and any other multi-agent dialogue scenario without engine-level code changes.

## The big idea (one paragraph)

N programmable LLM agents take turns under the supervision of a sixth LLM — the **Orchestrator** — which decides whose turn is next, when agreement has been reached, when to inject a moderator note, and when to terminate. Domain knowledge lives in user-supplied **Scenario Packs** (participants, decision space, agreement criteria, utility math). The engine itself is domain-neutral. Same engine: car-sale negotiation, three-way debate, four-party policy consensus, code review, treaty drafting — all become Scenario Packs. The orchestrator's decisions are themselves structured tool calls, fully logged, replayable.

## What you can build with this

- A **research platform** for studying how LLMs interact in multi-agent settings — varying strategies, models, scenarios, orchestrator skill.
- A **product** for any workflow that benefits from structured multi-agent dialogue: deliberation tools, debate tutors, negotiation simulators, group decision support, classroom role-play.
- An **adversarial testing harness** for red-teaming agents against each other in controlled scenarios.
- A **drop-in orchestration layer** for an existing agent codebase that needs N-party coordination.

## How to use this in a new project

1. **Copy this folder** to the root of your target project (or `docs/multi-agent-core/`).
2. **Open Claude Code** in that project's root directory.
3. **Start a new chat.** Claude Code will auto-load `CLAUDE.md`, which orients the AI to the spec and current status.
4. **Tell the AI what you want.** Examples:
   - "Implement the minimum viable version in TypeScript using the Anthropic SDK."
   - "Implement this in Python with OpenAI."
   - "I want to refine the orchestrator design before implementing — let's discuss alternatives."
   - "Build the buyer-seller scenario from `examples/` end-to-end first."
5. **Update STATE.md** when you stop. The next chat picks up cleanly.

The spec is opinionated about *what* to build, not *how* to build it. Stack, language, persistence layer, UI — all up to you.

## Folder map

| File | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Auto-loaded by Claude Code. Orients new chats. **Read first if you're an AI.** |
| [README.md](README.md) | This file. Human entry point. |
| [STATE.md](STATE.md) | Session-to-session progress tracker. Update on session end. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layer diagram, components, data flow, persistence schema. |
| [ORCHESTRATOR.md](ORCHESTRATOR.md) | Detailed design for the LLM Orchestrator agent. |
| [SCENARIOS.md](SCENARIOS.md) | Scenario Pack specification. |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Build guide: minimum viable version, phasing, what to defer. |
| [types/core.ts](types/core.ts) | TypeScript reference type sketches. Translate to host language as needed. |
| [prompts/orchestrator-system.md](prompts/orchestrator-system.md) | Reference system prompt for the LLM Orchestrator. |
| [prompts/orchestrator-tools.md](prompts/orchestrator-tools.md) | JSON schemas for the 5 orchestrator tools. |
| [examples/buyer-seller-negotiation.json](examples/buyer-seller-negotiation.json) | 2-party negotiation Scenario Pack. |
| [examples/three-party-debate.json](examples/three-party-debate.json) | 3-party debate (Pro / Con / Judge). |
| [examples/consensus-deliberation.json](examples/consensus-deliberation.json) | 4-party consensus deliberation. |

## Design invariants (non-negotiable)

These are the seven things that make this design what it is. Removing any one breaks the model.

1. **`ParticipantId = string`** — never a literal union of role names. Roles are free-form labels.
2. **The engine has zero domain knowledge.** All domain words live inside Scenario Packs.
3. **Every orchestrator decision is a structured tool call.** Five tools, no free-form output.
4. **Strict isolation between participants.** No shared memory, no direct invocation. Only the orchestrator mediates.
5. **Public channel = natural language.** Structured tool-call data is private to the emitter and the engine; only the prose `message` field crosses to other participants.
6. **Deterministic fallback.** Round-robin protocol kicks in if the orchestrator fails 3× consecutively. Sessions never deadlock.
7. **Reproducibility.** Pinned model versions, temperature 0 for orchestrator, full decision logs enable record/replay.

If you build something that violates any of these, you've built something different. That may be fine — but call it out explicitly so the design isn't quietly diluted.

## Status

Specification complete. Implementation: **see [STATE.md](STATE.md)** for the host project's current state.

## License / reuse

Drop this folder into any project, modify freely, share with colleagues. No attribution required, no warranties given.
