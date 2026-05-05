# CLAUDE.md — context for Claude Code

> This file is auto-loaded by Claude Code at the start of every chat in this directory. Read it first. It is the entry point.

## What this directory is

A **portable, context-agnostic specification** for a multi-agent LLM dialogue runtime. It is dropped into a host project so that the same engine can run any kind of multi-agent scenario — negotiation, debate, deliberation, multi-party consensus, role-play, adversarial red-teaming, code review — without core code changes.

The user gives the engine a **Scenario Pack** (a JSON or TS file describing participants, decision space, agreement criteria, etc.) and the engine runs it. Domain knowledge lives in the pack. The engine itself never mentions "buyer", "seller", "negotiation", or any specific domain.

The orchestrator that runs each session is itself an **LLM agent** with a fixed set of structured tools. It decides whose turn is next, when agreement has been reached, when to inject a moderator note, and when to terminate.

## Your job, by default

Unless the user says otherwise, your default mode is **implementer**: take this specification and build it in the host project's stack.

- If the host project already has a stack (read `package.json` / `pyproject.toml` / `Cargo.toml` / etc.), match it. TypeScript/Node, Python, Go — pick what's already there.
- If it's a greenfield repo, ask the user once which stack they want, then build.
- The TypeScript types in [types/core.ts](types/core.ts) are reference shapes; translate to the host language as needed.
- The persistence schema in [ARCHITECTURE.md](ARCHITECTURE.md) is SQL-flavored; adapt to whatever DB the host project uses (SQLite, Postgres, DuckDB, or none — in-memory is fine for v0).

If the user instead wants to **refine the spec itself**, work on the docs in this folder. Don't write code in `src/` or wherever — write to the spec.

## Read order (~15 minutes)

1. **[README.md](README.md)** — what this is, the big idea, folder map.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — layer diagram, components, data flow, type system.
3. **[ORCHESTRATOR.md](ORCHESTRATOR.md)** — the LLM Orchestrator agent in depth (state, tools, prompt, failure modes, ablation knobs).
4. **[SCENARIOS.md](SCENARIOS.md)** — the Scenario Pack spec (the user-supplied unit).
5. **[IMPLEMENTATION.md](IMPLEMENTATION.md)** — concrete build plan, minimum viable version, what to defer.
6. **[STATE.md](STATE.md)** — what has been done in this project so far. Read this to pick up where the last session left off.

## Conventions you MUST follow

These are non-negotiable design invariants. Do not violate them without explicit user sign-off:

1. **No domain leakage into the engine.** The words "buyer", "seller", "negotiation", "price", "debate", "consensus" — these may appear ONLY in scenario packs and their referenced modules. Never in `engine/`, `core/`, `runtime/`, or wherever the engine lives. If you find yourself wanting to write `if (role === "buyer")` in core code, stop — that belongs in the scenario.

2. **Participants are programmable shells.** Each participant is identified by a string id (NOT a literal union of role names). Their behavior is fully determined by their `systemPromptTemplate`, `tools`, `brief`, and LLM config. The engine treats them uniformly.

3. **One LLM call per turn per actor.** Each participant turn = 1 call. Each orchestrator decision = 1 call. No silent extra calls from the engine.

4. **Inter-participant channel is mediated.** Participants never directly invoke each other. Only the orchestrator routes context between them. No participant should ever see another participant's private brief, system prompt, or thinking.

5. **Every orchestrator decision is a structured tool call.** No free-form orchestrator output. The 5 tools are: `request_turn`, `broadcast_to`, `declare_outcome`, `compress_context`, `pause`. See [prompts/orchestrator-tools.md](prompts/orchestrator-tools.md).

6. **Deterministic fallback exists.** If the orchestrator fails 3× consecutively, the engine falls back to round-robin and flags the session as `degraded`. The session never gets stuck.

7. **Reproducibility comes first.** Pin model versions in scenario packs. Default temperature 0 for orchestrator. Every orchestrator decision is logged so a session can be replayed.

## Conventions you SHOULD follow

- **Cache the orchestrator system prompt.** It's identical across sessions and across orchestrator invocations within a session. Use the host LLM SDK's prompt caching.
- **Log everything.** Both participant turns and orchestrator decisions go in the same `turns` table with an `emitter` column. Auditability is the point.
- **Validate scenario packs at load time, not run time.** A bad pack should fail fast with a clear error.
- **Default mode = orchestrator runs after every participant turn.** Decimated, lazy, and eager modes are scenario-overridable. Don't optimize prematurely.

## How to leave a session

When you stop work, **update [STATE.md](STATE.md)** with:
- What you did this session (1–3 bullets)
- What's currently done (cumulative checklist — update don't append)
- What's the next concrete next step
- Any open questions or design uncertainties

The next chat reads STATE.md first and picks up cleanly. Without this, every session restarts from scratch.

## Things you should NOT do

- Don't add domain-specific code to the engine. (See convention #1.)
- Don't introduce a new control plane separate from the orchestrator. (One referee.)
- Don't allow participants to communicate via shared globals or files. (One channel: orchestrator.)
- Don't bypass the tool schema for orchestrator output. (Structured only.)
- Don't strip the deterministic fallback. (Always have a way out.)
- Don't change `STATE.md`'s structure without telling the user. (It's a contract between sessions.)

## If anything is ambiguous

Ask the user. Especially:
- Which language/stack to implement in (if greenfield).
- Which LLM provider to default to (Anthropic SDK is the reference, but anything works).
- Whether to persist to disk yet or stay in-memory for v0.
- Whether to build a UI now or later.

## Quick orientation: am I starting fresh or continuing?

```
Run: cat STATE.md
```

- If `Status: not started` → read in the order above, then start with [IMPLEMENTATION.md § Minimum viable version](IMPLEMENTATION.md).
- If `Status: in progress` → STATE.md has the next step. Do that step.
- If `Status: complete` → ask the user what's next. Maybe a new scenario pack, an analysis dashboard, or a new feature.
