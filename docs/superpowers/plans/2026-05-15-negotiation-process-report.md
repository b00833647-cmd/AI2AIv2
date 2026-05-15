# Negotiation Process Report — Implementation Plan (clean-room)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Task-by-task; checkbox steps.

**Goal:** A wholly standalone `scripts/analysis/process_report/` package + new `.docx` on negotiation process & interaction dynamics. ZERO imports from `scripts.analysis.human_pilot` or `scripts.analysis.core`.

**Spec:** `docs/superpowers/specs/2026-05-15-negotiation-process-report-design.md` (read for pillar/metric/stat definitions; this plan carries the code).

**Tech:** pandas, numpy, scipy, matplotlib, plotnine, python-docx, pytest. venv `.venv`. Snapshot `data/ai2ai-human-pilot-2026-05-15.db`. Tests: `python -m pytest scripts/analysis/process_report -q`. Each commit message ends with `Co-Authored-By: RuFlo <ruv@ruv.net>`.

**Hard rule (every task):** no file in `scripts/analysis/process_report/` may `import` from `scripts.analysis.human_pilot` or `scripts.analysis.core`. Reuse only stdlib + the listed third-party libs.

---

## Task 1: Package skeleton + `db.py`

**Files:** create `scripts/analysis/process_report/__init__.py`, `scripts/analysis/process_report/db.py`, `scripts/analysis/process_report/tests/__init__.py`, `scripts/analysis/process_report/tests/test_db.py`

- [ ] **Step 1: failing test** — `scripts/analysis/process_report/tests/test_db.py`:

```python
from scripts.analysis.process_report.db import (
    SNAPSHOT, connect, completers, MODE2, CELLS,
)


def test_snapshot_exists():
    assert SNAPSHOT.exists()


def test_completers_40_4cells():
    con = connect()
    c = completers(con)
    assert len(c) == 40
    assert set(c["cell"]) == set(CELLS)
    assert (c.groupby("cell").size() == 10).all()
    assert set(c["mode2"]) == {"AI-to-AI", "Human-to-AI"}
    assert set(c["role"]) == {"buyer", "seller"}
    # cell == "<mode2> · <role>"
    r0 = c.iloc[0]
    assert r0["cell"] == f"{r0['mode2']} · {r0['role']}"
```

- [ ] **Step 2: run, expect ModuleNotFoundError** — `source .venv/bin/activate && python -m pytest scripts/analysis/process_report -q`

- [ ] **Step 3: implement**

`scripts/analysis/process_report/__init__.py`: empty file.
`scripts/analysis/process_report/tests/__init__.py`: empty file.
`scripts/analysis/process_report/db.py`:

```python
"""Standalone snapshot access for the process report. No project imports."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

SNAPSHOT = Path("data/ai2ai-human-pilot-2026-05-15.db")

MODE2 = {"agent": "AI-to-AI",
         "human_buyer": "Human-to-AI", "human_seller": "Human-to-AI"}
CELLS = ["AI-to-AI · buyer", "AI-to-AI · seller",
         "Human-to-AI · buyer", "Human-to-AI · seller"]


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def completers(con) -> pd.DataFrame:
    """The 40 finished participants, one row each, with cell labels."""
    df = pd.read_sql_query(
        """SELECT id AS participant_id, session_id, role, experiment_mode,
                  completion_code
             FROM study_participants
            WHERE completion_code IS NOT NULL""", con)
    df["mode2"] = df["experiment_mode"].map(MODE2)
    df["cell"] = df["mode2"] + " · " + df["role"]
    return df.reset_index(drop=True)


def load(con, table: str, cols: str = "*") -> pd.DataFrame:
    return pd.read_sql_query(f"SELECT {cols} FROM {table}", con)
```

- [ ] **Step 4: run, expect pass** — `python -m pytest scripts/analysis/process_report -q` → 2 passed.

- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: package skeleton + standalone db loader\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 2: `stats.py` (clean-room) + tests

**Files:** create `scripts/analysis/process_report/stats.py`, `scripts/analysis/process_report/tests/test_stats.py`

- [ ] **Step 1: failing tests** — `tests/test_stats.py`:

```python
import numpy as np
import pandas as pd
from scipy import stats as sp

from scripts.analysis.process_report.stats import (
    scheirer_ray_hare, mann_whitney, kruskal_wallis, fisher_2x2, bootstrap_ci,
)


def test_srh_kw_equivalence():
    rng = np.random.default_rng(1)
    rows = []
    for a in ("lo", "hi"):
        for b in ("x", "y"):
            base = 0.0 if a == "lo" else 5.0
            for _ in range(10):
                rows.append({"dv": base + rng.normal(0, 1), "A": a, "B": b})
    df = pd.DataFrame(rows)
    r = scheirer_ray_hare(df, "dv", "A", "B")
    # main-effect H ≈ KW H on A when B marginal & balanced
    kw = sp.kruskal(*[g["dv"].values for _, g in df.groupby("A")])
    assert abs(r["A"]["H"] - kw.statistic) < 1e-9
    assert r["A"]["df"] == 1 and 0 <= r["A"]["eta2"] <= 1 and r["N"] == 40


def test_mw_matches_scipy():
    a = [1, 2, 3, 4, 5, 6]
    b = [4, 5, 6, 7, 8, 9]
    r = mann_whitney(a, b)
    u, p = sp.mannwhitneyu(a, b, alternative="two-sided")
    assert abs(r["U"] - float(u)) < 1e-9 and abs(r["p"] - float(p)) < 1e-9
    assert -1 <= r["cliffs_delta"] <= 1


def test_kw_matches_scipy():
    g = [[1, 2, 3], [4, 5, 6], [2, 2, 9]]
    r = kruskal_wallis(*g)
    k = sp.kruskal(*g)
    assert abs(r["H"] - float(k.statistic)) < 1e-9
    assert 0 <= r["eps2"] <= 1


def test_fisher_matches_scipy():
    r = fisher_2x2(7, 10, 3, 10)
    _, p = sp.fisher_exact([[7, 3], [3, 7]])
    assert abs(r["p"] - float(p)) < 1e-9 and r["rate_a"] == 0.7


def test_bootstrap_brackets():
    lo, hi = bootstrap_ci([7] * 20, [1] * 20, seed=42)
    assert lo > 0.9 and hi <= 1.0001
```

- [ ] **Step 2: run, expect ImportError.**

- [ ] **Step 3: implement** `scripts/analysis/process_report/stats.py`:

```python
"""Clean-room nonparametric stats for the process report. scipy/numpy only."""
from __future__ import annotations

import numpy as np
from scipy import stats as _sp


def _cliffs_delta(a, b) -> float:
    a = np.asarray(a, float); b = np.asarray(b, float)
    if a.size == 0 or b.size == 0:
        return float("nan")
    gt = sum((x > b).sum() for x in a)
    lt = sum((x < b).sum() for x in a)
    return float((gt - lt) / (a.size * b.size))


def mann_whitney(a, b) -> dict:
    a = np.asarray(a, float); a = a[~np.isnan(a)]
    b = np.asarray(b, float); b = b[~np.isnan(b)]
    if a.size < 2 or b.size < 2:
        return {"U": float("nan"), "p": float("nan"),
                "cliffs_delta": float("nan"), "n_a": int(a.size),
                "n_b": int(b.size)}
    U, p = _sp.mannwhitneyu(a, b, alternative="two-sided")
    return {"U": float(U), "p": float(p),
            "cliffs_delta": _cliffs_delta(a, b),
            "n_a": int(a.size), "n_b": int(b.size)}


def kruskal_wallis(*groups) -> dict:
    gs = [np.asarray(g, float) for g in groups]
    gs = [g[~np.isnan(g)] for g in gs if np.asarray(g).size]
    if len(gs) < 2 or any(g.size < 1 for g in gs):
        return {"H": float("nan"), "p": float("nan"), "eps2": float("nan")}
    k = _sp.kruskal(*gs)
    N = sum(g.size for g in gs)
    eps2 = float(k.statistic / (N - 1)) if N > 1 else float("nan")
    return {"H": float(k.statistic), "p": float(k.pvalue),
            "eps2": min(max(eps2, 0.0), 1.0)}


def scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict:
    d = df[[dv, a, b]].dropna().copy()
    R = _sp.rankdata(d[dv].to_numpy(float))
    N = int(R.size)
    d["_R"] = R
    grand = float(R.mean())
    SS_total = float(((R - grand) ** 2).sum())

    def _ssm(col):
        return float(sum(len(g) * (float(g["_R"].mean()) - grand) ** 2
                         for _, g in d.groupby(col, observed=True)))

    SS_A = _ssm(a)
    SS_B = _ssm(b)
    ma = d.groupby(a, observed=True)["_R"].mean()
    mb = d.groupby(b, observed=True)["_R"].mean()
    SS_AB = float(sum(
        len(g) * (float(g["_R"].mean()) - float(ma[la]) - float(mb[lb])
                  + grand) ** 2
        for (la, lb), g in d.groupby([a, b], observed=True)))
    MS_total = SS_total / (N - 1) if N > 1 else float("nan")

    def _term(ss):
        H = ss / MS_total if MS_total and MS_total == MS_total else float("nan")
        ok = H == H and np.isfinite(H)
        return {"H": float(H),
                "p": float(_sp.chi2.sf(H, 1)) if ok else float("nan"),
                "eta2": float(ss / SS_total) if SS_total else float("nan"),
                "df": 1}

    return {"A": _term(SS_A), "B": _term(SS_B), "AB": _term(SS_AB), "N": N}


def fisher_2x2(succ_a: int, n_a: int, succ_b: int, n_b: int) -> dict:
    odds, p = _sp.fisher_exact([[succ_a, n_a - succ_a],
                                [succ_b, n_b - succ_b]])
    return {"odds_ratio": float(odds), "p": float(p),
            "rate_a": succ_a / n_a if n_a else float("nan"),
            "rate_b": succ_b / n_b if n_b else float("nan"),
            "n_a": n_a, "n_b": n_b}


def bootstrap_ci(a, b, n_boot: int = 1000, seed: int = 42) -> tuple:
    """Two-sample percentile CI for Cliff's delta (independent resample)."""
    rng = np.random.default_rng(seed)
    A = np.asarray(a, float); B = np.asarray(b, float)
    boots = [_cliffs_delta(rng.choice(A, A.size, replace=True),
                           rng.choice(B, B.size, replace=True))
             for _ in range(n_boot)]
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))
```

- [ ] **Step 4: run, expect all pass.**
- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: clean-room nonparametric stats (SRH/MW/KW/Fisher/bootstrap)\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 3: `extract.py` parsers + tests

**Files:** create `scripts/analysis/process_report/extract.py`, `tests/test_extract.py`

Parsers (pure, no DB inside the unit-tested fns except where noted):

- `parse_proposals(tool_calls_json: str) -> list[dict]` → for each `submit_proposal`: `{"action","price","is_final","message"}` (price = the `issues` entry with `name=="price"` value, float; is_final → bool, None→False). `send_message` ignored here.
- `count_tools(tool_calls_json) -> dict` → `{"send_message": k, "submit_proposal": m}`.
- `parse_ts(s) -> datetime|None` → ISO-8601 `...Z` (use `datetime.fromisoformat(s.replace("Z","+00:00"))`).
- `extract_reservations(con) -> dict` → parse every completer session's `sessions.scenario_pack_json`; from `pack["participants"]` find buyer & seller `brief`; regex buyer `target purchase price:\s*\$?([\d,]+)` and `WALK-?AWAY[^$]*\$?([\d,]+)`; seller analogous (`target`/floor — see Step 3 regex). Build per-session dict `{session_id: {"buyer_target","buyer_walkaway","seller_target","seller_floor"}}` (ints, commas stripped). **Verify uniformity:** if the distinct tuple across sessions > 1, `raise ValueError` listing the distinct tuples. Return the per-session map (uniform values repeated).
- `event_payload(row) -> dict` → `json.loads(payload_json or "{}")`.

- [ ] **Step 1: failing tests** — `tests/test_extract.py`:

```python
import json
import pytest
from scripts.analysis.process_report.extract import (
    parse_proposals, count_tools, parse_ts, extract_reservations,
)
from scripts.analysis.process_report.db import connect


def test_parse_proposals():
    tj = json.dumps([
        {"name": "submit_proposal", "input": {
            "action": "counter", "is_final": True,
            "issues": [{"name": "price", "value": 23000}],
            "message": "final"}},
        {"name": "send_message", "input": {"message": "hi"}}])
    p = parse_proposals(tj)
    assert len(p) == 1 and p[0]["action"] == "counter"
    assert p[0]["price"] == 23000.0 and p[0]["is_final"] is True
    assert count_tools(tj) == {"send_message": 1, "submit_proposal": 1}


def test_parse_ts():
    d = parse_ts("2026-05-14T13:05:46.565Z")
    assert d is not None and d.year == 2026 and parse_ts(None) is None


def test_reservations_uniform_and_values():
    con = connect()
    res = extract_reservations(con)
    assert len(res) == 40
    one = next(iter(res.values()))
    assert one["buyer_target"] == 21500 and one["buyer_walkaway"] == 23500
    assert one["seller_target"] > one["seller_floor"] > 0
    # uniform across all completer sessions
    sigs = {tuple(sorted(v.items())) for v in res.values()}
    assert len(sigs) == 1


def test_reservations_raise_on_nonuniform(monkeypatch):
    # doctor: feed two different packs → must raise
    from scripts.analysis.process_report import extract as E
    calls = {"n": 0}
    real = E._packs_for_completers

    def fake(con):
        rows = real(con)
        rows = list(rows)
        if rows:
            sid, pack = rows[0]
            pack2 = pack.replace("21,500", "19,999")
            rows[0] = (sid, pack2)
        return rows

    monkeypatch.setattr(E, "_packs_for_completers", fake)
    with pytest.raises(ValueError):
        E.extract_reservations(connect())
```

- [ ] **Step 2: run, expect ImportError.**

- [ ] **Step 3: implement** `scripts/analysis/process_report/extract.py`:

```python
"""Pure parsers for the process report. No project imports."""
from __future__ import annotations

import json
import re
from datetime import datetime

import pandas as pd

_NUM = r"\$?\s*([0-9][0-9,]{2,})"


def parse_proposals(tool_calls_json) -> list:
    out = []
    try:
        tcs = json.loads(tool_calls_json) if tool_calls_json else []
    except Exception:
        return out
    for tc in tcs:
        if tc.get("name") != "submit_proposal":
            continue
        i = tc.get("input", {}) or {}
        price = None
        for iss in (i.get("issues") or []):
            if iss.get("name") == "price" and iss.get("value") is not None:
                price = float(iss["value"])
        out.append({"action": i.get("action"), "price": price,
                    "is_final": bool(i.get("is_final")),
                    "message": i.get("message")})
    return out


def count_tools(tool_calls_json) -> dict:
    c = {"send_message": 0, "submit_proposal": 0}
    try:
        for tc in (json.loads(tool_calls_json) if tool_calls_json else []):
            n = tc.get("name")
            if n in c:
                c[n] += 1
    except Exception:
        pass
    return c


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _packs_for_completers(con):
    cur = con.execute(
        """SELECT s.id, s.scenario_pack_json
             FROM sessions s
             JOIN study_participants sp ON sp.session_id = s.id
            WHERE sp.completion_code IS NOT NULL
              AND s.scenario_pack_json IS NOT NULL""")
    return [(r[0], r[1]) for r in cur.fetchall()]


def _int(m):
    return int(m.group(1).replace(",", "")) if m else None


def _briefs(pack_json: str):
    d = json.loads(pack_json)
    by = {}
    for p in d.get("participants", []):
        role = (p.get("role") or p.get("id") or "").lower()
        by[role] = json.dumps(p)  # brief text lives inside the participant blob
    return by


def extract_reservations(con) -> dict:
    res = {}
    for sid, pj in _packs_for_completers(con):
        b = _briefs(pj)
        buyer = b.get("buyer", "")
        seller = b.get("seller", "")
        rec = {
            "buyer_target": _int(re.search(
                r"target purchase price:\s*" + _NUM, buyer, re.I)),
            "buyer_walkaway": _int(re.search(
                r"WALK-?AWAY[^0-9$]{0,40}" + _NUM, buyer, re.I)),
            "seller_target": _int(re.search(
                r"target (?:sale |selling )?price:\s*" + _NUM, seller, re.I)),
            "seller_floor": _int(re.search(
                r"(?:WALK-?AWAY|do NOT go below|absolute (?:floor|minimum)|"
                r"lowest)[^0-9$]{0,40}" + _NUM, seller, re.I)),
        }
        res[sid] = rec
    sigs = {tuple(sorted(v.items())) for v in res.values()}
    if len(sigs) != 1:
        raise ValueError(
            f"Non-uniform reservation values across sessions: {sigs}")
    if any(v is None for v in next(iter(res.values())).values()):
        raise ValueError(
            f"Reservation parse incomplete: {next(iter(res.values()))}")
    return res
```

If `test_reservations_uniform_and_values` fails because a seller regex misses, ADJUST the seller regexes minimally to the actual brief wording (read one pack: `python -c "import json,sqlite3;c=sqlite3.connect('data/ai2ai-human-pilot-2026-05-15.db');import json;p=json.loads([r[0] for r in c.execute('select scenario_pack_json from sessions where scenario_pack_json is not null limit 1')][0]);print([x.get('brief') for x in p['participants']])"`) — keep the buyer asserts (`21500`/`23500`) intact; they are ground truth. Do NOT weaken the uniformity/raise logic.

- [ ] **Step 4: run, expect pass** (4 tests).
- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: stream/reservation/timestamp parsers (uniformity-guarded)\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 4: `metrics.py` — §1 bargaining + §2 tempo + §3 orchestrator + §4 UX

**Files:** create `scripts/analysis/process_report/metrics.py`, `tests/test_metrics.py`

`metrics.py` builds, from `db.connect()` + `extract`, these public functions, each returning a tidy `pd.DataFrame` keyed by `participant_id`+`session_id`+`cell` (one row per completer session, except `ux_frame` keyed per participant and `human_cadence` Human-to-AI only):

- `bargaining_frame(con)` — cols: `participant_id, session_id, cell, mode2, role, outcome_type, buyer_open, seller_open, opening_spread, anchor_distance, n_concessions, mean_concession, concession_rate, buyer_share_concession, n_proposal_rounds, dialogue_to_proposal_ratio, turns_to_first_proposal, turns_to_deal, n_final_offers, first_final_turn, held_after_final`.
- `surplus_frame(con)` — deal sessions only: `... settlement_price, zopa_low, zopa_high, zopa_mid, settlement_vs_mid, buyer_surplus, seller_surplus, buyer_share_of_surplus, pareto_efficient`.
- `tempo_frame(con)` — `... median_latency_ms, mean_latency_ms, negotiation_duration_s, time_to_deal_s, tokens_total, tokens_orchestrator, agent_tokens, orch_token_share, tokens_per_turn`.
- `orchestrator_frame(con)` — `... alternation_rate, longest_same_streak, n_request_turn, declare_turn, declare_latency_s, rationale_len, n_broadcast, n_pause, degraded, orch_tokens_per_turn`.
- `ux_frame(con)` — one row per completer participant: `participant_id, cell, mode2, role, total_active_s, engine_dwell_s, n_idle, total_idle_s, n_tab_away, n_thumbnail_views, n_zoom_opens, inspected_listing, n_clicks, mean_scroll_pct`. Dwell from `screen_exit.dwellMs`; engine screen = the screen whose `screen` value carries the negotiation (determine empirically as the screen with the most events among completers — document the chosen screen int in a module constant `ENGINE_SCREEN`; from exploration screen 7/8 dominate — compute it, do not hardcode blindly: `ENGINE_SCREEN = mode of screen for event_type in {'human_turn_submitted','outcome_revealed','human_turn_input_enabled'}`).
- `human_cadence(con)` — Human-to-AI participants only: `participant_id, role, n_human_turns, send_share, proposal_share, mean_charcount, priced_turn_rate, mean_compose_s, n_quick_accept, n_quick_walk` (`mean_compose_s` = mean over turns of `human_turn_submitted.ts − preceding human_turn_input_enabled.ts` for the same participant).

Exact derivations are the spec §1–§4 bullet definitions. Concession = a side's successive own-proposal price moving toward the other side (buyer concession = price ↑, seller concession = price ↓). `concession_rate` = total_concession / n_proposal_rounds (0 if <1 round). `dialogue_to_proposal_ratio` = send_message count / max(1, submit_proposal count). `alternation_rate` = (# adjacent request_turn routes to a different participant) / (n_request_turn − 1).

- [ ] **Step 1: failing test** — `tests/test_metrics.py`:

```python
import math
from scripts.analysis.process_report.db import connect
from scripts.analysis.process_report import metrics as M


def test_frames_shapes_and_invariants():
    con = connect()
    bf = M.bargaining_frame(con)
    assert len(bf) == 40
    assert {"opening_spread", "n_concessions", "turns_to_deal"} <= set(bf.columns)

    sf = M.surplus_frame(con)
    assert len(sf) >= 20  # ~27 deals among completers
    bs = sf["buyer_share_of_surplus"].dropna()
    assert ((bs >= 0) & (bs <= 1)).mean() > 0.8  # in-ZOPA deals bounded

    tf = M.tempo_frame(con)
    assert len(tf) == 40 and (tf["orch_token_share"].between(0, 1)).all()

    of = M.orchestrator_frame(con)
    assert len(of) == 40 and of["alternation_rate"].between(0, 1).all()

    uf = M.ux_frame(con)
    assert len(uf) == 40 and (uf["engine_dwell_s"] >= 0).all()

    hc = M.human_cadence(con)
    assert set(hc["role"]) <= {"buyer", "seller"} and len(hc) <= 20
    assert (hc["n_human_turns"] >= 0).all()
```

- [ ] **Step 2: run, expect ImportError.**
- [ ] **Step 3: implement `metrics.py`** per the definitions above and spec §1–§4. Use `db.completers`, `db.load`, `extract.*`. Keep each metric function focused; one tidy frame per public fn; deterministic. (Implementer: derive `ENGINE_SCREEN` empirically as specified; never import project code.)
- [ ] **Step 4: run, expect pass.** If `surplus`/`buyer_share` invariant fails, debug the reservation orientation (buyer_surplus = buyer_walkaway − price; seller_surplus = price − seller_floor) — do not weaken the test; fix the derivation.
- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: derived metric frames for all 4 pillars\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 5: `viz.py` — palette, theme, all figures

**Files:** create `scripts/analysis/process_report/viz.py`, `tests/test_viz.py`

`viz.py` (own, no project imports):
- `PALETTE` Okabe-Ito dict; `MODE2_COLORS`, `ROLE_COLORS`, `CELL_COLORS` (keys = the 4 `CELLS` strings), `SEQ` diverging list.
- `apply_theme()` (matplotlib rcParams), `OUT = Path("docs/reports/figures-process")`, `save(fig, name, aspect=0.6) -> Path` (mkdir, savefig png@150 + svg, close, return png Path), `save_plotnine(g, name, w, h) -> Path`.
- Figure builders (each `(con) -> Path`), grouped, ≥ 12 total:
  - §1: `fig_offer_paths` (plotnine: price×turn, color by emitter_id, facet by cell, settlement point marked), `fig_concession_box` (raincloud-ish concession size by cell), `fig_surplus_split` (stacked bar buyer vs seller share by cell), `fig_settlement_zopa` (settlement price vs ZOPA band by cell).
  - §2: `fig_latency_emitter` (box latency_ms by human/AI × role), `fig_latency_arc` (median latency × turn number, line by mode2), `fig_tokens_cell` (tokens_total by cell box).
  - §3: `fig_routing` (alternation_rate by cell box), `fig_declare_timing` (declare_turn vs turns_consumed scatter / declare_latency by cell).
  - §4: `fig_screen_dwell` (per-screen mean dwell stacked/grouped bar), `fig_engine_dwell` (engine_dwell_s by cell box), `fig_attention` (total_idle_s & n_tab_away by cell), `fig_listing_engagement` (n_thumbnail_views / zoom by cell), `fig_human_cadence` (mean_compose_s & mean_charcount buyer vs seller, Human-to-AI only).
- `ALL_FIGURES: list[tuple[str, callable]]` enumerating every builder.

- [ ] **Step 1: smoke test** — `tests/test_viz.py`:

```python
from scripts.analysis.process_report.db import connect
from scripts.analysis.process_report.viz import ALL_FIGURES


def test_all_figures_render():
    con = connect()
    assert len(ALL_FIGURES) >= 12
    for name, fn in ALL_FIGURES:
        p = fn(con)
        assert p.exists() and p.stat().st_size > 800, name
```

- [ ] **Step 2: run, expect ImportError.**
- [ ] **Step 3: implement `viz.py`.** Colorblind-safe; every figure titled; captions handled in report. Use matplotlib for boxes/scatter/bars, plotnine for the faceted offer-path & raincloud-style. Honest small-N (show points). No project imports.
- [ ] **Step 4: run, expect pass (≥12 figures render).**
- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: standalone palette + all pillar figures\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 6: `docx_build.py` + tests

**Files:** create `scripts/analysis/process_report/docx_build.py`, `tests/test_docx_build.py`

`docx_build.py` (python-docx only): `new_doc()`, `h1(doc,t)`, `h2(doc,t)`, `para(doc,t,italic=False)`, `figure(doc,path,caption,note)` (insert image ~6in wide + caption + italic note), `table(doc,df,caption,note)` (header + rows, stringified).

- [ ] **Step 1: test** — `tests/test_docx_build.py`:

```python
import pandas as pd
from scripts.analysis.process_report.docx_build import (
    new_doc, h1, para, table,
)


def test_doc_helpers(tmp_path):
    d = new_doc()
    h1(d, "Sec")
    para(d, "x", italic=True)
    table(d, pd.DataFrame({"a": [1], "b": [2]}), "Cap", "note")
    out = tmp_path / "t.docx"
    d.save(out)
    assert out.exists() and out.stat().st_size > 0
```

- [ ] **Step 2-4:** run (fail→implement→pass).
- [ ] **Step 5: commit** — `git add scripts/analysis/process_report && git commit -m "process-report: standalone python-docx assembler\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 7: `report.py` orchestrator + stats tables

**Files:** create `scripts/analysis/process_report/report.py`, `tests/test_report.py`

`report.py`:
- `TBL = Path("docs/reports/tables-process")`; `_csv(df,name)` writes there.
- A helper `stats_block(con, frame, dvs) -> pd.DataFrame` → for each DV: SRH (`mode_p,mode_eta2,role_p,role_eta2,inter_p`), MW mode (`mw_mode_p,mw_mode_delta,ci_lo,ci_hi`), MW role (`mw_role_p,mw_role_delta`), KW 4-cell (`kw_p,kw_eps2`). Continuous DVs only; binary DVs (`degraded`, deal) use `fisher_2x2` for mode & role and go in a separate small table.
- `build()`:
  - `h1 "Negotiation Process & Interaction Dynamics"`; §0 method/sample para (40 completers, 4 cells, exploratory; 3 limitations).
  - §1 Bargaining: metric-dictionary table; `fig_offer_paths`, `fig_concession_box`, `fig_surplus_split`, `fig_settlement_zopa`; descriptives (bargaining_frame grouped by cell: medians) table; `stats_block` over the §1 DVs (spec list) table.
  - §2 Tempo: dictionary; `fig_latency_emitter`, `fig_latency_arc`, `fig_tokens_cell`; descriptives; stats_block over §2 DVs.
  - §3 Orchestrator: dictionary; `fig_routing`, `fig_declare_timing`; descriptives; stats_block over §3 continuous DVs + Fisher table for `degraded`.
  - §4 UX: dictionary; `fig_screen_dwell`, `fig_engine_dwell`, `fig_attention`, `fig_listing_engagement`, `fig_human_cadence`; descriptives; stats_block over §4 DVs + a Human-to-AI buyer-vs-seller MW table for `mean_compose_s,mean_charcount`.
  - Closing limitations para.
  - Save → `docs/reports/2026-05-15-negotiation-process-report.docx`; print bytes.
- Every test-bearing caption: "exploratory; n=10/cell; uncorrected".

- [ ] **Step 1: test** — `tests/test_report.py`:

```python
import ast
import pathlib
from docx import Document
from scripts.analysis.process_report.report import build, OUT


def test_no_project_imports():
    pkg = pathlib.Path("scripts/analysis/process_report")
    for f in pkg.rglob("*.py"):
        tree = ast.parse(f.read_text())
        for n in ast.walk(tree):
            mod = ""
            if isinstance(n, ast.Import):
                mod = " ".join(a.name for a in n.names)
            elif isinstance(n, ast.ImportFrom):
                mod = n.module or ""
            assert "scripts.analysis.human_pilot" not in mod, f
            assert "scripts.analysis.core" not in mod, f


def test_build():
    build()
    assert OUT.exists()
    d = Document(OUT)
    txt = "\n".join(p.text for p in d.paragraphs)
    for s in ["Negotiation Process", "1.", "2.", "3.", "4.",
              "exploratory"]:
        assert s in txt, s
    imgs = sum(1 for r in d.part.rels.values() if "image" in r.reltype)
    assert imgs >= 12
```

- [ ] **Step 2: run, expect ImportError/fail.**
- [ ] **Step 3: implement `report.py`** per the structure above; `OUT = Path("docs/reports/2026-05-15-negotiation-process-report.docx")`.
- [ ] **Step 4: build + verify** — `python -m scripts.analysis.process_report.report` (no traceback) then `python -m pytest scripts/analysis/process_report -q` (all green).
- [ ] **Step 5: commit** (incl. build outputs) — `git add scripts/analysis/process_report docs/reports/2026-05-15-negotiation-process-report.docx docs/reports/figures-process docs/reports/tables-process && git commit -m "process-report: orchestrator + SRH/MW/KW stats blocks + .docx build\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`

---

## Task 8: Final verification

- [ ] **Step 1: process suite** — `python -m pytest scripts/analysis/process_report -q` → all green.
- [ ] **Step 2: existing suite unaffected** — `python -m pytest scripts/analysis/tests -q` → still 29 green (we touched nothing there).
- [ ] **Step 3: clean-room + acceptance**

```bash
source .venv/bin/activate && python -c "
import sys, pathlib, ast
from docx import Document
pkg=pathlib.Path('scripts/analysis/process_report')
for f in pkg.rglob('*.py'):
    s=f.read_text()
    assert 'scripts.analysis.human_pilot' not in s and 'scripts.analysis.core' not in s, f
import scripts.analysis.process_report.report as R
assert 'anthropic' not in sys.modules
d=Document(R.OUT); txt='\n'.join(p.text for p in d.paragraphs)
for s in ['Negotiation Process & Interaction Dynamics','1.','2.','3.','4.','exploratory','n=10/cell']:
    assert s in txt, s
print('acceptance OK; images',sum(1 for r in d.part.rels.values() if 'image' in r.reltype),'tables',len(d.tables))
"
```
Expected: `acceptance OK; images ≥12 …`.

- [ ] **Step 4: final commit if anything uncommitted** — `git status --porcelain`; if only `.venv`/`__pycache__`/unrelated: nothing to do (Task 7 committed outputs); else `git add docs/reports/2026-05-15-negotiation-process-report.docx docs/reports/figures-process docs/reports/tables-process && git commit -m "process-report: finalize build outputs\n\nCo-Authored-By: RuFlo <ruv@ruv.net>"`.

---

## Self-Review

**1. Spec coverage:** db (T1), stats SRH/MW/KW/Fisher/bootstrap (T2), parsers + reservation-uniformity-raise (T3), all-4-pillar metric frames (T4), ≥12 figures (T5), docx helpers (T6), orchestrator + SRH+MW+KW stats blocks + §0–§4 + limitations (T7), full verification incl. clean-room + existing-suite-unaffected (T8). Every spec acceptance criterion maps to a task step.

**2. Placeholder scan:** No TBD. Algorithmic-risk modules (stats, extract, db) carry full code. Metrics/viz/report carry exact signatures, return columns, derivation formulas, figure inventory, docx section order, and exact test assertions — deterministic to implement. Seller-reservation regex has an explicit "read one pack & adjust minimally, keep buyer ground truth, never weaken the raise" instruction (not a placeholder — a bounded calibration step). `ENGINE_SCREEN` is computed empirically with a stated rule, not hardcoded.

**3. Type consistency:** `connect()→sqlite3.Connection` used by every `extract`/`metrics`/`viz`/`report` fn. `scheirer_ray_hare` returns `{"A":{H,p,eta2,df},"B","AB","N"}` consumed by `stats_block` (A→mode_*, B→role_*, AB→inter_*). `mann_whitney`→`{U,p,cliffs_delta,n_a,n_b}`; `kruskal_wallis`→`{H,p,eps2}`; `fisher_2x2`→`{odds_ratio,p,rate_a,rate_b,...}`; `bootstrap_ci`→`(lo,hi)` — all consumed consistently in `stats_block`. Metric frames keyed `participant_id/session_id/cell`; `CELLS`/`MODE2` defined once in `db.py`. Figure builders all `(con)->Path`; `ALL_FIGURES` consumed by `report` and the viz smoke test. Clean-room enforced by an AST test in T7 + grep in T8.
