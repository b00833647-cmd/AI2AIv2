# AI2AI — An Apparatus for Studying Human Delegation of Negotiation to AI Agents

> **Research software and replication package for an experimental study of how people instruct, and are represented by, AI negotiation agents.**
> This repository is the apparatus accompanying the study paper (in preparation). It bundles the experimental web platform, the multi-agent negotiation engine, the collected pilot dataset, and a deterministic analysis pipeline.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
&nbsp;![Status](https://img.shields.io/badge/status-research%20pilot-green)
&nbsp;![Engine](https://img.shields.io/badge/runtime-TypeScript%20%2F%20Node%2024-informational)
&nbsp;![Analysis](https://img.shields.io/badge/analysis-Python-informational)

---

## Abstract

As large language models are increasingly deployed as autonomous agents acting *on behalf of* people, a central behavioural question arises: when a person delegates a consequential negotiation to an AI agent, how do they instruct it, how well do they feel represented, and how does the resulting interaction differ from negotiating directly? **AI2AI** is a web-based experimental apparatus that operationalises this question in a controlled used-car negotiation. Participants are assigned to a 2×2 between-subjects design crossing **interaction mode** (delegating to an AI agent vs. negotiating directly against an AI counterpart) with **role** (buyer vs. seller). In delegated conditions, participants author a free-text behavioural brief that is embedded verbatim into their agent's instructions; the negotiation is then conducted as a turn-by-turn dialogue between two LLM agents supervised by a third LLM orchestrator. The platform records negotiation outcomes, a nine-item post-experience survey, fine-grained behavioural telemetry, and the complete interaction and decision logs. This repository contains the platform, a frozen human pilot dataset (N = 40 completers), and a reproducible analysis pipeline that regenerates the reported figures, tables, and reports.

---

## Contents

- [Statement of need](#statement-of-need)
- [System architecture (method)](#system-architecture-method)
- [Experimental design](#experimental-design)
- [Data and reproducibility](#data-and-reproducibility)
- [Ethics and data protection](#ethics-and-data-protection)
- [Installation and usage](#installation-and-usage)
- [Repository structure](#repository-structure)
- [Citation](#citation)
- [License and credits](#license-and-credits)
- [References](#references)

---

## Statement of need

Research on human–AI delegation has largely studied advisory or single-shot decision settings. Multi-turn strategic interaction conducted by an agent *as a delegate* — where a participant's natural-language instructions are the experimental treatment — has lacked an instrument that is simultaneously (i) ecologically plausible, (ii) tightly logged at the level of every turn and every supervisory decision, and (iii) reproducible from raw data to reported result.

AI2AI addresses this gap. It provides a portable, domain-neutral multi-agent dialogue runtime (the bundled `multi-agent-core` specification) wrapped in an instrumented participant-facing study. The same engine can host other structured multi-party scenarios (debate, deliberation, consensus) without engine changes, so the apparatus is reusable beyond the present study. The contribution is threefold: a reusable LLM-orchestrated negotiation engine; a fully instrumented experimental front end with consent, telemetry, and data-subject-rights endpoints; and a deterministic analysis pipeline that turns the resulting database into publication-ready reports.

---

## System architecture (method)

The platform is a single Node.js process serving a vanilla web client and persisting to one SQLite file. The negotiation itself is produced by a three-agent protocol.

```
┌─────────────────────────── Participant (browser) ───────────┐
│  web/study.html                                             │
│  - 10-screen single-page study, no build step              │
│  - Live server-sent-event transcript                       │
│  - Behavioural telemetry (clicks, focus, scroll,           │
│    visibility, idle, paste, …)                             │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼──────────────────────────────────────┐
│  Application server  (src/server/server.ts)                 │
│  - Participant endpoints (/api/p/*), SSE live negotiation   │
│  - Researcher dashboard (/admin, Basic Auth)                │
│  - /health, per-IP rate limit, daily LLM cost cap           │
└─────┬────────────────┬────────────────┬─────────────────────┘
      │                │                │
      ▼                ▼                ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│ Engine   │    │  SQLite      │    │ Anthropic    │
│ (multi-  │    │  one file,   │    │ API          │
│ agent-   │    │  all logs    │    │ (Claude)     │
│ core)    │    │              │    │              │
└──────────┘    └──────────────┘    └──────────────┘
```

**Three-agent protocol.** Each negotiation involves two *participant agents* (the focal side and the counterpart) and one *orchestrator agent*. Participant agents are programmable LLM shells: their behaviour is determined entirely by a system-prompt template, a private brief, a tool set, and a memory policy. The orchestrator is itself an LLM agent that supervises the dialogue through a fixed set of five structured tools — `request_turn`, `broadcast_to`, `declare_outcome`, `compress_context`, `pause` — deciding whose turn is next, when agreement has been reached, and when to terminate. Participants never communicate directly; all context flows through the orchestrator, and no participant observes another's private brief or reasoning.

**Reproducibility invariants.** The engine carries no domain knowledge; the negotiation scenario is supplied as a JSON *scenario pack*. Each participant turn and each orchestrator decision is exactly one logged LLM call. Model identifiers are pinned in the scenario pack and engine configuration (Anthropic Claude, Sonnet/Opus 4.x family, via the Anthropic API). If the orchestrator fails three times consecutively, the engine falls back to deterministic round-robin scheduling and flags the session as `degraded`, so a session never stalls and every session is replayable from its decision log. The full specification is in [`multi-agent-core/`](multi-agent-core/).

---

## Experimental design

**Design.** A 2×2 between-subjects factorial crossing **interaction mode** with **role**:

| | Buyer | Seller |
|---|---|---|
| **Delegated (AI-to-AI)** | participant briefs a buyer agent | participant briefs a seller agent |
| **Direct (Human-to-AI)** | participant negotiates as buyer | participant negotiates as seller |

Condition is assigned by entry route: `/blx` and `/slx` are the delegated buyer and seller conditions; `/bhx` and `/shx` are the direct-chat buyer and seller conditions.

**Stimulus.** A single, locked listing — a black 2023 Toyota Camry, presented as a realistic classifieds page with a photo gallery. Reservation values are predetermined and held uniform across all participants, so the bargaining zone is constant across sessions and conditions.

**Delegation manipulation.** In delegated conditions, the participant writes (a) a free-text personal context describing their situation and (b) a free-text behavioural brief instructing the agent how to negotiate. Both texts are embedded **verbatim** into that participant's agent system prompt; there is no intermediate model that scores or transforms the instructions into latent dimensions. (Earlier versions mapped the brief onto a seven-dimensional signal vector; this step was removed on 2026-05-06 and the corresponding database column is retained only as a legacy artefact.) In direct conditions, the participant types each negotiation turn themselves against an AI counterpart.

**Counterpart.** The opposing agent is drawn uniformly at random, per session, from a library of three hand-authored negotiating personalities — `easygoing`, `moderate`, and `tough` — each with buyer and seller variants. The drawn personality is persisted with the session. Randomising the counterpart trades a degree of experimental control for ecological validity; a stratified-counterpart variant can be added at session start if controlled counterpart conditions are required.

**Procedure (participant-facing flow).** Ten screens: (1) condition/role assignment via entry route; (2) IRB consent (ESSEC template; timestamp and version recorded); (3) instructions; (4) vehicle listing; (5) personal context; (6) behavioural brief (delegated) or entry into direct chat; (7) live negotiation with a running price indicator and animated outcome reveal; (8) post-experience survey alongside a scrollable transcript replay; (9) demographics with an attention check; (10) completion code.

**Measures.**

- *Negotiation outcomes:* agreement vs. non-agreement, final price, number of turns, session duration.
- *Post-experience survey (nine items):* `satisfaction`, `would_use_again`, `agent_represented`, `control`, `emot_pleasant`, `emot_anxious`, `effort_invested`, `engage_engaged`, `outfair_share`.
- *Behavioural telemetry:* time-stamped client events (clicks, focus/blur, scroll, visibility changes, idle, paste, resize) plus browser/device metadata captured at start.
- *Process measures:* per-turn latency and token usage and orchestrator routing decisions, derived from the turn and decision logs.
- *Delegation content:* the verbatim behavioural briefs, retained for qualitative coding.

---

## Data and reproducibility

**Data model.** All records are written to a single SQLite database (path configurable via `AI2AI_DB_PATH`). The participant identifier links every table.

| Table | Granularity | Contents |
|---|---|---|
| `study_participants` | one per participant | role, condition, demographics, consent flag, attention check, browser/OS/timezone/language, completion code, link to engine session |
| `behavior_prompts` | one per revision | verbatim brief text and revision metadata (a legacy mapped-signals column is retained but unused) |
| `participant_responses` | long format | survey items, free text, time-on-screen, drawn counterpart personality, personal context |
| `participant_events` | many per participant | full behavioural telemetry stream |
| `sessions` | one per negotiation | scenario pack as actually run, outcome, token totals, status |
| `participants` | two per session | per-agent brief and system prompt as sent |
| `turns` | many per session | every turn — tool calls, message, thinking, tokens, latency |
| `orchestrator_decisions` | many per session | every supervisory routing decision |
| `outcomes` / `scores` | optional | utility scores and LLM-as-judge ratings |

**Frozen pilot dataset.** A first human pilot is included as a frozen snapshot at `data/ai2ai-human-pilot-2026-05-15.db`. The analytical sample is the 40 completers (a completer is a participant with a non-null completion code), balanced across the four design cells (n = 10 each).

**Analysis pipeline.** The pipeline under [`scripts/analysis/`](scripts/analysis/) is deterministic and offline (no model calls during report generation). Two independent report generators read the frozen snapshot and emit Word documents with figures and tables:

```bash
python -m scripts.analysis.human_pilot.report      # → docs/reports/2026-05-15-human-pilot-data-report.docx
python -m scripts.analysis.process_report.report   # → docs/reports/2026-05-15-negotiation-process-report.docx
```

Given the pilot sample size, inference is explicitly exploratory and non-parametric: per-dependent-variable Scheirer–Ray–Hare two-way analyses, Mann–Whitney *U* contrasts with Cliff's δ and bootstrap confidence intervals, Kruskal–Wallis omnibus tests, and Fisher's exact test for agreement rates. All *p*-values are reported uncorrected with small-sample caveats stated in figure and table notes.

---

## Ethics and data protection

The platform is designed for compliant deployment within the EU (ESSEC) without retrofitting.

- **Informed consent.** Consent (ESSEC template) is obtained on a dedicated screen; the consent version and timestamp are recorded.
- **No personal data by default.** Participant identifiers are random nanoids. Names, e-mail addresses, and IP addresses are not stored. The `external_id` column is reserved for crowd-platform reconciliation and is otherwise null.
- **IP minimisation.** The per-IP rate limiter hashes the address with a daily-rotating salt in memory only; the raw address is never written to disk.
- **Right of access.** `GET /api/p/export?id=<participantId>` returns a single JSON archive of everything tied to a participant.
- **Right to erasure.** `DELETE /api/p/erase?id=<participantId>` (admin-authenticated) cascades through every table, including the linked engine session.
- **Free-text caveat.** Personal context, behavioural briefs, and free-text survey responses are unconstrained participant input. This should be declared in the IRB protocol, and a personal-data/profanity scrub is advisable before any public data release.

---

## Installation and usage

**Requirements.** Node.js ≥ 24 and an [Anthropic API key](https://console.anthropic.com/) to run the platform; Python 3 to run the analysis pipeline.

**Local run.**

```bash
git clone https://github.com/<you>/ai2ai.git
cd ai2ai
npm install
cp .env.example .env
# edit .env — set ANTHROPIC_API_KEY at minimum
npx tsx src/server/server.ts
```

Open <http://localhost:3737/study> for the participant flow, or <http://localhost:3737/admin> for the researcher dashboard (set `AI2AI_ADMIN_PASSWORD` in `.env` first).

**Command-line runs (no web UI).**

```bash
npm run setup -- --run                    # interactive intake → live negotiation
npm run run -- buyer-seller-negotiation   # spec-example multi-issue negotiation
npm run batch -- buyer-seller-negotiation --runs 5 --concurrency 2
npm run replay -- <sessionId>             # replay a session from its decision log
npm run judge -- <sessionId>              # LLM-as-judge scoring
```

**Tests.**

```bash
npm run typecheck                    # tsc --noEmit
npx tsx src/cli/smoke.ts             # smoke suite, no API key needed
```

The smoke suite exercises scenario validation, orchestrator tool-call validation (including bad-terms rejection), round-robin fallback selection, memory rendering, and SQLite schema initialisation. Continuous integration runs the type check and smoke suite on every push.

**Environment variables.** See [`.env.example`](.env.example) for the canonical template.

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Required¹ | Single key for all three agents. |
| `BUYER_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode — true API-key isolation. |
| `SELLER_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode. |
| `ORCHESTRATOR_ANTHROPIC_API_KEY` | Optional¹ | Per-side mode. |
| `AI2AI_ADMIN_PASSWORD` | Recommended | Required for `/admin` and `/api/p/erase`; without it those endpoints return `503`. |
| `AI2AI_DAILY_BUDGET_USD` | Recommended | Daily LLM-spend cap; when exceeded, `/api/p/run` returns `503 budget_exceeded` until midnight UTC. |
| `AI2AI_DB_PATH` | Optional | SQLite file location. Default `./data/sessions.db`; in Docker, a mounted volume. |
| `AI2AI_PORT` | Optional | Default `3737`. |
| `AI2AI_RATE_LIMIT` | Optional | Set to `off` to disable the per-IP rate limit on `/api/p/start`. |

¹ Set `ANTHROPIC_API_KEY` (single-key mode) **or** all three per-side keys. The server refuses to start if neither is satisfied.

**Deployment.** The application is one Node process plus one SQLite file; any host that runs a Dockerfile and mounts a persistent volume suffices. Deployment manifests are provided for [Fly.io](fly.toml) (pre-configured to mount `/data`, force HTTPS, and health-check `/health`), [Railway](railway.json), and Docker ([`Dockerfile`](Dockerfile)).

```bash
# Fly.io
fly launch --no-deploy             # creates the app, edit fly.toml
fly volumes create data --size 1   # 1GB persistent volume
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  AI2AI_ADMIN_PASSWORD=long-random \
  AI2AI_DAILY_BUDGET_USD=20
fly deploy
fly open

# Docker (any host)
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

On Railway, deploy the repository from GitHub (the `Dockerfile` and `railway.json` are auto-detected), add a volume mounted at `/data`, set the environment variables above with `AI2AI_DB_PATH=/data/sessions.db`, and generate a public domain. The container ships a `HEALTHCHECK` against `/health`.

---

## Repository structure

```
.
├── src/
│   ├── multi-agent/          # Engine — implementation of the multi-agent-core spec
│   │   ├── types.ts
│   │   ├── llm.ts            # Anthropic SDK wrapper (prompt caching, adaptive thinking)
│   │   ├── orchestrator.ts   # Orchestrator runtime (5-tool protocol + validator)
│   │   ├── orchestrator-prompt.ts / orchestrator-tools.ts
│   │   ├── participant.ts    # Participant agent runtime
│   │   ├── session-runner.ts # Main loop + onEvent hooks for live streaming
│   │   ├── pack-builder.ts   # Builds the negotiation pack from intake + stimulus
│   │   ├── persistence.ts    # SQLite schema + helpers
│   │   ├── memory.ts         # Per-participant transcript views
│   │   ├── offer-extractor.ts# Price-detection side call (UI price indicator)
│   │   ├── fallback-protocol.ts / scenario-loader.ts / prompt.ts
│   │   └── judge.ts          # LLM-as-judge scoring
│   ├── cli/                  # run / batch / replay / judge / setup / smoke / preview-prompts
│   └── server/server.ts      # HTTP + SSE application server
├── web/
│   ├── study.html            # 10-screen participant study
│   ├── admin.html            # Researcher dashboard
│   ├── index.html            # Legacy AI-vs-AI demo
│   └── img/camry/            # Listing photos (Wikimedia Commons, CC BY-SA 4.0)
├── scenarios/
│   └── toyota-camry-negotiation/  # Generated per session (git-ignored)
├── multi-agent-core/         # The portable specification this engine implements
│   ├── README.md  ARCHITECTURE.md  ORCHESTRATOR.md  SCENARIOS.md
│   ├── IMPLEMENTATION.md  STATE.md  CLAUDE.md
│   ├── types/core.ts  prompts/  examples/
├── scripts/analysis/         # Deterministic Python analysis pipeline
│   ├── core/                 # Shared statistical helpers
│   ├── human_pilot/          # Human-pilot data report generator
│   └── process_report/       # Negotiation-process report generator (clean-room)
├── docs/
│   ├── reports/              # Generated .docx reports, figures, tables
│   └── superpowers/          # Design specs and implementation plans
├── data/                     # SQLite databases incl. the frozen pilot snapshot (git-ignored)
├── Dockerfile  railway.json  fly.toml  .env.example
├── LICENSE
└── README.md
```

---

## Citation

If you use this software or the accompanying dataset, please cite the software, and — once available — the study paper.

**Software**

```bibtex
@software{ghodratizadeh_ai2ai_2026,
  author  = {Ghodratizadeh, Faraz},
  title   = {{AI2AI}: An Apparatus for Studying Human Delegation of
             Negotiation to {AI} Agents},
  year    = {2026},
  version = {0.1.0},
  note    = {ESSEC Business School},
  url     = {https://github.com/b00833647-cmd/AI2AIv2}
}
```

**Study paper (in preparation)**

```bibtex
@unpublished{ghodratizadeh_sepehri_delegation_2026,
  author = {Ghodratizadeh, Faraz and Sepehri, Amir},
  title  = {[Working title --- to be completed]},
  year   = {2026},
  note   = {Manuscript in preparation, ESSEC Business School}
}
```

Replace the working title, venue, and any DOI once the manuscript and an archived software release are available.

---

## License and credits

Released under the [MIT License](LICENSE), © Faraz Ghodratizadeh.

This research is conducted under the supervision of **Amir Sepehri** (ESSEC Business School).

- Vehicle photographs: Wikimedia Commons, *2019 Toyota Camry XV70* (East Surabaya), CC BY-SA 4.0.
- Multi-agent runtime: the portable `multi-agent-core` specification bundled in this repository.
- Agent dialogue is produced with Anthropic Claude models via the Anthropic SDK.

---

## References

The following are the verifiable resources this apparatus depends on. A literature-grounded *related work* discussion is intentionally deferred to the forthcoming manuscript and is not reproduced here.

1. Anthropic. *Claude models and the Anthropic API.* <https://docs.anthropic.com>; Anthropic TypeScript SDK (`@anthropic-ai/sdk`).
2. Wikimedia Commons contributors. *2019 Toyota Camry XV70* (East Surabaya). Licensed CC BY-SA 4.0.
3. `multi-agent-core` — portable multi-agent LLM dialogue specification (bundled in [`multi-agent-core/`](multi-agent-core/)).

> *Related work (placeholder).* Citations to the negotiation, delegation, and human–AI interaction literature will accompany the study paper. If you would like this section populated in the README as well, supply the reference list and it will be added here verbatim.
