# CLAUDE.md — AI2AI host project

> Auto-loaded by Claude Code when you open this directory. Read this first.

## What this repo is

A working TypeScript implementation of the [`multi-agent-core`](multi-agent-core/) spec — a portable, domain-neutral runtime for multi-agent LLM dialogues. The participant-facing build is a **10-screen web study** where a human writes prompts for an AI agent that negotiates a used-car deal on their behalf, while watching the negotiation play out against a randomized opponent agent.

The full project README is in [README.md](README.md). This file is a quick orientation for a new chat in this repo.

## Status (mirror of [multi-agent-core/STATE.md](multi-agent-core/STATE.md))

`complete` — engine is built, web UI is built, persistence is built, deployment artifacts are in place. Repo is publishable to GitHub as-is.

## Architecture (one paragraph)

The Node.js server (`src/server/server.ts`) serves the participant SPA (`web/study.html`) and the admin dashboard (`web/admin.html`), exposes `/api/p/*` endpoints for the participant flow, runs the negotiation engine (`src/multi-agent/`) via SSE, and persists everything to SQLite (`src/multi-agent/persistence.ts`). The engine is a portable implementation of the [`multi-agent-core`](multi-agent-core/) spec — three LLM agents (buyer, seller, orchestrator) talk to each other through a structured tool-call protocol.

## File map

| Path | Purpose |
|---|---|
| [src/multi-agent/](src/multi-agent/) | Engine (multi-agent-core impl) — types, llm wrapper, orchestrator, participant runtime, session runner, behavior mapper, pack builder, persistence |
| [src/server/server.ts](src/server/server.ts) | HTTP + SSE server; `/api/p/*` endpoints, `/admin`, `/health` |
| [src/cli/](src/cli/) | CLIs — `run`, `batch`, `replay`, `judge`, `setup`, `smoke` |
| [web/study.html](web/study.html) | 10-screen participant SPA (HTML + CSS + JS, no build step) |
| [web/admin.html](web/admin.html) | Researcher dashboard |
| [scenarios/](scenarios/) | Pack JSONs (most regenerated per session — git-ignored) |
| [multi-agent-core/](multi-agent-core/) | The portable spec this engine implements |
| [Dockerfile](Dockerfile), [railway.json](railway.json), [fly.toml](fly.toml) | Deployment configs |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI: typecheck + smoke test on every push |

## How to leave a session

Update [multi-agent-core/STATE.md](multi-agent-core/STATE.md) with the latest session note + checked-off items. Don't break the file's structure.

## Things to NOT do (carry-forward from spec invariants)

- Don't add domain words ("buyer", "seller", "price") to `src/multi-agent/` — they belong in scenario packs.
- Don't introduce a control plane separate from the orchestrator. One referee.
- Don't let participants share state via globals or files. Only through orchestrator-curated context.
- Don't strip the round-robin fallback or the validation retries.
- Don't commit secrets. The `.env` file is git-ignored; check `.env.example` for the canonical template.

## Common commands

```bash
# Local dev — assumes ANTHROPIC_API_KEY in .env
npx tsx src/server/server.ts          # start the server (also via npm run serve)
npm run typecheck                     # tsc --noEmit
npx tsx src/cli/smoke.ts              # smoke test (no API key needed)
npm run setup -- --run                # one-off interactive negotiation
npm run batch -- buyer-seller-negotiation --runs 5 --concurrency 2

# Deploy
docker build -t ai2ai .               # see Dockerfile
fly deploy                            # see fly.toml
```

## Participant routes (study.html)

| Route | Mode | Who types |
|---|---|---|
| `/blx` | agent buyer (delegated) | Participant writes a behavior prompt; AI buyer agent negotiates against AI seller agent |
| `/slx` | agent seller (delegated) | Same, with participant on the seller side |
| `/bhx` | human buyer (direct chat) | Participant types directly, AI seller agent on the other side |
| `/shx` | human seller (direct chat) | Same, with participant typing as the seller |

## Admin API (`/adx/*` and `/admin/*` are aliases — both work)

Auth: HTTP Basic, password from `AI2AI_ADMIN_PASSWORD` env var. Returns 503 if unset.

| Method · Path | Purpose |
|---|---|
| `GET /adx` (or `/admin`) | Renders [web/admin.html](web/admin.html) |
| `GET /adx/data` | Bundle: participants list, demographics, behavior prompts, surveys, events. Used to populate the dashboard tabs |
| `GET /adx/aggregates` | Pre-computed paper-ready cross-tabs (outcome × condition × personality, survey means, daily flow) |
| `GET /adx/p/<id>` | Single participant's full record (all responses, transcript, decisions) — feeds the side detail panel |
| `GET /adx/replay/<sessionId>` | Session timeline: turns interleaved with orchestrator decisions |
| `POST /adx/exclude?id=<participantId>` | Toggle the `excluded` flag (excludes from aggregates) |
| `POST /adx/test-data?id=<participantId>` | Toggle the `test_data` flag (hides by default) |
| `GET /adx/backup` | Download SQLite DB snapshot |
| `GET /adx/export/participants.xlsx` | Flat per-participant XLSX |
| `GET /adx/export/full.xlsx` | Multi-sheet workbook (participants + turns + decisions + surveys + events + agent-log) |
| `GET /adx/export/participants.csv` | CSV variant |
| `GET /adx/export/all.json` | Single JSON dump of everything |
| `GET /adx/export/transcripts.zip` | One TXT per session, zipped |

## Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these | Single-key mode — used for buyer/seller/orchestrator unless overridden |
| `BUYER_ANTHROPIC_API_KEY` | for 3-key isolation | Per-role override; needs all three for true workspace isolation |
| `SELLER_ANTHROPIC_API_KEY` | for 3-key isolation | Same |
| `ORCHESTRATOR_ANTHROPIC_API_KEY` | for 3-key isolation | Same |
| `AI2AI_ADMIN_PASSWORD` | required for `/admin` | HTTP Basic Auth password; if unset, admin returns 503 |
| `AI2AI_PORT` | optional | Defaults to 3737 |
| `AI2AI_DAILY_BUDGET_USD` | optional | Daily LLM cost cap; sessions return 503 once exceeded |
| `AI2AI_DB_PATH` | optional | Defaults to `./data/sessions.db` (mount a volume in production) |
| `AI2AI_RATE_LIMIT` | optional | Set to `off` to disable per-IP throttle on `/api/p/start` |

## SSE event vocabulary (server → client on `/api/p/run`)

| Event | When | Payload |
|---|---|---|
| `session_start` | Session created in engine | `{ sessionId, orchestratorModel }` |
| `status` | Free-form status update | `{ message }` |
| `experiment_mode` | Confirms route mode | `{ mode }` |
| `opponent_personality` | Discloses random pick | `{ role, personality }` |
| `turn_starting` | Engine routed a turn (typing indicator) | `{ participantId, turnNumber }` |
| `human_turn_required` | Engine awaiting `/api/p/turn` | `{ participantId, turnNumber, instruction? }` |
| `turn` | New turn (from agent or human) | `{ turnNumber, emitterId, message, toolCalls, ... }` |
| `offer_update` | Orchestrator-tracked board changed | `{ buyer, seller, spread, source }` |
| `decision` | Orchestrator decision (admin replay) | `{ turnNumber, toolName, input }` |
| `fallback` | Round-robin fallback engaged | `{ reason }` |
| `session_end` | Outcome declared | `{ outcome, degraded, consumed }` |
| `done` | Final marker | `{ sessionId, outcome, consumed, degraded }` |
| `error` | Engine error mid-stream | `{ message }` |
