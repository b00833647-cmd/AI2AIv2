# Negotiation Process & Interaction Dynamics — Report (design spec)

**Date:** 2026-05-15
**Status:** clean-room. A wholly NEW, standalone analysis pipeline + a NEW `.docx`.
It is **independent** of the existing `scripts/analysis/human_pilot/*` and
`scripts/analysis/core/*` code — zero imports from them. Only the raw frozen
SQLite snapshot file (data, not code) is shared.

## Goal

A standalone report on *how negotiations unfolded* (process & interaction
dynamics) — orthogonal to the existing outcomes/survey report (*what the deal
was, how people felt*). Four pillars: bargaining trajectory, tempo/cost,
orchestrator behavior, participant UX engagement.

## Clean-room architecture (all new, from zero)

New self-contained package: `scripts/analysis/process_report/`

| Module | Responsibility (no imports from human_pilot/core) |
|---|---|
| `__init__.py` | package marker |
| `db.py` | open the frozen snapshot read-only; `SNAPSHOT` path const; `completers()` (the 40, `completion_code` not null) with `cell` = `mode2`×`role` labels; helpers to load `turns`, `orchestrator_decisions`, `participant_events`, `sessions`, `study_participants`. Own `mode2` mapping (`agent`→`AI-to-AI`, `human_buyer`/`human_seller`→`Human-to-AI`). |
| `extract.py` | pure parsers: proposal/message stream → typed bargaining events; reservation extractor from `sessions.scenario_pack_json`; latency/token/timestamp coercion; orchestrator-decision parser; participant_events payload parser |
| `metrics.py` | derive per-session / per-participant metric frames (the DVs) for all 4 pillars |
| `stats.py` | own clean-room implementations: `scheirer_ray_hare`, `mann_whitney`, `kruskal_wallis`, `fisher_2x2`, `bootstrap_ci` (scipy/numpy only) |
| `viz.py` | own Okabe-Ito palette + locked cell colours, matplotlib theme, `save()`/`save_plotnine()` helpers (out dir `docs/reports/figures-process/`), all figure builders |
| `docx_build.py` | own python-docx helpers: `new_doc, h1, h2, para, figure, table` |
| `report.py` | orchestrator → `docs/reports/2026-05-15-negotiation-process-report.docx`; writes table CSVs to `docs/reports/tables-process/` |
| `tests/` | own pytest suite (`tests/__init__.py` + `test_*.py`); run via `python -m pytest scripts/analysis/process_report -q` |

Deliverables: `docs/reports/2026-05-15-negotiation-process-report.docx`,
`docs/reports/figures-process/*.png` (+svg), `docs/reports/tables-process/*.csv`.
No LLM, no network, fully deterministic, fixed seeds.

## Fixed data facts (verified from the snapshot)

- Snapshot `data/ai2ai-human-pilot-2026-05-15.db`. 40 completers
  (`study_participants.completion_code` not null); 4 balanced cells n=10:
  `mode2 ∈ {AI-to-AI, Human-to-AI}` × `role ∈ {buyer, seller}`. 494 turns for
  completers.
- `turns`: `session_id, turn_number, emitter (human|participant), emitter_id
  (buyer|seller), tool_calls_json, message, latency_ms, tokens_json,
  timestamp (ISO-8601 Z)`. `tool_calls_json` = list of `{name,input}`; two
  tools: `send_message{message}` and `submit_proposal{action ∈
  propose|counter|accept|reject, is_final ∈ true|false|null,
  issues:[{name:"price", value:<number>}], message}`. All 288 proposals carry a
  price.
- `orchestrator_decisions`: `session_id, turn_number, tool_name (request_turn
  537 | declare_outcome 40 | broadcast_to 4 | pause 1), tool_input_json,
  rationale, thinking, tokens_used, timestamp`.
- `participant_events` (6,596): `participant_id, client_ts, server_ts, screen
  (0..10), event_type, payload_json`. Payloads: `screen_exit{from,to,dwellMs}`,
  `screen_enter{step}`, `idle_start{thresholdMs}`, `idle_end{idleMs}`,
  `listing_thumbnail_view{src}`, `listing_zoom_open{src}`,
  `human_turn_submitted{action,charCount,hadPrice}`,
  `human_turn_input_enabled{turnNumber}`, `quick_accept_clicked{price}`,
  `quick_walk_clicked`, `visibility_change{hidden}`, `scroll{pct,maxPct}`,
  `outcome_revealed{type,price,turns}`, `click{...}`,
  `rightclick_attempt`/`copy_attempt`/`paste`.
- `sessions`: `id, scenario_pack_json, status, started_at, ended_at (ISO-8601
  Z), outcome_type, outcome_terms_json ({"price":N}), degraded, tokens_total,
  tokens_orchestrator, turns_consumed`.
- **Reservation prices** live in `sessions.scenario_pack_json` →
  `participants[i]['brief']` text, verbatim wording: buyer `"target purchase
  price: $21,500"` + `"WALK-AWAY maximum (do NOT exceed under any
  circumstances): $23,500"`; seller has analogous target + floor (do-not-go-
  below). Fixed Camry scenario → expected uniform across the 40; the extractor
  MUST verify uniformity and FAIL LOUDLY (raise) if values differ, surfacing the
  per-session values (no silent fallback).
- `participant_responses.time_on_screen_ms` is 100 % NULL — UNUSABLE. All dwell
  timing derives from `participant_events` (`screen_exit.dwellMs`).
- `turns.thinking` is empty for all 532 — no private agent reasoning available
  (state as a limitation; do not attempt thinking analysis).

## Statistical posture

Strictly **exploratory** (n=10/cell). Each derived process metric that is a DV
gets BOTH, per the user's instruction:
1. **Scheirer–Ray–Hare 2×2** on Mode, Role, Mode×Role (rank-based; H, χ² p
   df=1, η²=SS/SS_total).
2. **Nonparametric comparison tests**: Mann–Whitney U for the Mode contrast
   (AI-to-AI vs Human-to-AI, 20 vs 20) and the Role contrast (buyer vs seller,
   20 vs 20), each with a rank-biserial / Cliff's-δ effect size + 95 %
   percentile bootstrap CI (own `bootstrap_ci`, seed=42, two-sample); and a
   Kruskal–Wallis omnibus across the 4 cells (H, p, ε²).
Rate/binary DVs (e.g. final-offer-used, deal reached) use `fisher_2x2` for the
Mode and Role 2×2 instead of MW. All p uncorrected, no pairwise post-hoc, every
test-bearing caption says "exploratory; n=10/cell; uncorrected".

## Pillars, metrics, figures, tables

Every pillar emits a **metric-dictionary table** (name, definition, source,
type) so derived measures are auditable, plus a per-cell descriptives table and
the SRH+MW+KW stats table for its DVs.

### §1 Bargaining trajectory & strategy
Per session, from the ordered proposal/message stream (completer sessions):
- **Offer path** figure: price × turn for buyer & seller, faceted by the 4
  cells; deal sessions vs no-deal overlaid (line + points; final settlement
  marked).
- **Anchoring**: `buyer_open`, `seller_open` (first `submit_proposal` price
  each side), `opening_spread = seller_open − buyer_open`, `anchor_distance`
  (|own opening − own target|).
- **Concessions**: per side `n_concessions`, `total_concession`,
  `mean_concession`, `concession_rate` (Δprice per proposal round),
  `monotonic` (bool), `buyer_share_of_total_concession`.
- **Round structure**: `n_proposal_rounds`, `dialogue_to_proposal_ratio`
  (send_message / submit_proposal counts), `turns_to_first_proposal`,
  `turns_to_deal` (None if no deal).
- **Ultimatums**: `n_final_offers` (`is_final=true`), `first_final_turn`,
  `held_after_final` (did the side that issued a final offer stick to it).
- **Settlement & surplus** (deal sessions; uses parsed reservations):
  `settlement_price`, `zopa_low`/`zopa_high`/`zopa_mid`,
  `settlement_vs_mid` (price − mid), `buyer_surplus = buyer_walkaway − price`,
  `seller_surplus = price − seller_floor`, `buyer_share_of_surplus`,
  `pareto_efficient` (within ZOPA bool).
- Figures: offer-path facets; concession-size box/raincloud by cell; surplus-
  split bar (buyer vs seller share by cell); settlement-vs-ZOPA dot plot.
- DVs for stats: `opening_spread, anchor_distance, n_concessions,
  mean_concession, concession_rate, buyer_share_of_surplus, rounds_to_deal,
  n_final_offers`.

### §2 Tempo, latency & token economy
- Per-turn `latency_ms`: distribution by emitter (human vs AI) and by role;
  latency × turn-number arc figure (does deliberation grow late?).
- `negotiation_duration_s` (`sessions.ended_at − started_at`),
  `time_to_deal_s`.
- Tokens: `tokens_total`, `tokens_orchestrator`, `agent_tokens = total − orch`,
  `orch_token_share`, `tokens_per_turn`.
- Figures: latency-by-emitter box; latency arc; tokens per session by cell.
- DVs: `median_latency_ms, negotiation_duration_s, tokens_total,
  orch_token_share`.

### §3 Orchestrator / referee behavior
- Turn-routing: from the `request_turn` sequence per session — `alternation_rate`
  (fraction of consecutive routes that switch side), longest same-side streak,
  turns routed per side.
- Outcome declaration: `declare_turn` (turn_number of declare_outcome),
  `declare_latency_s` (decision timestamp − last turn timestamp),
  `rationale_len`.
- Interventions: counts of `broadcast_to`/`pause`; `degraded` session rate.
- Referee cost: orchestrator tokens per session/turn.
- Mostly descriptive; DVs: `alternation_rate, declare_latency_s,
  orch_tokens_per_turn`. `degraded` (binary) via Fisher 2×2.

### §4 Participant UX & engagement (from participant_events, 40 completers)
- Screen flow & dwell: per-screen dwell (sum `screen_exit.dwellMs` by
  `screen`), the 10-screen flow funnel, total session active time, **engine-
  screen dwell** (time watching/doing the negotiation).
- Attention: `n_idle` & `total_idle_s` (`idle_end.idleMs`), `n_tab_away`
  (`visibility_change.hidden=true`), blur count on engine screen.
- Listing engagement: `n_thumbnail_views`, `n_zoom_opens`,
  `inspected_listing` (bool any).
- Effort: `n_clicks`, `max_scroll_pct` (max `scroll.maxPct` per screen, mean
  over screens).
- Human-mode cadence (Human-to-AI only): from `human_turn_submitted` —
  `n_human_turns`, action mix (send vs proposal), `mean_charcount`,
  `priced_turn_rate` (`hadPrice`), `mean_compose_s`
  (`human_turn_submitted` ts − preceding `human_turn_input_enabled` ts);
  `quick_accept`/`quick_walk` usage.
- Figures: per-screen dwell stacked/box by cell; engine-dwell by cell; idle &
  tab-away by cell; listing-inspection rate by cell; human compose-time &
  charcount buyer vs seller (Human-to-AI only).
- DVs (4-cell where sensible): `engine_dwell_s, total_idle_s, n_tab_away,
  n_clicks, mean_scroll_pct, n_listing_views`; human-only (2-group buyer vs
  seller within Human-to-AI, MW only): `mean_compose_s, mean_charcount`.

### §0 / closing
- §0: method & sample note (40 completers, 4 cells, exploratory; derived-metric
  philosophy; the 3 stated limitations).
- Closing: "what this enables / cannot support" (no thinking traces; n=10/cell;
  reservation from fixed scenario; non-completer process excluded).

## Tests (own suite, `scripts/analysis/process_report/tests/`)

- `db`: completers()==40, 4 cells ×10, cell labels correct.
- `extract`: proposal parser on a synthetic `tool_calls_json` yields correct
  (action, price, is_final); reservation extractor returns the 4 numbers and
  RAISES on a doctored non-uniform pack; timestamp parser handles the Z format.
- `metrics`: on the real snapshot — concession/round/surplus frames have one
  row per completer session, no NaN in required columns for deal sessions,
  `buyer_share_of_surplus ∈ [0,1]` for in-ZOPA deals; UX frame 40 rows.
- `stats`: `scheirer_ray_hare` KW-equivalence (main-effect H == `kruskal` H when
  other factor null, balanced) to 1e-9; `mann_whitney`/`kruskal_wallis` match
  `scipy` reference; `bootstrap_ci` brackets a known δ; `fisher_2x2` matches
  scipy.
- `report`: build produces the .docx with all §0–§4 headings, ≥ 12 images,
  no traceback; no import of `scripts.analysis.human_pilot` or
  `scripts.analysis.core` anywhere in the package (AST/grep check in a test).

## Acceptance criteria

1. `python -m scripts.analysis.process_report.report` writes
   `docs/reports/2026-05-15-negotiation-process-report.docx`, no traceback.
2. Package imports nothing from `scripts.analysis.human_pilot` or
   `scripts.analysis.core` (enforced by a test).
3. §1–§4 all present with their figures + metric-dictionary + descriptives +
   SRH/MW/KW stats tables; §0 method note + closing limitations present.
4. Reservation extractor verifies uniformity and raises on mismatch (tested).
5. All SRH/MW/KW p ∈ [0,1]; effect sizes in valid ranges; captions say
   "exploratory; n=10/cell; uncorrected".
6. `python -m pytest scripts/analysis/process_report -q` all green;
   build is offline/deterministic (no anthropic/network import).
7. Existing report + its tests untouched and still green
   (`python -m pytest scripts/analysis/tests -q` unaffected).

## Out of scope

No reuse of existing analysis code. No new dependency beyond the stack already
in `.venv` (pandas, numpy, scipy, matplotlib, plotnine, python-docx, pytest).
No `thinking` analysis. No non-completer process analysis. No modification of
the existing report, engine, or DB. No multiplicity correction. No LLM.
