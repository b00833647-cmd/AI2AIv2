# STATE — current status of multi-agent-core in this project

> Update this file at the end of every working session. Next session reads it first.

## Status

`complete` — engine + participant-study web app shipped, deployment artifacts in place

> Allowed values: `not started` · `spec under review` · `building` · `partially implemented` · `complete` · `paused`

## Last touched

2026-05-06

## Host project context

- **Stack:** TypeScript / Node 24 (ESM, run via `tsx`, no build step)
- **LLM provider:** Anthropic SDK (`@anthropic-ai/sdk` ^0.91), Claude Sonnet 4.6 for all three agents
- **Persistence:** SQLite via `better-sqlite3` (per-machine file, default `./data/sessions.db`, configurable via `AI2AI_DB_PATH`)
- **UI:** Built — vanilla HTML/CSS/JS SPA at `web/study.html` (10-screen participant flow) and `web/admin.html` (researcher dashboard). No framework, no build step.
- **Deployment:** `Dockerfile` + `railway.json` + `fly.toml` ship in repo. CI workflow at `.github/workflows/ci.yml`.

## What's done

_(checklist — update items in place; don't append)_

- [x] Stack chosen
- [x] Core types implemented (`Participant`, `ScenarioPack`, `Turn`, `OrchestratorState`)
- [x] Actor/message kernel (in-process loop in `session-runner.ts`; see open questions)
- [x] LLM provider abstraction (`AnthropicLLMClient` with prompt caching, adaptive thinking, effort)
- [x] Conversation memory implementation (verbatim / summarized / external-stub / none)
- [x] Participant agent runtime
- [x] LLM Orchestrator agent runtime — all 5 tools, validation, retry-on-invalid
- [x] Scenario Pack loader + validator (Zod, fails loudly with precise issues)
- [x] Session runner with `onEvent` hook for live UI streaming (added `turn_starting` event)
- [x] Engine-enforced `firstSpeaker` invariant — buyer must open in buyer-seller scenarios
- [x] Persistence layer (sessions, turns, decisions, outcomes, scores)
- [x] Deterministic round-robin fallback (3-strikes-on-orchestrator → degraded session)
- [x] Replay mode (`src/cli/replay.ts`)
- [x] Batch runner harness (`src/cli/batch.ts` — concurrency, matrix sweeps)
- [x] LLM-as-judge scoring (`src/cli/judge.ts`)
- [x] **Participant-study web app:** 10-screen SPA, 7 `/api/p/*` endpoints, SSE-streamed live negotiation
- [x] **Free-text agent briefing** (replaced 7-axis behavior mapping 2026-05-06): the participant's personal context + behavior prompt are embedded verbatim in their agent's system prompt — no LLM mapping step, no signal numbers
- [x] **Opponent personality library:** 3 pre-written negotiating profiles (`easygoing` | `moderate` | `tough`) with buyer + seller variants; one drawn at random per session, persisted in `participant_responses(screen='engine', key='opponent_personality')`
- [x] **Behavioral telemetry:** `participant_events` table + auto-instrumented client tracker (clicks/focus/blur/scroll/visibility/idle/paste/resize)
- [x] **Browser metadata at start:** viewport, screen, timezone, language, referrer, parsed browser/OS/device class
- [x] **Admin dashboard at /admin** (Basic Auth) — overview stats, funnel, participant table with computed flags, per-participant detail, export + erase actions
- [x] **GDPR endpoints:** `/api/p/export?id=…` (self-service right-to-access), `/api/p/erase?id=…` (admin right-to-erasure with cascade)
- [x] **Production hardening:** `/health` endpoint, SIGTERM graceful shutdown, env validation on boot, per-IP rate limit on `/api/p/start`, daily LLM cost cap on `/api/p/run`
- [x] **Deployment:** Dockerfile, .dockerignore, railway.json, fly.toml — push-to-GitHub-and-deploy ready
- [x] **README + LICENSE + CI** — repo is GitHub-publishable as-is

## What's next

_(the single concrete next step — keep it short, actionable)_

Push to GitHub, deploy to Railway or Fly with the secrets set, generate a public URL. Pilot 3–5 lab-mates as participants on the live URL, inspect their rows in `/admin`, fix anything that surprised you. Then submit IRB + open Prolific recruitment.

## Open questions / design uncertainties

- **Actor kernel choice.** `session-runner.ts` is a synchronous in-process loop, not an actor library. Spec calls for a "Message dispatch (actor kernel)" but for a single-process research rig the loop is simpler. Swap in `worker_threads` if we ever need parallel participants.
- **Per-session 'all' broadcasts.** `enqueueBroadcast(audience='all')` keeps the message in queue across turns; cleared on outcome.
- **Context filter modules.** Scenario packs can declare `contextFilterModule` paths but the engine doesn't dynamically import them yet — every participant currently gets the default public-transcript view.
- **Pause = stop.** The `pause` tool ends the session as outcome `paused` (no human-in-the-loop resume yet).
- **Random-opponent variance vs. controlled design.** Current build randomizes opponent signals per session. Trades experimental control for ecological validity. If you need stratified opponent conditions, add a small extension to assign condition at `/api/p/start` and pass it through to `pack-builder`.

## Recent session notes

_(short log of what each session accomplished — most recent first, ~3 bullets per session)_

### 2026-05-06 — free-text agent briefing (removed 7-axis mapping)

- Replaced behavior-mapper with verbatim text embedding: participant's screen-5 personal context and screen-6 behavior prompt go straight into their agent's system prompt. No LLM round-trip on screen 6 submit (~$0.005 + 2-4s saved per participant).
- Added 3 opponent personalities (`easygoing` | `moderate` | `tough`) with buyer + seller variants in `pack-builder.ts`. One picked at random per session via `pickOpponentPersonality()`, persisted to `participant_responses(screen='engine', key='opponent_personality')`.
- Verified end-to-end via live preview (buyer participant + moderate seller) — agreed at $23,000 in 12 turns. The buyer agent quoted the participant's "relocated to Paris" + "cash buyer" details across 5 of 6 turns; seller stayed in moderate-personality character (mirrored concessions, cited car virtues). Admin dashboard updated to render personality + null-safe legacy signals.

### 2026-05-05 — production-ready release

- Added server hardening: `/health` + SIGTERM graceful shutdown + env validation + per-IP rate limit + daily cost cap.
- Created deployment artifacts: Dockerfile, .dockerignore, railway.json, fly.toml. CI workflow + MIT LICENSE + comprehensive README.
- Final typecheck + smoke tests pass. Repo is GitHub-publishable as-is — clone, set env vars, deploy.

### 2026-05-04 — telemetry layer

- Added `participant_events` table + 11 browser-meta columns on `study_participants` with idempotent migrations.
- Built client-side instrumentation library (auto-listeners for clicks/focus/blur/scroll/visibility/idle/paste/resize) with batched flush + sendBeacon on tab close.
- Added admin dashboard at `/admin` (Basic Auth) with funnel chart, participants table, per-participant detail view, GDPR export/erase actions.

### 2026-05-03 — participant-study web app

- Rebuilt the SPA from a 5-screen demo into a 10-screen participant study (role pick, IRB consent, instructions, themed car listing with real Wikimedia photos, personal context, behavior prompt, live negotiation, survey + transcript log, demographics, thanks).
- Wired the personal context written on screen 5 into the buyer/seller system prompts so the agent actively uses it.
- Switched opponent from fixed-neutral to randomized-per-session with persisted signals.

---

## Conventions for this file

- **Status** is one of the listed values. Don't invent new ones.
- **What's done** is a checkbox list — toggle items, don't add session notes here.
- **What's next** is ONE concrete step. If many things are next, list one and put the others under "Open questions".
- **Recent session notes** is a short log; trim to the last 5 sessions.
- Don't let this file grow beyond ~150 lines.
