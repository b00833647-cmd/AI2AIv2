# AI2AI

> **A web-based research platform for studying how humans delegate negotiation to AI agents.**
> Built on top of the [`multi-agent-core`](multi-agent-core/) spec.

Participants are randomly assigned a role (buyer or seller) in a used-car negotiation. They write a free-text prompt telling their AI agent how to negotiate on their behalf. The system maps that prompt onto a 7-dimensional behavioral profile, runs the negotiation between two AI agents (their side + a randomized opponent) supervised by a third LLM orchestrator, and collects survey responses + behavioral telemetry into a SQLite database for analysis.

---

## Table of contents

- [What this is](#what-this-is)
- [Quick start (local)](#quick-start-local)
- [Architecture](#architecture)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
  - [Railway](#railway)
  - [Fly.io](#flyio)
  - [Docker (any host)](#docker-any-host)
- [Data model](#data-model)
- [Admin dashboard](#admin-dashboard)
- [GDPR / privacy](#gdpr--privacy)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

---

## What this is

A 10-screen participant flow:

| Step | Screen | Notes |
|---|---|---|
| 1 | Role pick | Buyer or seller (in research mode this should be randomized; demo lets the user pick) |
| 2 | IRB consent form | ESSEC consent template, button click = signed consent |
| 3 | Instructions | Scenario framing + roadmap of what's coming |
| 4 | Car listing | Black 2023 Toyota Camry, themed like a real classifieds page with photo gallery |
| 5 | Personal context | Free-text "your situation" |
| 6 | Behavior prompt | Free-text instructions for the AI agent |
| 7 | Live negotiation | Two-sided chat between two AI agents, sticky price ticker, animated outcome reveal |
| 8 | Survey + transcript | 6-Likert + free text on the left, scrollable transcript replay on the right |
| 9 | Demographics | Age, gender, prior experience, AI familiarity, attention check |
| 10 | Thanks | Completion code |

**Behind the scenes:**
- The behavior prompt is mapped to a 7-dim signal vector by Claude Sonnet 4.6 (`mapUserBehavior`).
- The opponent's behavioral profile is randomized per session (uniform over `{-1, 0, +1}` on each dimension).
- The negotiation runs as a turn-by-turn dialogue between two participant agents, with a third orchestrator agent deciding whose turn is next and when the deal is done.
- Every turn, every orchestrator decision, every behavior signal, and every UI event is persisted.

---

## Quick start (local)

**Requirements:** Node.js ≥ 24, an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/<you>/ai2ai.git
cd ai2ai
npm install
cp .env.example .env
# edit .env — set ANTHROPIC_API_KEY at minimum
npx tsx src/server/server.ts
```

Open [http://localhost:3737/study](http://localhost:3737/study) for the participant flow, or [http://localhost:3737/admin](http://localhost:3737/admin) for the dashboard (set `AI2AI_ADMIN_PASSWORD` in `.env` first).

You can also run a session from the CLI without the web UI:

```bash
npm run setup -- --run                    # interactive intake → live negotiation
npm run run -- buyer-seller-negotiation   # spec-example multi-issue negotiation
```

---

## Architecture

```
┌─────────────────────────── Browser ─────────────────────────┐
│  web/study.html                                            │
│  - 10-screen SPA, vanilla HTML/CSS/JS, no build step       │
│  - Live SSE transcript                                     │
│  - Behavioral telemetry tracker (clicks, focus, scroll,    │
│    visibility, idle, paste, …)                             │
└──────────────────────┬─────────────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼─────────────────────────────────────┐
│  Node.js server  (src/server/server.ts)                    │
│  - 7 participant endpoints (/api/p/*)                      │
│  - SSE streaming for live negotiation                      │
│  - /admin dashboard (Basic Auth)                           │
│  - /health for cloud platform checks                       │
│  - Per-IP rate limit + daily LLM cost cap                  │
└─────┬────────────────┬────────────────┬────────────────────┘
      │                │                │
      ▼                ▼                ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│ Engine   │    │  SQLite      │    │ Anthropic    │
│ (multi-  │    │  /data/      │    │ API          │
│ agent-   │    │  sessions.db │    │ (Claude      │
│ core)    │    │              │    │  Sonnet 4.6) │
└──────────┘    └──────────────┘    └──────────────┘
```

The engine in `src/multi-agent/` is a TypeScript implementation of the [`multi-agent-core`](multi-agent-core/) spec — a portable, domain-neutral runtime for multi-agent LLM dialogues. It can run any scenario described as a JSON pack; the participant study is one such scenario (`scenarios/toyota-camry-negotiation`) built from intake answers + the locked stimulus.

---

## Environment variables

See [`.env.example`](.env.example) for the canonical template.

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Required¹ | Single key for all three agents. |
| `BUYER_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode — true API-key isolation. |
| `SELLER_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode. |
| `ORCHESTRATOR_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode. |
| `AI2AI_ADMIN_PASSWORD` | Recommended | Required for `/admin` and `/api/p/erase`. Without it, those endpoints return `503`. |
| `AI2AI_DAILY_BUDGET_USD` | Recommended | Daily LLM-spend cap. When exceeded, `/api/p/run` returns `503 budget_exceeded` until midnight UTC. |
| `AI2AI_DB_PATH` | Optional | SQLite file location. Default `./data/sessions.db`. In Docker, point at a mounted volume. |
| `AI2AI_PORT` | Optional | Default `3737`. |
| `AI2AI_RATE_LIMIT` | Optional | Set to `off` to disable the per-IP rate limit on `/api/p/start` (useful for lab pilots over a single shared IP). |

¹ Either set `ANTHROPIC_API_KEY` (single-key mode) **or** set all three of the per-side keys. The server refuses to start if neither is satisfied.

---

## Deployment

The app is one Node process + one SQLite file. Any platform that can run a Dockerfile and mount a persistent volume works.

### Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app), New Project → Deploy from GitHub → pick your repo.
3. Railway autodetects the [`Dockerfile`](Dockerfile) + [`railway.json`](railway.json).
4. Add a **Volume** mounted at `/data`.
5. Set environment variables in the Railway dashboard:
   - `ANTHROPIC_API_KEY=sk-ant-...`
   - `AI2AI_ADMIN_PASSWORD=<long-random>`
   - `AI2AI_DAILY_BUDGET_USD=20`
   - `AI2AI_DB_PATH=/data/sessions.db`
6. Generate a public domain (Settings → Networking → Generate Domain).
7. Open `https://<your-app>.up.railway.app/study`.

### Fly.io

```bash
fly launch --no-deploy             # creates the app, edit fly.toml
fly volumes create data --size 1   # 1GB persistent volume
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  AI2AI_ADMIN_PASSWORD=long-random \
  AI2AI_DAILY_BUDGET_USD=20
fly deploy
fly open                           # opens your live URL
```

[`fly.toml`](fly.toml) is pre-configured to mount the volume at `/data`, force HTTPS, and run a `/health` check every 30 s.

### Docker (any host)

```bash
docker build -t ai2ai .
docker run -d --name ai2ai \
  -p 3737:3737 \
  -v $(pwd)/data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e AI2AI_ADMIN_PASSWORD=change-me \
  -e AI2AI_DAILY_BUDGET_USD=20 \
  -e AI2AI_DB_PATH=/data/sessions.db \
  ai2ai
```

The container has a built-in `HEALTHCHECK` against `/health`, so `docker ps` shows the health status.

---

## Data model

Everything lives in one SQLite file at `AI2AI_DB_PATH`. Tables:

| Table | Rows-per | Contains |
|---|---|---|
| `study_participants` | 1 per participant | id, role, demographics, consent flag, attention check, browser/OS/timezone/language, completion code, finished_at, link to engine session |
| `behavior_prompts` | 1+ per participant (per revision) | the free-text prompt, mapped 7-dim signals, residual notes, optional manipulation-check rating |
| `participant_responses` | many per participant (long format) | survey Likerts, free text, time-on-screen, opponent's randomized signals, personal context |
| `participant_events` | many per participant | click / focus / blur / scroll / visibility / idle / paste / resize / etc. — full behavioral telemetry |
| `sessions` | 1 per negotiation | full pack JSON (incl. both system prompts + opponent signals), outcome, total tokens, status |
| `participants` | 2 per session | per-agent brief + system prompt as actually sent |
| `turns` | many per session | every agent turn — tool calls, message, thinking, tokens, latency |
| `orchestrator_decisions` | many per session | every routing decision the orchestrator made |
| `outcomes` / `scores` | optional | utility scores, LLM-as-judge ratings |

Pull data into R / Stata / Python with one query — the participant id ties everything together. Per-participant JSON export endpoint: `GET /api/p/export?id=<participantId>`.

---

## Admin dashboard

Available at `/admin` (Basic Auth — username doesn't matter, password is `AI2AI_ADMIN_PASSWORD`):

- **Overview** — total participants, finished count, drop-off rate, total tokens, estimated $ spent
- **Funnel** — bar per step showing how many participants reached it, with named steps
- **Participants table** — id, role, status, outcome, final price, tokens, total time, last screen reached, event count, computed flags (speeding / attention-fail / short-prompt), completion code
- **Search box** — filter by id / role / outcome / completion code
- **Per-participant detail** — click any id for: demographics, all prompt revisions with their mapped signals, personal context, full survey responses, full negotiation transcript, event count by type, action buttons to download the full JSON export or GDPR-erase the participant

Computed flags shown in the table:
- **speed** — finished in under 90 seconds (very fast)
- **attn** — failed the attention check on the demographics page
- **short** — wrote a behavior prompt under 80 chars (low effort)

---

## GDPR / privacy

This codebase is designed to be deployable in the EU (ESSEC) without painful retrofitting:

- **No PII collected by default.** Participant IDs are random nanoids. Names, emails, IP addresses are not stored. The `external_id` column is reserved for Prolific/MTurk reconciliation if needed — leave null otherwise.
- **IP-based rate limiting hashes the IP** with a daily-rotating salt before storing it in memory; the raw IP never touches disk.
- **Right-to-access:** `GET /api/p/export?id=<participantId>` returns a single JSON file with everything tied to that participant — survey, prompt, transcript, events, the lot.
- **Right-to-erasure:** `DELETE /api/p/erase?id=<participantId>` (admin auth) cascades through every table including the linked engine session.
- **Free-text fields** (`personal_context`, behavior prompts, free-text survey response) can contain anything participants type. Note this in your IRB application; consider a profanity / PII scrub before publishing the dataset.
- **Consent timestamp + version** are captured on screen 2.

---

## Testing

```bash
npm run typecheck                    # tsc --noEmit
npx tsx src/cli/smoke.ts             # 21-test smoke suite, no API key needed
```

The smoke test exercises scenario validation, orchestrator tool-call validation (including bad-terms rejection), round-robin fallback selection, memory rendering, and SQLite schema initialization. CI runs both on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

For an end-to-end test with real LLM calls, set the API keys in `.env` and walk through `http://localhost:3737/study` — one full participant costs ~$0.40 of Sonnet 4.6 tokens.

---

## Repository layout

```
.
├── src/
│   ├── multi-agent/         # Engine — implementation of multi-agent-core spec
│   │   ├── types.ts
│   │   ├── llm.ts           # Anthropic SDK wrapper with prompt caching
│   │   ├── orchestrator.ts  # Orchestrator agent (5-tool runtime + validator)
│   │   ├── participant.ts   # Participant agent runtime
│   │   ├── session-runner.ts# Main loop + onEvent hooks for live UI streaming
│   │   ├── pack-builder.ts  # Builds the Toyota Camry scenario from intake
│   │   ├── behavior-mapper.ts # Free text → 7-dim signal vector via Claude
│   │   ├── persistence.ts   # SQLite schema + helpers
│   │   ├── memory.ts        # Per-participant transcript views
│   │   ├── fallback-protocol.ts
│   │   ├── scenario-loader.ts
│   │   └── judge.ts         # LLM-as-judge scoring
│   ├── cli/                 # Command-line tools (run / batch / replay / judge / setup / smoke)
│   └── server/server.ts     # HTTP + SSE server
├── web/
│   ├── study.html           # 10-screen participant SPA
│   ├── admin.html           # Researcher dashboard
│   ├── index.html           # Original AI-vs-AI demo
│   └── img/camry/           # Listing photos (Wikimedia Commons CC BY-SA)
├── scenarios/
│   └── toyota-camry-negotiation/
│       └── pack.json        # Regenerated per session — git-ignored
├── multi-agent-core/        # The portable spec this engine implements
│   ├── README.md  ARCHITECTURE.md  ORCHESTRATOR.md  SCENARIOS.md
│   ├── IMPLEMENTATION.md  STATE.md  CLAUDE.md
│   ├── types/core.ts
│   ├── prompts/
│   └── examples/            # Reference scenario packs
├── Dockerfile
├── railway.json
├── fly.toml
├── .env.example
├── .github/workflows/ci.yml
├── LICENSE
└── README.md (this file)
```

---

## Credits

- Listing photos: Wikimedia Commons, CC BY-SA 4.0 (2019 Toyota Camry XV70, East Surabaya).
- Multi-agent runtime spec: `multi-agent-core/` in this repo.
- Built with [Claude Sonnet 4.6](https://www.anthropic.com/) via the Anthropic SDK.

---

## License

[MIT](LICENSE) © Faraz Ghodratizadeh.
