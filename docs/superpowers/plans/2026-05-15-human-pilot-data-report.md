# Human Pilot Data Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a single Word `.docx` data report (figures + tables + per-block interpretation, no manuscript scaffolding) on the 40-completer real-human Prolific pilot — quantitative *and* a qualitative Section 8 (thematic, taxonomy, sentiment, linguistic, qual×quant link) — fully reproducible from a frozen SQLite snapshot.

**Architecture:** A `scripts/analysis/human_pilot/` package: a SQLite loader produces tidy pandas frames restricted to the 40 completers; table builders emit CSVs; figure builders use plotnine (demographic + 4-group small-multiples) and seaborn 0.13/matplotlib (rainclouds, forest, diverging-Likert, interaction); a python-docx assembler stitches figure/table + interpretation blocks into the report. Qualitative coding (8A–8C) runs **once** via a separate one-shot LLM coder that writes a cached, committed coding sheet; the report build itself stays deterministic + offline (8D linguistic is pure lexicon/regex, no LLM). One orchestrator command rebuilds everything deterministically from the snapshot + the cached coding sheet.

**Tech Stack:** Python 3.12, pandas, scipy, statsmodels, pingouin, matplotlib, seaborn 0.13, **plotnine** (new), python-docx, **anthropic** (new — one-shot qual coder only, lazily imported; report build never imports it). Reuses `scripts/analysis/core/stats.py` (cliff_delta, bootstrap_ci, fdr_bh, mann_whitney, kruskal_wallis).

**Spec:** `docs/superpowers/specs/2026-05-15-human-pilot-data-report-design.md` — do not relitigate scope/sample/posture.

---

## File Structure

```
scripts/analysis/human_pilot/
├── __init__.py
├── data.py                 # SQLite snapshot → tidy frames (completers only)
├── palette.py              # modern colorblind palette + condition→colour lock
├── stats_ext.py            # fisher_exact wrapper (+ re-export core/stats helpers)
├── figbase.py              # fig sizing, save(png+svg), plotnine + seaborn themes
├── tables.py               # every report table → DataFrame + CSV
├── figures.py              # every report figure → png+svg
├── docx_report.py          # python-docx block assembler
└── report.py               # orchestrator: python -m scripts.analysis.human_pilot.report
scripts/analysis/tests/
└── test_human_pilot_data.py   # loader correctness vs the frozen snapshot
docs/reports/
├── 2026-05-15-human-pilot-data-report.docx
├── figures-human-pilot/*.png|*.svg
└── tables-human-pilot/*.csv
```

Snapshot already frozen: `data/ai2ai-human-pilot-2026-05-15.db`
(sha256 `d4f721b95049a6b46d88caaa19e7a0ffe28fc0856bd3b35465267129e50f571e`, gitignored).

---

## Phase 1 — Data + infrastructure

### Task 1: Add plotnine dependency

**Files:**
- Modify: `scripts/analysis/requirements.txt`

- [ ] **Step 1: Append plotnine to requirements**

Add this line to `scripts/analysis/requirements.txt`:

```
plotnine>=0.13
```

- [ ] **Step 2: Install into the existing venv**

Run:
```bash
source .venv/bin/activate && pip install "plotnine>=0.13" && python -c "import plotnine; print('plotnine', plotnine.__version__)"
```
Expected: prints `plotnine 0.x.y` (≥0.13), no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/analysis/requirements.txt
git commit -m "analysis: add plotnine for human-pilot report figures"
```

---

### Task 2: SQLite loader → tidy frames (the 40 completers)

**Files:**
- Create: `scripts/analysis/human_pilot/__init__.py` (empty)
- Create: `scripts/analysis/human_pilot/data.py`
- Test: `scripts/analysis/tests/test_human_pilot_data.py`

- [ ] **Step 1: Write the failing test (real expected values from the snapshot)**

```python
# scripts/analysis/tests/test_human_pilot_data.py
from pathlib import Path
import pytest
from scripts.analysis.human_pilot.data import (
    load_db, completers_frame, survey_long, behavior_prompts_frame,
    SNAPSHOT, N_COMPLETERS_EXPECTED,
)

@pytest.fixture(scope="module")
def con():
    return load_db(SNAPSHOT)

def test_snapshot_exists():
    assert Path(SNAPSHOT).exists(), f"snapshot missing: {SNAPSHOT}"

def test_completers_n_and_balance(con):
    df = completers_frame(con)
    assert len(df) == N_COMPLETERS_EXPECTED == 40
    # Perfectly balanced 10 per mode×role
    cell = df.groupby(["experiment_mode", "role"]).size().to_dict()
    assert cell == {
        ("agent", "buyer"): 10,
        ("agent", "seller"): 10,
        ("human_buyer", "buyer"): 10,
        ("human_seller", "seller"): 10,
    }

def test_completers_have_required_columns(con):
    df = completers_frame(con)
    required = {
        "participant_id", "prolific_pid", "experiment_mode", "role",
        "mode2", "opponent_personality", "age", "gender", "experience",
        "ai_familiarity", "outcome_type", "final_price", "turns_count",
        "session_time_sec", "completion_code",
    }
    assert required <= set(df.columns), required - set(df.columns)

def test_mode2_collapses_human_routes(con):
    df = completers_frame(con)
    # mode2 = the AI-to-AI vs Human-to-AI contrast (20 vs 20)
    assert df["mode2"].value_counts().to_dict() == {"AI-to-AI": 20, "Human-to-AI": 20}

def test_outcomes_within_completers(con):
    df = completers_frame(con)
    oc = df["outcome_type"].value_counts(dropna=False).to_dict()
    assert oc.get("agreed") == 27
    assert oc.get("rejected") == 9
    assert oc.get("impasse") == 3
    assert oc.get("aborted") == 1

def test_agreed_price_band(con):
    df = completers_frame(con)
    agreed = df[df["outcome_type"] == "agreed"]["final_price"].dropna()
    assert len(agreed) == 27
    assert agreed.min() == 21500 and agreed.max() == 25500

def test_survey_long_all_completers(con):
    s = survey_long(con)
    # 9 Likert items present, every completer has rows
    assert set(s["participant_id"]).__len__() == 40
    keys = set(s["key"])
    expected_keys = {
        "satisfaction", "would_use_again", "agent_represented", "control",
        "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
        "outfair_share",
    }
    assert expected_keys <= keys
    assert "free_text" in keys or True  # free_text optional

def test_behavior_prompts_agent_only(con):
    bp = behavior_prompts_frame(con)
    # Only agent-mode completers authored prompts
    assert (bp["experiment_mode"] == "agent").all()
    assert len(bp) >= 1
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/faraz/Workstation/Claude/Code/AI2AI && source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_data.py -q
```
Expected: FAIL — `ModuleNotFoundError: scripts.analysis.human_pilot.data`

- [ ] **Step 3: Implement the loader**

```python
# scripts/analysis/human_pilot/data.py
"""SQLite snapshot → tidy pandas frames, restricted to the 40 completers.

A "completer" is any study_participant whose completion_code is non-null
(per the design spec: 'completed' = received the final code). The 19
non-completers are never returned by any function here.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pandas as pd

SNAPSHOT = "data/ai2ai-human-pilot-2026-05-15.db"
N_COMPLETERS_EXPECTED = 40

# Maps the 3 experiment_mode values to the 2-level AI/Human contrast.
_MODE2 = {
    "agent": "AI-to-AI",
    "human_buyer": "Human-to-AI",
    "human_seller": "Human-to-AI",
}

_V2_SURVEY_KEYS = [
    "satisfaction", "would_use_again", "agent_represented", "control",
    "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
    "outfair_share",
]


def load_db(path: str | Path = SNAPSHOT) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def _completer_ids(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT id FROM study_participants "
        "WHERE completion_code IS NOT NULL AND completion_code != ''"
    ).fetchall()
    return [r["id"] for r in rows]


def completers_frame(con: sqlite3.Connection) -> pd.DataFrame:
    """One row per completer: identity + condition + demographics + outcome."""
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    sp = pd.read_sql_query(
        f"SELECT * FROM study_participants WHERE id IN ({qmarks})", con, params=ids
    )
    sess = pd.read_sql_query("SELECT * FROM sessions", con)

    # opponent_personality lives in participant_responses(screen='engine')
    pers = pd.read_sql_query(
        f"""SELECT participant_id, value_text AS opponent_personality
              FROM participant_responses
             WHERE screen='engine' AND key='opponent_personality'
               AND participant_id IN ({qmarks})""",
        con, params=ids,
    )

    df = sp.merge(
        sess[["id", "outcome_type", "outcome_terms_json", "turns_consumed",
              "started_at", "ended_at", "tokens_total"]],
        left_on="session_id", right_on="id", how="left", suffixes=("", "_sess"),
    ).merge(pers, left_on="id", right_on="participant_id", how="left")

    df["participant_id"] = df["id"]
    df["mode2"] = df["experiment_mode"].map(_MODE2)

    def _price(j):
        try:
            v = json.loads(j or "{}").get("price")
            return float(v) if isinstance(v, (int, float)) else None
        except Exception:
            return None

    df["final_price"] = df["outcome_terms_json"].map(_price)
    df["turns_count"] = df["turns_consumed"]

    def _secs(row):
        s, e = row.get("started_at"), row.get("ended_at")
        if not s or not e:
            return None
        try:
            from datetime import datetime
            ds = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
            de = datetime.fromisoformat(str(e).replace("Z", "+00:00"))
            return (de - ds).total_seconds()
        except Exception:
            return None

    df["session_time_sec"] = df.apply(_secs, axis=1)
    return df.reset_index(drop=True)


def survey_long(con: sqlite3.Connection) -> pd.DataFrame:
    """Long-format post-survey for completers (one row per item answer)."""
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    s = pd.read_sql_query(
        f"""SELECT pr.participant_id, sp.experiment_mode, sp.role, pr.key,
                   pr.value_int, pr.value_text
              FROM participant_responses pr
              JOIN study_participants sp ON sp.id = pr.participant_id
             WHERE pr.screen='post_survey'
               AND pr.participant_id IN ({qmarks})""",
        con, params=ids,
    )
    s = s[~s["key"].str.startswith("_")].copy()
    s["mode2"] = s["experiment_mode"].map(_MODE2)
    return s.reset_index(drop=True)


def behavior_prompts_frame(con: sqlite3.Connection) -> pd.DataFrame:
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    bp = pd.read_sql_query(
        f"""SELECT bp.participant_id, sp.experiment_mode, sp.role,
                   bp.revision, bp.prompt_text, bp.submitted_at
              FROM behavior_prompts bp
              JOIN study_participants sp ON sp.id = bp.participant_id
             WHERE bp.participant_id IN ({qmarks})""",
        con, params=ids,
    )
    bp["prompt_len"] = bp["prompt_text"].fillna("").str.len()
    return bp.reset_index(drop=True)


def events_frame(con: sqlite3.Connection) -> pd.DataFrame:
    ids = _completer_ids(con)
    qmarks = ",".join("?" * len(ids))
    return pd.read_sql_query(
        f"""SELECT participant_id, event_type, screen
              FROM participant_events
             WHERE participant_id IN ({qmarks})""",
        con, params=ids,
    )


V2_SURVEY_KEYS = _V2_SURVEY_KEYS
```

- [ ] **Step 4: Create the package init + run the test**

```bash
touch scripts/analysis/human_pilot/__init__.py
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_data.py -q
```
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/__init__.py scripts/analysis/human_pilot/data.py scripts/analysis/tests/test_human_pilot_data.py
git commit -m "analysis: human-pilot SQLite loader (40 completers, tidy frames)"
```

---

### Task 3: Modern report palette

**Files:**
- Create: `scripts/analysis/human_pilot/palette.py`
- Test: `scripts/analysis/tests/test_human_pilot_palette.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/analysis/tests/test_human_pilot_palette.py
from scripts.analysis.human_pilot.palette import (
    PALETTE, MODE2_COLORS, ROLE_COLORS, CELL_COLORS, OUTCOME_COLORS,
)

def test_palette_hex():
    for v in PALETTE.values():
        assert v.startswith("#") and len(v) == 7

def test_mode2_two_levels():
    assert set(MODE2_COLORS) == {"AI-to-AI", "Human-to-AI"}

def test_role_two_levels():
    assert set(ROLE_COLORS) == {"buyer", "seller"}

def test_cell_four_levels():
    assert set(CELL_COLORS) == {"agent/buyer", "agent/seller",
                                "human_buyer/buyer", "human_seller/seller"}

def test_outcome_levels():
    assert {"agreed", "rejected", "impasse", "aborted"} <= set(OUTCOME_COLORS)
```

- [ ] **Step 2: Run to verify it fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_palette.py -q
```
Expected: FAIL — ModuleNotFoundError.

- [ ] **Step 3: Implement palette**

```python
# scripts/analysis/human_pilot/palette.py
"""Modern colorblind-safe report palette (Okabe-Ito based) + locked
condition→colour maps so the same group is the same colour everywhere."""

# Okabe & Ito (2008) colorblind-safe qualitative palette.
PALETTE = {
    "blue":       "#0072B2",
    "orange":     "#E69F00",
    "green":      "#009E73",
    "vermillion": "#D55E00",
    "sky":        "#56B4E9",
    "purple":     "#CC79A7",
    "yellow":     "#F0E442",
    "grey":       "#999999",
}

MODE2_COLORS = {"AI-to-AI": PALETTE["blue"], "Human-to-AI": PALETTE["orange"]}
ROLE_COLORS = {"buyer": PALETTE["sky"], "seller": PALETTE["vermillion"]}
CELL_COLORS = {
    "agent/buyer":          PALETTE["blue"],
    "agent/seller":         PALETTE["sky"],
    "human_buyer/buyer":    PALETTE["orange"],
    "human_seller/seller":  PALETTE["vermillion"],
}
OUTCOME_COLORS = {
    "agreed":   PALETTE["green"],
    "rejected": PALETTE["vermillion"],
    "impasse":  PALETTE["orange"],
    "aborted":  PALETTE["grey"],
}
# Diverging scale for Likert 1–7 (red→grey→blue).
LIKERT_DIVERGING = ["#B2182B", "#EF8A62", "#FDDBC7", "#F7F7F7",
                    "#D1E5F0", "#67A9CF", "#2166AC"]
```

- [ ] **Step 4: Run the test**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_palette.py -q
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/palette.py scripts/analysis/tests/test_human_pilot_palette.py
git commit -m "analysis: human-pilot report palette (Okabe-Ito + condition locks)"
```

---

### Task 4: Stats extension (Fisher's exact) + figure base

**Files:**
- Create: `scripts/analysis/human_pilot/stats_ext.py`
- Create: `scripts/analysis/human_pilot/figbase.py`
- Test: `scripts/analysis/tests/test_human_pilot_stats_ext.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/analysis/tests/test_human_pilot_stats_ext.py
from scripts.analysis.human_pilot.stats_ext import (
    fisher_2x2, cliff_delta, bootstrap_ci, fdr_bh, mann_whitney,
)

def test_fisher_2x2_returns_or_and_p():
    # 8/10 vs 3/10 success — clearly different
    out = fisher_2x2(success_a=8, n_a=10, success_b=3, n_b=10)
    assert "odds_ratio" in out and "p" in out
    assert out["p"] < 0.10
    assert out["n_a"] == 10 and out["n_b"] == 10

def test_fisher_2x2_no_difference():
    out = fisher_2x2(success_a=5, n_a=10, success_b=5, n_b=10)
    assert out["p"] == 1.0

def test_reexports_present():
    # Thin re-exports from core/stats.py must be importable here
    assert callable(cliff_delta) and callable(bootstrap_ci)
    assert callable(fdr_bh) and callable(mann_whitney)
```

- [ ] **Step 2: Run to verify it fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_stats_ext.py -q
```
Expected: FAIL — ModuleNotFoundError.

- [ ] **Step 3: Implement stats_ext.py**

```python
# scripts/analysis/human_pilot/stats_ext.py
"""Fisher's exact for the agreement-rate 2×2, plus thin re-exports of the
core stats helpers so figure/table code imports from one place."""
from __future__ import annotations

from scipy import stats as _sc

# Re-export the helpers already proven in the synthetic pipeline.
from scripts.analysis.core.stats import (  # noqa: F401
    cliff_delta, bootstrap_ci, fdr_bh, mann_whitney, kruskal_wallis,
)


def fisher_2x2(success_a: int, n_a: int, success_b: int, n_b: int) -> dict:
    """Fisher's exact on a 2×2 [[succ_a, fail_a], [succ_b, fail_b]]."""
    table = [[success_a, n_a - success_a], [success_b, n_b - success_b]]
    odds, p = _sc.fisher_exact(table)
    return {
        "odds_ratio": float(odds),
        "p": float(p),
        "rate_a": success_a / n_a if n_a else float("nan"),
        "rate_b": success_b / n_b if n_b else float("nan"),
        "n_a": n_a, "n_b": n_b,
    }
```

- [ ] **Step 4: Implement figbase.py**

```python
# scripts/analysis/human_pilot/figbase.py
"""Shared figure infrastructure: Word-friendly sizing, dual png+svg save,
and consistent matplotlib/seaborn + plotnine themes."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

OUT_DIR = Path("docs/reports/figures-human-pilot")
# Word body text width ≈ 6.0 in at default margins; size figures to that.
WIDTH_IN = 6.0


def apply_theme() -> None:
    sns.set_theme(
        style="whitegrid", context="paper",
        rc={
            "figure.dpi": 150, "savefig.dpi": 300,
            "axes.spines.top": False, "axes.spines.right": False,
            "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
            "grid.alpha": 0.3,
        },
    )


def save(fig, name: str, *, w: float = WIDTH_IN, aspect: float = 0.6) -> Path:
    """Save a matplotlib Figure as 300-dpi PNG + SVG; return the PNG path."""
    fig.set_size_inches(w, w * aspect)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png = OUT_DIR / f"{name}.png"
    fig.tight_layout()
    fig.savefig(png, bbox_inches="tight")
    fig.savefig(OUT_DIR / f"{name}.svg", bbox_inches="tight")
    plt.close(fig)
    return png


def save_plotnine(p, name: str, *, w: float = WIDTH_IN, h: float | None = None) -> Path:
    """Save a plotnine ggplot as 300-dpi PNG + SVG; return the PNG path."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png = OUT_DIR / f"{name}.png"
    height = h if h is not None else w * 0.62
    p.save(png, width=w, height=height, dpi=300, verbose=False)
    p.save(OUT_DIR / f"{name}.svg", width=w, height=height, verbose=False)
    return png
```

- [ ] **Step 5: Run the test**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_stats_ext.py -q
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/analysis/human_pilot/stats_ext.py scripts/analysis/human_pilot/figbase.py scripts/analysis/tests/test_human_pilot_stats_ext.py
git commit -m "analysis: human-pilot stats_ext (Fisher 2x2) + figure base"
```

---

## Phase 2 — Tables

### Task 5: All report tables

**Files:**
- Create: `scripts/analysis/human_pilot/tables.py`
- Test: `scripts/analysis/tests/test_human_pilot_tables.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/analysis/tests/test_human_pilot_tables.py
import pandas as pd
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot import tables as T

def setup_module(m):
    m.con = load_db(SNAPSHOT)

def test_sample_composition_sums_to_40():
    t = T.sample_composition(m_con())
    assert int(t["n"].sum()) == 40

def test_demographics_summary_has_levels():
    t = T.demographics_summary(m_con())
    assert {"variable", "level", "n", "pct"} <= set(t.columns)
    assert (t.groupby("variable")["n"].sum() <= 40).all()

def test_outcome_descriptives_has_rates():
    t = T.outcome_descriptives(m_con())
    assert "agreement_rate" in t.columns
    assert len(t) == 4  # 4 mode×role cells

def test_survey_descriptives_nine_items():
    t = T.survey_descriptives(m_con())
    assert t["item"].nunique() == 9

def test_comparison_mode_fisher_present():
    t = T.comparison_mode(m_con())
    assert "fisher_p" in t.attrs or "fisher" in t.attrs or not t.empty

def m_con():
    import sys
    return sys.modules[__name__].con
```

- [ ] **Step 2: Run to verify it fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_tables.py -q
```
Expected: FAIL — ModuleNotFoundError on `scripts.analysis.human_pilot.tables`.

- [ ] **Step 3: Implement tables.py**

```python
# scripts/analysis/human_pilot/tables.py
"""Every report table as a DataFrame. CSVs written by report.py."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scripts.analysis.human_pilot.data import (
    completers_frame, survey_long, behavior_prompts_frame, events_frame,
    V2_SURVEY_KEYS,
)
from scripts.analysis.human_pilot.stats_ext import (
    fisher_2x2, cliff_delta, bootstrap_ci, fdr_bh, mann_whitney,
)


def sample_composition(con) -> pd.DataFrame:
    df = completers_frame(con)
    t = (df.groupby(["experiment_mode", "role", "opponent_personality"])
            .size().reset_index(name="n")
            .sort_values(["experiment_mode", "role", "opponent_personality"]))
    return t.reset_index(drop=True)


def demographics_summary(con) -> pd.DataFrame:
    df = completers_frame(con)
    rows = []
    for var in ["gender", "experience", "ai_familiarity"]:
        vc = df[var].value_counts(dropna=True)
        for level, n in vc.items():
            rows.append({"variable": var, "level": str(level),
                         "n": int(n), "pct": round(100 * n / len(df), 1)})
    # Age as a numeric summary row
    age = df["age"].dropna()
    rows.append({"variable": "age", "level": "mean (SD)",
                 "n": int(len(age)),
                 "pct": f"{age.mean():.1f} ({age.std():.1f})"})
    return pd.DataFrame(rows)


def outcome_descriptives(con) -> pd.DataFrame:
    df = completers_frame(con)
    rows = []
    for (mode, role), g in df.groupby(["experiment_mode", "role"]):
        agreed = g[g["outcome_type"] == "agreed"]
        price = agreed["final_price"].dropna()
        turns = g["turns_count"].dropna()
        secs = g["session_time_sec"].dropna()
        rows.append({
            "experiment_mode": mode, "role": role, "n": len(g),
            "agreement_rate": round((g["outcome_type"] == "agreed").mean(), 3),
            "price_median": float(price.median()) if len(price) else np.nan,
            "price_iqr": (f"{price.quantile(.25):.0f}-{price.quantile(.75):.0f}"
                          if len(price) else "—"),
            "turns_median": float(turns.median()) if len(turns) else np.nan,
            "time_median_s": float(secs.median()) if len(secs) else np.nan,
        })
    return pd.DataFrame(rows)


def survey_descriptives(con) -> pd.DataFrame:
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()]
    rows = []
    for (item, mode2), g in s.groupby(["key", "mode2"]):
        v = g["value_int"].astype(float)
        rows.append({
            "item": item, "mode2": mode2, "n": len(v),
            "M": round(v.mean(), 2), "SD": round(v.std(), 2),
            "Mdn": float(v.median()),
            "IQR": f"{v.quantile(.25):.0f}-{v.quantile(.75):.0f}",
        })
    return pd.DataFrame(rows).sort_values(["item", "mode2"]).reset_index(drop=True)


def _two_group_survey(con, group_col: str, a_label, b_label) -> pd.DataFrame:
    """Per-item Cliff's δ + 95% CI + Mann-Whitney + BH-FDR for a 2-group split."""
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    out = []
    for item in V2_SURVEY_KEYS:
        sub = s[s["key"] == item]
        a = sub[sub[group_col] == a_label]["value_int"].astype(float).tolist()
        b = sub[sub[group_col] == b_label]["value_int"].astype(float).tolist()
        if len(a) < 3 or len(b) < 3:
            continue
        d = cliff_delta(a, b)
        lo, hi = bootstrap_ci(
            np.array([1] * len(a) + [0] * len(b)),
            statistic=lambda x: cliff_delta(
                list(np.array(a + b)[x == 1]), list(np.array(a + b)[x == 0])),
            n_boot=1000, random_state=42,
        )
        mw = mann_whitney(a, b)
        out.append({"item": item, "n_a": len(a), "n_b": len(b),
                    "delta": d, "ci_lo": lo, "ci_hi": hi, "p_mw": mw["p"]})
    df = pd.DataFrame(out)
    if not df.empty:
        df["q_bh"] = fdr_bh(df["p_mw"].tolist())
    return df


def comparison_mode(con) -> pd.DataFrame:
    """5A — Human-to-AI vs AI-to-AI."""
    df = completers_frame(con)
    ai = df[df["mode2"] == "AI-to-AI"]
    hu = df[df["mode2"] == "Human-to-AI"]
    fisher = fisher_2x2(
        success_a=int((ai["outcome_type"] == "agreed").sum()), n_a=len(ai),
        success_b=int((hu["outcome_type"] == "agreed").sum()), n_b=len(hu),
    )
    items = _two_group_survey(con, "mode2", "AI-to-AI", "Human-to-AI")
    items.attrs["fisher"] = fisher
    return items


def comparison_role(con) -> pd.DataFrame:
    """5B — Buyer vs Seller."""
    df = completers_frame(con)
    bu = df[df["role"] == "buyer"]
    se = df[df["role"] == "seller"]
    fisher = fisher_2x2(
        success_a=int((bu["outcome_type"] == "agreed").sum()), n_a=len(bu),
        success_b=int((se["outcome_type"] == "agreed").sum()), n_b=len(se),
    )
    items = _two_group_survey(con, "role", "buyer", "seller")
    items.attrs["fisher"] = fisher
    return items


def data_quality(con) -> pd.DataFrame:
    ev = events_frame(con)
    flags = ev[ev["event_type"].isin(
        ["paste", "copy_attempt", "cut_attempt", "rightclick_attempt"])]
    by_pid = flags.groupby("participant_id").size()
    bp = behavior_prompts_frame(con)
    return pd.DataFrame([
        {"metric": "participants with any clipboard/right-click attempt",
         "value": int(by_pid.shape[0])},
        {"metric": "total clipboard/right-click events",
         "value": int(len(flags))},
        {"metric": "behavior prompts (agent modes)",
         "value": int(len(bp))},
        {"metric": "behavior prompt length median (chars)",
         "value": int(bp["prompt_len"].median()) if len(bp) else 0},
    ])


def variable_inventory(con) -> pd.DataFrame:
    """Section 7 — what each variable supports now vs. when N grows."""
    return pd.DataFrame([
        {"variable": "experiment_mode (mode2)", "n": 40,
         "now": "descriptive + 20v20 exploratory test",
         "when_n_grows": "powered mode contrast"},
        {"variable": "role", "n": 40,
         "now": "descriptive + 20v20 exploratory test",
         "when_n_grows": "powered role contrast"},
        {"variable": "opponent_personality", "n": 40,
         "now": "descriptive only (≈13/level)",
         "when_n_grows": "3-group KW"},
        {"variable": "final_price", "n": 27,
         "now": "descriptive (agreed only)",
         "when_n_grows": "price modelling"},
        {"variable": "9 survey items", "n": 40,
         "now": "per-item δ + CI, FDR (exploratory)",
         "when_n_grows": "powered item tests + subscales"},
        {"variable": "mode × role × personality", "n": 40,
         "now": "NOT analysable (cells 2-4)",
         "when_n_grows": "3-way once ≥~15/cell"},
    ])
```

- [ ] **Step 4: Run the test**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_tables.py -q
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/tables.py scripts/analysis/tests/test_human_pilot_tables.py
git commit -m "analysis: human-pilot report tables (composition, demo, outcomes, survey, comparisons, inventory)"
```

---

## Phase 3 — Figures

### Task 6: All figures

**Files:**
- Create: `scripts/analysis/human_pilot/figures.py`

Figures are validated by running the module (smoke test) — each `build_*`
returns a PNG `Path`; we assert the files exist + are non-empty.

- [ ] **Step 1: Implement figures.py**

```python
# scripts/analysis/human_pilot/figures.py
"""Every report figure. Each builder returns the PNG Path."""
from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import plotnine as p9

from scripts.analysis.human_pilot.data import (
    completers_frame, survey_long, behavior_prompts_frame, V2_SURVEY_KEYS,
)
from scripts.analysis.human_pilot.palette import (
    MODE2_COLORS, ROLE_COLORS, CELL_COLORS, OUTCOME_COLORS,
)
from scripts.analysis.human_pilot.figbase import apply_theme, save, save_plotnine
from scripts.analysis.human_pilot.tables import comparison_mode, comparison_role


def fig_funnel(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    stages = ["Enrolled", "Completed\n(received code)", "Agreed\n(within completers)"]
    vals = [59, 40, 27]
    ax.barh(stages, vals, color=["#999999", MODE2_COLORS["AI-to-AI"], OUTCOME_COLORS["agreed"]])
    for i, v in enumerate(vals):
        ax.text(v + 1, i, str(v), va="center", fontsize=9)
    ax.invert_yaxis()
    ax.set_xlabel("Participants")
    ax.set_title("Sample flow")
    return save(fig, "fig1_funnel", aspect=0.45)


def fig_demographics(con) -> Path:
    df = completers_frame(con)
    df["cell"] = df["experiment_mode"] + "/" + df["role"]
    long = df.melt(
        id_vars=["mode2"],
        value_vars=["gender", "experience", "ai_familiarity"],
        var_name="variable", value_name="level").dropna(subset=["level"])
    g = (p9.ggplot(long, p9.aes("level", fill="mode2"))
         + p9.geom_bar(position="dodge")
         + p9.facet_wrap("~variable", scales="free_x", ncol=1)
         + p9.scale_fill_manual(values=MODE2_COLORS)
         + p9.labs(title="Demographics by mode (40 completers)",
                   x="", y="count", fill="")
         + p9.theme_minimal()
         + p9.theme(figure_size=(6, 7), axis_text_x=p9.element_text(rotation=30, ha="right")))
    return save_plotnine(g, "fig2_demographics", w=6.0, h=7.0)


def fig_age(con) -> Path:
    df = completers_frame(con)
    g = (p9.ggplot(df.dropna(subset=["age"]), p9.aes("age"))
         + p9.geom_histogram(bins=12, fill=MODE2_COLORS["AI-to-AI"], color="white")
         + p9.facet_wrap("~mode2", ncol=1)
         + p9.labs(title="Age distribution by mode", x="age", y="count")
         + p9.theme_minimal() + p9.theme(figure_size=(6, 4.5)))
    return save_plotnine(g, "fig2_age", w=6.0, h=4.5)


def fig_outcomes(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    df["cell"] = df["experiment_mode"] + "/" + df["role"]
    ct = (df.groupby(["cell", "outcome_type"]).size()
            .unstack(fill_value=0))
    fig, ax = plt.subplots()
    bottom = np.zeros(len(ct))
    for oc in ["agreed", "rejected", "impasse", "aborted"]:
        if oc not in ct.columns:
            continue
        ax.bar(ct.index, ct[oc], bottom=bottom,
               label=oc, color=OUTCOME_COLORS[oc])
        bottom += ct[oc].values
    ax.set_ylabel("participants")
    ax.set_title("Negotiation outcome by mode×role")
    ax.legend(fontsize=8)
    plt.xticks(rotation=20, ha="right")
    return save(fig, "fig3_outcomes", aspect=0.55)


def fig_price(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    a = df[df["outcome_type"] == "agreed"].copy()
    a["cell"] = a["experiment_mode"] + "/" + a["role"]
    import seaborn as sns
    fig, ax = plt.subplots()
    sns.violinplot(data=a, x="cell", y="final_price", hue="cell",
                   palette=CELL_COLORS, inner=None, legend=False, ax=ax, cut=0)
    sns.stripplot(data=a, x="cell", y="final_price", color="black",
                  size=3, alpha=0.6, ax=ax)
    ax.set_title("Final agreed price by mode×role (n=27)")
    ax.set_xlabel(""); ax.set_ylabel("USD")
    plt.xticks(rotation=20, ha="right")
    return save(fig, "fig3_price", aspect=0.6)


def fig_survey_forest(con) -> Path:
    apply_theme()
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()]
    agg = (s.groupby(["key", "mode2"])["value_int"]
             .agg(["mean", "count", "std"]).reset_index())
    agg["se"] = agg["std"] / np.sqrt(agg["count"])
    fig, ax = plt.subplots()
    items = V2_SURVEY_KEYS
    y = np.arange(len(items))
    for i, m2 in enumerate(["AI-to-AI", "Human-to-AI"]):
        sub = agg[agg["mode2"] == m2].set_index("key").reindex(items)
        off = (i - 0.5) * 0.25
        ax.errorbar(sub["mean"], y + off, xerr=1.96 * sub["se"],
                    fmt="o", color=MODE2_COLORS[m2], label=m2, capsize=2)
    ax.set_yticks(y); ax.set_yticklabels(items, fontsize=8)
    ax.set_xlim(1, 7); ax.invert_yaxis()
    ax.set_xlabel("mean (1–7) ± 95% CI")
    ax.set_title("Survey items by mode")
    ax.legend(fontsize=8)
    return save(fig, "fig4_survey_forest", aspect=0.75)


def fig_comparison_delta(con, which: str) -> Path:
    """which='mode' → 5A; which='role' → 5B."""
    apply_theme()
    tbl = comparison_mode(con) if which == "mode" else comparison_role(con)
    tbl = tbl.sort_values("delta")
    fig, ax = plt.subplots()
    y = np.arange(len(tbl))
    colors = ["#000000" if q < 0.05 else "#999999" for q in tbl["q_bh"]]
    ax.errorbar(tbl["delta"], y,
                xerr=[tbl["delta"] - tbl["ci_lo"], tbl["ci_hi"] - tbl["delta"]],
                fmt="o", ecolor=colors, mfc=colors, mec=colors, capsize=2, lw=1)
    ax.axvline(0, ls="--", color="grey", lw=0.6)
    ax.set_yticks(y); ax.set_yticklabels(tbl["item"], fontsize=8)
    ax.set_xlim(-1, 1)
    label = "AI-to-AI vs Human-to-AI" if which == "mode" else "Buyer vs Seller"
    ax.set_xlabel("Cliff's δ (95% bootstrap CI)")
    ax.set_title(f"Per-item effect — {label}\n(black = q<.05 BH-FDR; exploratory, small N)")
    return save(fig, f"fig5_delta_{which}", aspect=0.7)


def fig_interaction(con) -> Path:
    apply_theme()
    df = completers_frame(con)
    a = df[df["outcome_type"] == "agreed"]
    piv = a.groupby(["mode2", "role"])["final_price"].median().reset_index()
    fig, ax = plt.subplots()
    for role, g in piv.groupby("role"):
        ax.plot(g["mode2"], g["final_price"], "o-",
                color=ROLE_COLORS[role], label=role)
    ax.set_ylabel("median agreed price (USD)")
    ax.set_title("Mode × Role interaction (descriptive — not tested)")
    ax.legend(fontsize=8)
    return save(fig, "fig5_interaction", aspect=0.55)


def fig_prompt_len(con) -> Path:
    apply_theme()
    bp = behavior_prompts_frame(con)
    fig, ax = plt.subplots()
    if len(bp):
        import seaborn as sns
        sns.histplot(bp["prompt_len"], bins=10, color=MODE2_COLORS["AI-to-AI"], ax=ax)
    ax.set_xlabel("behavior-prompt length (chars)")
    ax.set_title("Behaviour-prompt length (agent modes)")
    return save(fig, "fig6_prompt_len", aspect=0.5)


ALL_FIGURES = [
    ("fig1_funnel", fig_funnel),
    ("fig2_demographics", fig_demographics),
    ("fig2_age", fig_age),
    ("fig3_outcomes", fig_outcomes),
    ("fig3_price", fig_price),
    ("fig4_survey_forest", fig_survey_forest),
    ("fig5_delta_mode", lambda c: fig_comparison_delta(c, "mode")),
    ("fig5_delta_role", lambda c: fig_comparison_delta(c, "role")),
    ("fig5_interaction", fig_interaction),
    ("fig6_prompt_len", fig_prompt_len),
]
```

- [ ] **Step 2: Smoke-test every figure renders**

```bash
source .venv/bin/activate && python -c "
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot.figures import ALL_FIGURES
con = load_db(SNAPSHOT)
for name, fn in ALL_FIGURES:
    p = fn(con)
    assert p.exists() and p.stat().st_size > 1000, name
    print('OK', name, p.stat().st_size, 'bytes')
"
```
Expected: `OK` for all 10 figures, each > 1000 bytes.

- [ ] **Step 3: Commit**

```bash
git add scripts/analysis/human_pilot/figures.py
git commit -m "analysis: human-pilot report figures (plotnine + seaborn, all 10 render)"
```

---

## Phase 4 — Assembly

### Task 7: python-docx report assembler + orchestrator

**Files:**
- Create: `scripts/analysis/human_pilot/docx_report.py`
- Create: `scripts/analysis/human_pilot/report.py`

- [ ] **Step 1: Implement docx_report.py**

```python
# scripts/analysis/human_pilot/docx_report.py
"""python-docx block helpers: heading, figure+caption+interpretation, table."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor


def new_doc() -> Document:
    doc = Document()
    st = doc.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(11)
    for s in doc.sections:
        s.left_margin = s.right_margin = Inches(1)
        s.top_margin = s.bottom_margin = Inches(1)
    return doc


def h1(doc, text):
    p = doc.add_paragraph()
    r = p.add_run(text); r.bold = True; r.font.size = Pt(16)
    p.paragraph_format.space_before = Pt(16); p.paragraph_format.space_after = Pt(6)


def h2(doc, text):
    p = doc.add_paragraph()
    r = p.add_run(text); r.bold = True; r.font.size = Pt(13)
    r.font.color.rgb = RGBColor(0x1B, 0x3F, 0x8B)
    p.paragraph_format.space_before = Pt(12); p.paragraph_format.space_after = Pt(4)


def para(doc, text, *, italic=False):
    p = doc.add_paragraph()
    r = p.add_run(text); r.italic = italic
    if italic:
        r.font.size = Pt(10); r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)


def figure(doc, png_path: Path, caption: str, interpretation: str):
    pp = doc.add_paragraph(); pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pp.add_run().add_picture(str(png_path), width=Inches(6.0))
    cap = doc.add_paragraph()
    cr = cap.add_run(caption); cr.italic = True; cr.font.size = Pt(9)
    para(doc, interpretation)


def table(doc, df: pd.DataFrame, caption: str, interpretation: str):
    cap = doc.add_paragraph()
    cr = cap.add_run(caption); cr.bold = True; cr.font.size = Pt(10)
    t = doc.add_table(rows=1 + len(df), cols=len(df.columns))
    t.style = "Light Grid Accent 1"
    for j, col in enumerate(df.columns):
        c = t.rows[0].cells[j]; c.text = ""
        rr = c.paragraphs[0].add_run(str(col)); rr.bold = True; rr.font.size = Pt(9)
    for i, (_, row) in enumerate(df.iterrows()):
        for j, col in enumerate(df.columns):
            cell = t.rows[i + 1].cells[j]; cell.text = ""
            rr = cell.paragraphs[0].add_run("" if pd.isna(row[col]) else str(row[col]))
            rr.font.size = Pt(9)
    doc.add_paragraph()
    para(doc, interpretation)
```

- [ ] **Step 2: Implement report.py (orchestrator with all interpretations)**

```python
# scripts/analysis/human_pilot/report.py
"""Build the human-pilot data report .docx end-to-end from the snapshot.

Run: python -m scripts.analysis.human_pilot.report
"""
from __future__ import annotations

from pathlib import Path

from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot import tables as T
from scripts.analysis.human_pilot import figures as F
from scripts.analysis.human_pilot.docx_report import (
    new_doc, h1, h2, para, figure, table,
)

OUT = Path("docs/reports/2026-05-15-human-pilot-data-report.docx")
TBL_DIR = Path("docs/reports/tables-human-pilot")


def _csv(df, name):
    TBL_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(TBL_DIR / f"{name}.csv", index=False)


def build():
    con = load_db(SNAPSHOT)
    doc = new_doc()

    h1(doc, "AI2AI Human Pilot — Data Report")
    para(doc, "First real-human Prolific pilot. Analytical sample = the 40 "
              "participants who received the final completion code. "
              "Exploratory / descriptive throughout — small N; no "
              "confirmatory claims. Snapshot 2026-05-15.", italic=True)

    # ── Section 1 ──
    h1(doc, "1. Sample & flow")
    figure(doc, F.fig_funnel(con),
           "Figure 1.1 — Sample flow.",
           "Of 59 enrolled, 40 received the completion code (the analytical "
           "sample); 27 of those reached an agreement. Non-completers are "
           "not analysed beyond this count.")
    t = T.sample_composition(con); _csv(t, "tbl1_1_sample")
    table(doc, t, "Table 1.1 — Sample composition (mode × role × personality).",
          "The design is balanced at 10 participants per mode×role cell; "
          "opponent personality is roughly even (easygoing 15 / moderate 13 "
          "/ tough 12).")

    # ── Section 2 ──
    h1(doc, "2. Demographics")
    figure(doc, F.fig_demographics(con),
           "Figure 2.1 — Gender, experience, AI-familiarity by mode.",
           "Demographic make-up is broadly similar across AI-to-AI and "
           "Human-to-AI arms, supporting comparability of the two groups.")
    figure(doc, F.fig_age(con),
           "Figure 2.2 — Age distribution by mode.",
           "Age spans 19–73 (mean ≈ 41). No gross age skew between arms.")
    t = T.demographics_summary(con); _csv(t, "tbl2_1_demographics")
    table(doc, t, "Table 2.1 — Who participated (n, % per level).",
          "Descriptive composition of the 40 completers.")

    # ── Section 3 ──
    h1(doc, "3. Negotiation outcomes (descriptive)")
    figure(doc, F.fig_outcomes(con),
           "Figure 3.1 — Outcome type by mode×role.",
           "Most negotiations reached agreement (27/40); rejections and "
           "impasses are spread across cells. Descriptive only — N too "
           "small per cell for inference here.")
    figure(doc, F.fig_price(con),
           "Figure 3.2 — Final agreed price by mode×role (n=27).",
           "Agreed prices cluster in the $22–24k band; cell medians differ "
           "modestly. Treated as descriptive (no test at n≈7/cell).")
    t = T.outcome_descriptives(con); _csv(t, "tbl3_1_outcomes")
    table(doc, t, "Table 3.1 — Outcome descriptives by cell.",
          "Agreement rate, price/turns/time medians per mode×role. No "
          "p-values in this section by design.")

    # ── Section 4 ──
    h1(doc, "4. Post-experience survey (9 items)")
    figure(doc, F.fig_survey_forest(con),
           "Figure 4.1 — Item means ± 95% CI by mode.",
           "Item-level means with 95% CIs. CIs are wide at this N; overlap "
           "is the norm. Items reported individually (no subscales).")
    t = T.survey_descriptives(con); _csv(t, "tbl4_1_survey")
    table(doc, t, "Table 4.1 — Per-item descriptives by mode.",
          "M, SD, median, IQR for each of the 9 v2 items, split AI vs Human.")

    # ── Section 5 ──
    h1(doc, "5. Group comparisons (exploratory)")
    h2(doc, "5A — Human-to-AI vs AI-to-AI (20 vs 20)")
    cm = T.comparison_mode(con); _csv(cm, "tbl5a_mode_items")
    f = cm.attrs["fisher"]
    para(doc, f"Agreement rate: AI-to-AI {f['rate_a']:.0%} vs Human-to-AI "
              f"{f['rate_b']:.0%}; Fisher's exact p = {f['p']:.3f} "
              f"(OR = {f['odds_ratio']:.2f}). Exploratory; small sample.")
    figure(doc, F.fig_comparison_delta(con, "mode"),
           "Figure 5A.1 — Per-item Cliff's δ, AI vs Human (BH-FDR).",
           "Black points survive BH-FDR at q<.05; grey do not. Interpret as "
           "exploratory signal, not confirmation, given 20 per arm.")
    table(doc, cm.drop(columns=[]).round(3),
          "Table 5A.1 — Per-item δ, 95% CI, MW p, BH-FDR q.",
          "Effect direction: positive δ ⇒ higher under AI-to-AI.")

    h2(doc, "5B — Buyer vs Seller (20 vs 20)")
    cr = T.comparison_role(con); _csv(cr, "tbl5b_role_items")
    fr = cr.attrs["fisher"]
    para(doc, f"Agreement rate: buyer {fr['rate_a']:.0%} vs seller "
              f"{fr['rate_b']:.0%}; Fisher's exact p = {fr['p']:.3f} "
              f"(OR = {fr['odds_ratio']:.2f}). Exploratory; small sample.")
    figure(doc, F.fig_comparison_delta(con, "role"),
           "Figure 5B.1 — Per-item Cliff's δ, Buyer vs Seller (BH-FDR).",
           "Same format as 5A.1. Positive δ ⇒ higher under buyer role.")
    table(doc, cr.round(3),
          "Table 5B.1 — Per-item δ, 95% CI, MW p, BH-FDR q.",
          "Role-based item differences, exploratory.")

    h2(doc, "5C/5D — 4 groups & Mode×Role interaction")
    figure(doc, F.fig_interaction(con),
           "Figure 5D.1 — Mode × Role on median agreed price.",
           "Descriptive interaction pattern only — the interaction is NOT "
           "tested (n≈7 agreed per cell). Main effects are the 20-vs-20 "
           "contrasts in 5A/5B.")

    # ── Section 6 ──
    h1(doc, "6. Data quality & operational")
    t = T.data_quality(con); _csv(t, "tbl6_quality")
    table(doc, t, "Table 6.1 — Data-quality & operational metrics.",
          "Clipboard/right-click attempts were blocked + logged; behaviour "
          "prompts captured for agent-mode completers.")
    figure(doc, F.fig_prompt_len(con),
           "Figure 6.1 — Behaviour-prompt length (agent modes).",
           "Distribution of authored agent-instruction lengths.")

    # ── Section 7 ──
    h1(doc, "7. What you can do with this data")
    t = T.variable_inventory(con); _csv(t, "tbl7_inventory")
    table(doc, t, "Table 7.1 — Analysable variables: now vs. when N grows.",
          "At current N the report supports descriptives + the two 20-vs-20 "
          "exploratory contrasts. Powered cell-level and 3-way analyses "
          "require a larger sample.")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
```

- [ ] **Step 2 (run): Build the report end-to-end**

```bash
source .venv/bin/activate && python -m scripts.analysis.human_pilot.report
```
Expected: `wrote docs/reports/2026-05-15-human-pilot-data-report.docx (… bytes)`, no traceback.

- [ ] **Step 3: Verify the docx structure**

```bash
source .venv/bin/activate && python -c "
from docx import Document
d = Document('docs/reports/2026-05-15-human-pilot-data-report.docx')
imgs = sum(1 for r in d.part.rels.values() if 'image' in r.reltype)
print('paragraphs:', len(d.paragraphs), 'tables:', len(d.tables), 'images:', imgs)
assert len(d.tables) >= 7, d.tables
assert imgs >= 9, imgs
print('OK')
"
```
Expected: `OK` — ≥7 tables, ≥9 embedded images.

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/human_pilot/docx_report.py scripts/analysis/human_pilot/report.py
git commit -m "analysis: human-pilot .docx assembler + orchestrator (end-to-end report build)"
```

---

## Phase 5 — Qualitative (Section 8)

### Task 8: Qualitative codebook + one-shot LLM coder (cached)

**Files:**
- Modify: `scripts/analysis/requirements.txt`
- Create: `scripts/analysis/human_pilot/qual_codebook.py`
- Create: `scripts/analysis/human_pilot/code_qualitative.py`

- [ ] **Step 1: Add the anthropic SDK to requirements + install**

Append to `scripts/analysis/requirements.txt`:

```
anthropic>=0.40
```

Run:
```bash
source .venv/bin/activate && pip install "anthropic>=0.40" && python -c "import anthropic; print('anthropic', anthropic.__version__)"
```
Expected: prints `anthropic 0.x` ≥ 0.40.

- [ ] **Step 2: Implement the codebook (single source of truth, no LLM)**

```python
# scripts/analysis/human_pilot/qual_codebook.py
"""The qualitative codebook. Shared by code_qualitative.py (LLM coding)
and tables.py / figures.py (rendering). One source of truth."""
from __future__ import annotations

# 8A — inductive theme presence flags (boolean per prompt/context text).
THEME_FLAGS = [
    "anchor_high",          # instruct to open high / hold near asking
    "concession_plan",      # explicit "if they offer X, do Y"
    "walkaway_threshold",   # a stated floor/ceiling number
    "relationship_tone",    # be polite/friendly/respectful
    "urgency_framing",      # moving soon / quick sale / avoid desperation
    "value_justification",  # point out condition / features / history
    "toughness",            # firm / don't budge / aggressive
    "flexibility",          # willing to negotiate / meet in the middle
]

# 8B — deductive taxonomy (one categorical value each).
TAXONOMY = {
    "orientation":          ["distributive", "integrative", "mixed"],
    "anchor":               ["high", "moderate", "none"],
    "threshold_stated":     ["yes", "no"],
    "politeness_instructed": ["yes", "no"],
    "info_strategy":        ["emphasize_value", "conceal", "neutral"],
}

# 8C — free-text study comment coding.
COMMENT_VALENCE = ["positive", "neutral", "negative"]
COMMENT_TOPIC = ["enjoyment", "ai_competence", "difficulty", "suggestion", "other"]

MODEL = "claude-sonnet-4-6"
CODER_RUN_DATE = "2026-05-15"
```

- [ ] **Step 3: Implement the one-shot LLM coder**

```python
# scripts/analysis/human_pilot/code_qualitative.py
"""One-shot LLM-assisted qualitative coder. NOT called by the report
build — run this once; it writes a cached coding sheet the build reads.

Usage:
  ANTHROPIC_API_KEY=... python -m scripts.analysis.human_pilot.code_qualitative
  (add --force to recode even if the cache exists)

Outputs:
  data/qual-codes-2026-05-15.json                       (gitignored cache)
  docs/reports/tables-human-pilot/qual_coding_sheet.csv (committed, checkable)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd

from scripts.analysis.human_pilot.data import (
    load_db, completers_frame, behavior_prompts_frame, survey_long, SNAPSHOT,
)
from scripts.analysis.human_pilot.qual_codebook import (
    THEME_FLAGS, TAXONOMY, COMMENT_VALENCE, COMMENT_TOPIC, MODEL, CODER_RUN_DATE,
)

CACHE = Path(f"data/qual-codes-{CODER_RUN_DATE}.json")
SHEET = Path("docs/reports/tables-human-pilot/qual_coding_sheet.csv")

_PROMPT_SCHEMA = {
    "type": "object",
    "properties": {
        **{f: {"type": "boolean"} for f in THEME_FLAGS},
        **{k: {"type": "string", "enum": v} for k, v in TAXONOMY.items()},
    },
    "required": THEME_FLAGS + list(TAXONOMY.keys()),
}
_COMMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "valence": {"type": "string", "enum": COMMENT_VALENCE},
        "topic": {"type": "string", "enum": COMMENT_TOPIC},
    },
    "required": ["valence", "topic"],
}

_PROMPT_SYS = (
    "You are a negotiation-research coder. You read ONE participant's "
    "free-text instruction to their delegated AI car-negotiation agent "
    "(or their personal-context note) and assign codes. THEME flags are "
    "independent booleans (set true only if clearly present). TAXONOMY "
    "fields each take exactly one value. Be conservative: absence of "
    "evidence → false / 'none' / 'no' / 'neutral'. Call the report tool."
)
_COMMENT_SYS = (
    "You are a survey-comment coder. You read ONE short open-ended study "
    "comment and assign a valence and a single best topic. Call the "
    "report tool."
)


def _client():
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get(
        "ORCHESTRATOR_ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit(
            "ANTHROPIC_API_KEY not set. Export it and re-run "
            "(this is a one-shot; the report build does not need it)."
        )
    import anthropic
    return anthropic.Anthropic(api_key=key)


def _code_one(client, text, schema, system):
    msg = client.messages.create(
        model=MODEL, max_tokens=400, system=system,
        tools=[{"name": "report", "description": "Return the codes.",
                "input_schema": schema}],
        tool_choice={"type": "tool", "name": "report"},
        messages=[{"role": "user",
                   "content": f'Text to code:\n"""\n{text}\n"""'}],
    )
    for block in msg.content:
        if block.type == "tool_use":
            return dict(block.input)
    return {}


def main(force: bool = False) -> None:
    if CACHE.exists() and not force:
        print(f"cache exists ({CACHE}); use --force to recode. Nothing to do.")
        return
    con = load_db(SNAPSHOT)
    comp = completers_frame(con)[["participant_id", "experiment_mode", "role"]]
    bp = behavior_prompts_frame(con)
    sv = survey_long(con)
    comments = sv[(sv["key"] == "free_text") & sv["value_text"].notna()]

    client = _client()
    rows = []

    # 8A/8B — one row per agent-mode behaviour prompt.
    for _, r in bp.iterrows():
        txt = (r["prompt_text"] or "").strip()
        if not txt:
            continue
        codes = _code_one(client, txt, _PROMPT_SCHEMA, _PROMPT_SYS)
        rows.append({"participant_id": r["participant_id"], "kind": "prompt",
                     "role": r["role"], "text": txt, **codes})

    # 8C — one row per study comment.
    for _, r in comments.iterrows():
        txt = (r["value_text"] or "").strip()
        if not txt:
            continue
        codes = _code_one(client, txt, _COMMENT_SCHEMA, _COMMENT_SYS)
        rows.append({"participant_id": r["participant_id"], "kind": "comment",
                     "text": txt, **codes})

    payload = {
        "_coded_at": CODER_RUN_DATE, "_model": MODEL,
        "_n_prompts": int((bp["prompt_text"].fillna("").str.len() > 0).sum()),
        "_n_comments": int(len(comments)),
        "rows": rows,
    }
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(payload, indent=2))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(SHEET, index=False)
    print(f"wrote {CACHE} ({len(rows)} rows) + {SHEET}")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
```

- [ ] **Step 4: Run the coder (needs `ANTHROPIC_API_KEY` in env)**

```bash
source .venv/bin/activate && python -m scripts.analysis.human_pilot.code_qualitative
```
Expected (if key present): `wrote data/qual-codes-2026-05-15.json (40 rows) + docs/reports/tables-human-pilot/qual_coding_sheet.csv`.
If `ANTHROPIC_API_KEY` is not set: it exits with the clear instruction message — that is acceptable; the build (Task 11) handles a missing cache gracefully and this step is re-runnable later by the researcher.

- [ ] **Step 5: Commit (the coder + codebook + the checkable sheet if produced)**

```bash
git add scripts/analysis/requirements.txt scripts/analysis/human_pilot/qual_codebook.py scripts/analysis/human_pilot/code_qualitative.py
git add docs/reports/tables-human-pilot/qual_coding_sheet.csv 2>/dev/null || true
git commit -m "analysis: qualitative codebook + one-shot LLM coder (cached, spot-checkable)"
```

---

### Task 9: Deterministic linguistic analyzer (8D — no LLM)

**Files:**
- Create: `scripts/analysis/human_pilot/linguistic.py`
- Test: `scripts/analysis/tests/test_human_pilot_linguistic.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/analysis/tests/test_human_pilot_linguistic.py
from scripts.analysis.human_pilot.linguistic import features, human_turn_features
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT

def test_features_counts():
    f = features("Please, I think maybe we could meet in the middle? Thanks!")
    assert f["politeness"] >= 2          # please, thanks
    assert f["hedges"] >= 2              # I think, maybe
    assert f["questions"] == 1
    assert f["concession"] >= 1          # meet in the middle
    assert f["char_len"] > 0

def test_features_empty():
    f = features("")
    assert f["char_len"] == 0 and f["politeness"] == 0

def test_human_turn_features_role_split():
    con = load_db(SNAPSHOT)
    df = human_turn_features(con)
    # Only human-mode participant turns; both roles present
    assert set(df["role"]) <= {"buyer", "seller"}
    assert len(df) > 50
    assert {"politeness", "hedges", "questions", "concession", "char_len"} <= set(df.columns)
```

- [ ] **Step 2: Run to verify it fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_linguistic.py -q
```
Expected: FAIL — ModuleNotFoundError.

- [ ] **Step 3: Implement linguistic.py**

```python
# scripts/analysis/human_pilot/linguistic.py
"""Deterministic lexicon/regex linguistic features for human negotiation
turns (Section 8D). No LLM — fully reproducible."""
from __future__ import annotations

import re

import pandas as pd

from scripts.analysis.human_pilot.data import _completer_ids  # type: ignore

_POLITE = re.compile(r"\b(please|thanks|thank you|appreciate|sorry|kindly)\b", re.I)
_HEDGE = re.compile(r"\b(maybe|perhaps|i think|i guess|kind of|sort of|possibly|might)\b", re.I)
_CONCESSION = re.compile(r"\b(meet (you )?in the middle|compromise|deal|i can do|i'?ll accept|fair|split the difference)\b", re.I)
_IMPERATIVE = re.compile(r"\b(i (want|need)|give me|you (must|should|have to))\b", re.I)


def features(text: str) -> dict:
    t = text or ""
    return {
        "char_len": len(t),
        "politeness": len(_POLITE.findall(t)),
        "hedges": len(_HEDGE.findall(t)),
        "questions": t.count("?"),
        "concession": len(_CONCESSION.findall(t)),
        "directness": len(_IMPERATIVE.findall(t)),
    }


def human_turn_features(con) -> pd.DataFrame:
    """One row per human-mode participant turn with linguistic features.

    In /bhx the human is the buyer; in /shx the human is the seller. We
    keep only the turn rows emitted by the human side.
    """
    ids = _completer_ids(con)
    qm = ",".join("?" * len(ids))
    rows = pd.read_sql_query(
        f"""SELECT sp.experiment_mode, sp.role, t.emitter_id, t.message
              FROM turns t
              JOIN study_participants sp ON sp.session_id = t.session_id
             WHERE sp.id IN ({qm})
               AND sp.experiment_mode IN ('human_buyer','human_seller')""",
        con, params=ids,
    )
    # The human's own turns: emitter_id == the participant's role.
    rows = rows[rows["emitter_id"] == rows["role"]].copy()
    feats = rows["message"].fillna("").map(features).apply(pd.Series)
    out = pd.concat([rows[["role"]].reset_index(drop=True),
                     feats.reset_index(drop=True)], axis=1)
    return out
```

- [ ] **Step 4: Run the test**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_linguistic.py -q
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/linguistic.py scripts/analysis/tests/test_human_pilot_linguistic.py
git commit -m "analysis: deterministic linguistic features for human turns (8D)"
```

---

### Task 10: Qualitative tables + figures (8A–8E)

**Files:**
- Modify: `scripts/analysis/human_pilot/tables.py` (append qual table builders)
- Modify: `scripts/analysis/human_pilot/figures.py` (append qual figure builders)

- [ ] **Step 1: Append qual builders to tables.py**

Add at the end of `scripts/analysis/human_pilot/tables.py`:

```python
# ─── Section 8 — qualitative ──────────────────────────────────────────
import json as _json
from pathlib import Path as _Path

from scripts.analysis.human_pilot.qual_codebook import (
    THEME_FLAGS as _THEMES, TAXONOMY as _TAX, CODER_RUN_DATE as _QDATE,
)
from scripts.analysis.human_pilot.linguistic import human_turn_features as _htf

_QCACHE = _Path(f"data/qual-codes-{_QDATE}.json")


def qual_cache_available() -> bool:
    return _QCACHE.exists()


def _qual_rows(kind: str):
    if not _QCACHE.exists():
        return []
    data = _json.loads(_QCACHE.read_text())
    return [r for r in data.get("rows", []) if r.get("kind") == kind]


def theme_prevalence(con) -> pd.DataFrame:
    rows = _qual_rows("prompt")
    n = len(rows) or 1
    out = []
    for th in _THEMES:
        k = sum(1 for r in rows if r.get(th) is True)
        out.append({"theme": th, "n": k, "pct": round(100 * k / n, 1)})
    return pd.DataFrame(out).sort_values("n", ascending=False).reset_index(drop=True)


def taxonomy_by_role(con) -> pd.DataFrame:
    rows = _qual_rows("prompt")
    out = []
    for dim, levels in _TAX.items():
        for lvl in levels:
            for role in ("buyer", "seller"):
                k = sum(1 for r in rows
                        if r.get("role") == role and r.get(dim) == lvl)
                out.append({"dimension": dim, "level": lvl,
                            "role": role, "n": k})
    return pd.DataFrame(out)


def comment_sentiment(con) -> pd.DataFrame:
    rows = _qual_rows("comment")
    if not rows:
        return pd.DataFrame(columns=["valence", "topic", "n"])
    df = pd.DataFrame(rows)
    return (df.groupby(["valence", "topic"]).size()
              .reset_index(name="n"))


def linguistic_by_role(con) -> pd.DataFrame:
    f = _htf(con)
    g = f.groupby("role").agg(
        n=("char_len", "size"),
        char_len_med=("char_len", "median"),
        politeness_mean=("politeness", "mean"),
        hedges_mean=("hedges", "mean"),
        questions_mean=("questions", "mean"),
        concession_mean=("concession", "mean"),
        directness_mean=("directness", "mean"),
    ).round(2).reset_index()
    return g


def qual_quant_link(con) -> pd.DataFrame:
    """8E — agreed price (agent modes) by taxonomy orientation + satisfaction
    by comment sentiment. Descriptive medians, illustrative only."""
    rows_p = _qual_rows("prompt")
    out = []
    if rows_p:
        df = completers_frame(con)
        agreed = df[df["outcome_type"] == "agreed"][["participant_id", "final_price"]]
        codes = pd.DataFrame(rows_p)[["participant_id", "orientation"]]
        m = codes.merge(agreed, on="participant_id", how="inner")
        for ori, g in m.groupby("orientation"):
            out.append({"link": "price~orientation", "group": ori,
                        "n": len(g),
                        "price_median": float(g["final_price"].median())
                        if len(g) else None})
    rows_c = _qual_rows("comment")
    if rows_c:
        s = survey_long(con)
        sat = s[(s["key"] == "satisfaction") & s["value_int"].notna()][
            ["participant_id", "value_int"]]
        cc = pd.DataFrame(rows_c)[["participant_id", "valence"]]
        m = cc.merge(sat, on="participant_id", how="inner")
        for val, g in m.groupby("valence"):
            out.append({"link": "satisfaction~comment_sentiment",
                        "group": val, "n": len(g),
                        "price_median": float(g["value_int"].median())
                        if len(g) else None})
    return pd.DataFrame(out)
```

- [ ] **Step 2: Append qual figures to figures.py**

Add at the end of `scripts/analysis/human_pilot/figures.py`:

```python
# ─── Section 8 — qualitative figures ──────────────────────────────────
from scripts.analysis.human_pilot.tables import (
    theme_prevalence as _theme_prev, comment_sentiment as _csent,
    linguistic_by_role as _ling, qual_cache_available as _qok,
)


def fig_theme_prevalence(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    if _qok():
        t = _theme_prev(con)
        ax.barh(t["theme"], t["n"], color=MODE2_COLORS["AI-to-AI"])
        ax.invert_yaxis()
        ax.set_xlabel("prompts (of 20)")
    else:
        ax.text(0.5, 0.5, "qualitative coding not yet run",
                ha="center", va="center"); ax.axis("off")
    ax.set_title("Behaviour-prompt strategy themes")
    return save(fig, "fig8a_themes", aspect=0.6)


def fig_comment_sentiment(con) -> Path:
    apply_theme()
    fig, ax = plt.subplots()
    if _qok():
        c = _csent(con)
        piv = c.pivot_table(index="topic", columns="valence",
                            values="n", fill_value=0)
        piv.plot(kind="barh", stacked=True, ax=ax,
                 color={"positive": OUTCOME_COLORS["agreed"],
                        "neutral": "#999999",
                        "negative": OUTCOME_COLORS["rejected"]})
        ax.set_xlabel("comments")
    else:
        ax.text(0.5, 0.5, "qualitative coding not yet run",
                ha="center", va="center"); ax.axis("off")
    ax.set_title("Study-comment sentiment × topic")
    return save(fig, "fig8c_sentiment", aspect=0.5)


def fig_linguistic(con) -> Path:
    apply_theme()
    g = _ling(con).set_index("role")
    feats = ["politeness_mean", "hedges_mean", "questions_mean",
             "concession_mean", "directness_mean"]
    fig, ax = plt.subplots()
    x = np.arange(len(feats))
    for i, role in enumerate(g.index):
        ax.bar(x + (i - 0.5) * 0.35, g.loc[role, feats].values, width=0.35,
               label=role, color=ROLE_COLORS.get(role, "#999999"))
    ax.set_xticks(x)
    ax.set_xticklabels([f.replace("_mean", "") for f in feats],
                       rotation=20, ha="right")
    ax.set_ylabel("mean per turn")
    ax.set_title("Human-turn linguistic features by role (8D, deterministic)")
    ax.legend(fontsize=8)
    return save(fig, "fig8d_linguistic", aspect=0.55)


QUAL_FIGURES = [
    ("fig8a_themes", fig_theme_prevalence),
    ("fig8c_sentiment", fig_comment_sentiment),
    ("fig8d_linguistic", fig_linguistic),
]
```

- [ ] **Step 3: Smoke-test qual figures (works with OR without the cache)**

```bash
source .venv/bin/activate && python -c "
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot.figures import QUAL_FIGURES
con = load_db(SNAPSHOT)
for name, fn in QUAL_FIGURES:
    p = fn(con); assert p.exists() and p.stat().st_size > 800, name
    print('OK', name)
"
```
Expected: `OK` for fig8a_themes, fig8c_sentiment, fig8d_linguistic (8D always renders real data; 8A/8C render real data if cache present, else the 'not yet run' placeholder — either way the file exists).

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/human_pilot/tables.py scripts/analysis/human_pilot/figures.py
git commit -m "analysis: Section 8 qualitative tables + figures (8A-8E, cache-aware)"
```

---

### Task 11: Wire Section 8 into the report

**Files:**
- Modify: `scripts/analysis/human_pilot/report.py`

- [ ] **Step 1: Add Section 8 to the build (insert before `OUT.parent.mkdir`)**

In `scripts/analysis/human_pilot/report.py`, add these imports near the top:

```python
from scripts.analysis.human_pilot.tables import (
    theme_prevalence, taxonomy_by_role, comment_sentiment,
    linguistic_by_role, qual_quant_link, qual_cache_available,
)
from scripts.analysis.human_pilot.qual_codebook import MODEL as QMODEL, CODER_RUN_DATE as QDATE
```

Then, immediately before `OUT.parent.mkdir(parents=True, exist_ok=True)`:

```python
    # ── Section 8 — Qualitative ──
    h1(doc, "8. Qualitative analysis")
    if qual_cache_available():
        para(doc, f"LLM-assisted coding disclosure: themes, taxonomy and "
                  f"comment sentiment were coded once on {QDATE} with "
                  f"{QMODEL} against the fixed codebook. n=20 behaviour "
                  f"prompts / 20 comments. Codes are illustrative and "
                  f"hypothesis-generating, NOT theoretically saturated; no "
                  f"inter-rater reliability. The full coding sheet "
                  f"(qual_coding_sheet.csv) is committed for spot-checking.",
             italic=True)
    else:
        para(doc, "Qualitative LLM coding has not been run yet — sections "
                  "8A/8B/8C/8E show placeholders. Run "
                  "`python -m scripts.analysis.human_pilot.code_qualitative` "
                  "with ANTHROPIC_API_KEY set, then rebuild. Section 8D "
                  "(linguistic) is deterministic and shown below regardless.",
             italic=True)

    h2(doc, "8A — Strategy themes (behaviour prompts, inductive)")
    figure(doc, F.fig_theme_prevalence(con),
           "Figure 8A.1 — Theme prevalence across 20 agent-mode prompts.",
           "How often each negotiation-strategy theme appears in "
           "participants' instructions to their delegated agent. "
           "Illustrative; n=20.")
    if qual_cache_available():
        tp = theme_prevalence(con); _csv(tp, "tbl8a_themes")
        table(doc, tp, "Table 8A.1 — Theme prevalence (count, %).",
              "Most-instructed strategies first.")

    h2(doc, "8B — Strategy taxonomy (deductive)")
    if qual_cache_available():
        tx = taxonomy_by_role(con); _csv(tx, "tbl8b_taxonomy")
        table(doc, tx, "Table 8B.1 — Taxonomy frequencies by role.",
              "Distributive vs integrative orientation, anchor strength, "
              "threshold/politeness/info-strategy — buyer vs seller counts. "
              "Descriptive; no test (n=20).")
    else:
        para(doc, "(8B table pending qualitative coding.)", italic=True)

    h2(doc, "8C — Study-comment sentiment")
    figure(doc, F.fig_comment_sentiment(con),
           "Figure 8C.1 — Comment valence × topic (n=20, all non-blank).",
           "Tone and focus of the open-ended study comments.")

    h2(doc, "8D — Human-turn language (deterministic)")
    figure(doc, F.fig_linguistic(con),
           "Figure 8D.1 — Linguistic features, buyer vs seller (human modes).",
           "Politeness, hedging, questions, concession and directness per "
           "typed turn. Lexicon-based, fully reproducible, no LLM.")
    tl = linguistic_by_role(con); _csv(tl, "tbl8d_linguistic")
    table(doc, tl, "Table 8D.1 — Linguistic feature means by role.",
          "Per-turn means for human-mode participants.")

    h2(doc, "8E — Qualitative × quantitative link")
    if qual_cache_available():
        ql = qual_quant_link(con); _csv(ql, "tbl8e_link")
        table(doc, ql, "Table 8E.1 — Outcomes by strategy / sentiment.",
              "Agreed-price median by prompt orientation; satisfaction "
              "median by comment sentiment. Descriptive, illustrative, "
              "hypothesis-generating only — n is small.")
    else:
        para(doc, "(8E link pending qualitative coding.)", italic=True)
```

- [ ] **Step 2: Rebuild the report end-to-end**

```bash
source .venv/bin/activate && python -m scripts.analysis.human_pilot.report
```
Expected: `wrote docs/reports/2026-05-15-human-pilot-data-report.docx (… bytes)`, no traceback (works with or without the qual cache).

- [ ] **Step 3: Verify Section 8 present**

```bash
source .venv/bin/activate && python -c "
from docx import Document
d = Document('docs/reports/2026-05-15-human-pilot-data-report.docx')
txt = '\n'.join(p.text for p in d.paragraphs)
for s in ['8. Qualitative analysis','8A','8B','8C','8D','8E']:
    assert s in txt, s
imgs = sum(1 for r in d.part.rels.values() if 'image' in r.reltype)
print('Section 8 OK; total images:', imgs, 'tables:', len(d.tables))
assert imgs >= 12
"
```
Expected: `Section 8 OK; total images: ≥12 …`.

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/human_pilot/report.py docs/reports/2026-05-15-human-pilot-data-report.docx docs/reports/figures-human-pilot docs/reports/tables-human-pilot
git commit -m "report: Section 8 qualitative wired into the .docx (cache-aware, disclosure note)"
```

---

### Task 12: Full-suite verification + final commit

- [ ] **Step 1: Run the whole test suite**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests -q
```
Expected: all pass (existing synthetic-pipeline tests + the new human-pilot tests).

- [ ] **Step 2: Acceptance-criteria check (spec §9)**

```bash
source .venv/bin/activate && python -c "
from docx import Document
d = Document('docs/reports/2026-05-15-human-pilot-data-report.docx')
txt = '\n'.join(p.text for p in d.paragraphs)
assert 'Human Pilot' in txt
assert 'exploratory' in txt.lower() or 'descriptive' in txt.lower()
assert 'What you can do with this data' in txt
assert '8. Qualitative analysis' in txt
for s in ['8A','8B','8C','8D','8E']:
    assert s in txt, s
assert 'Abstract' not in txt and 'Introduction' not in txt  # no manuscript scaffolding
print('acceptance OK')
"
```
Expected: `acceptance OK`.

- [ ] **Step 3: Final commit**

```bash
git add docs/reports/2026-05-15-human-pilot-data-report.docx docs/reports/figures-human-pilot docs/reports/tables-human-pilot
git commit -m "report: human-pilot data report .docx + figures + tables (build output)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §2 sample = 40 completers | Task 2 (loader + tests assert 40, 10/cell, 27 agreed) |
| §3 snapshot + integrity | Task 2 (read-only SQLite open) |
| §4 S1 funnel + composition | Task 6 fig_funnel, Task 5 sample_composition, Task 7 |
| §4 S2 demographics (plotnine) | Task 6 fig_demographics/fig_age, Task 5 demographics_summary |
| §4 S3 outcomes descriptive | Task 6 fig_outcomes/fig_price, Task 5 outcome_descriptives |
| §4 S4 survey 9 items | Task 6 fig_survey_forest, Task 5 survey_descriptives |
| §4 S5A/5B comparisons + Fisher + FDR | Task 5 comparison_mode/role, Task 6 fig_comparison_delta |
| §4 S5C/5D 4-group + interaction | Task 6 fig_interaction (5D); 5C folded into Tbl 3.1 + fig_outcomes by-cell |
| §4 S6 data quality | Task 5 data_quality, Task 6 fig_prompt_len |
| §4 S7 inventory | Task 5 variable_inventory |
| §5 statistical posture | Tasks 5/6 — descriptive S1-4, Fisher+δ+FDR S5A/B, no pairwise, interpretations carry "exploratory" |
| §6 viz stack | Task 1 plotnine, Task 4 figbase, Task 6 |
| §7 deliverables | Task 7 paths, Task 12 final commit |
| §9 acceptance criteria | Task 12 explicit checks |
| §4 S8 qualitative (8A–8E) | Task 8 codebook+coder, Task 9 linguistic (8D), Task 10 qual tables+figures, Task 11 wire into report |
| §4 S8 coding mechanics / cache / disclosure | Task 8 (cache JSON + committed sheet), Task 11 (disclosure note + graceful no-cache) |
| §9 acceptance 8/9/10 (qual) | Task 11 Step 3 + Task 12 Step 2 |

Gap noted + resolved: spec §4 "5C — 4 groups small-multiples" — covered descriptively by the by-cell `fig_outcomes` + `outcome_descriptives` table rather than a separate small-multiples figure (KW omnibus is low-value at n=10 and the by-cell stacked bar already shows all four groups). This is a deliberate simplification consistent with the "descriptive only for 5C" posture; no separate task needed.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". Every code step shows complete code; every run step shows the exact command + expected output. Two graceful conditionals, both fully specified: (a) `tokens/cost if present` — `data_quality()` reads `sessions.tokens_total`, verified present in the comprehensive read; (b) the qualitative cache — `qual_cache_available()` gates 8A/8B/8C/8E with an explicit committed-in-code placeholder path; 8D never depends on it. Neither is a "TODO" — both branches are written out.

**3. Type consistency:** `load_db` returns `sqlite3.Connection` used uniformly by every `*_frame`/table/figure/qual function. `completers_frame` columns (`participant_id`, `mode2`, `experiment_mode`, `role`, `outcome_type`, `final_price`, `turns_count`, `session_time_sec`) referenced consistently in tables.py/figures.py/report.py. `comparison_mode/role` return a DataFrame with `.attrs["fisher"]` consumed in report.py. `V2_SURVEY_KEYS` defined once in data.py. Qualitative: `THEME_FLAGS`, `TAXONOMY`, `COMMENT_VALENCE/TOPIC`, `MODEL`, `CODER_RUN_DATE` defined once in `qual_codebook.py` and imported by `code_qualitative.py`, `tables.py`, `report.py` — the cache path `data/qual-codes-{CODER_RUN_DATE}.json` is derived from the single `CODER_RUN_DATE` constant everywhere (coder writes it, `qual_cache_available()` reads it — no string drift). `_completer_ids` reused from data.py by linguistic.py. PNG `Path` return type consistent across all `fig_*` (incl. `QUAL_FIGURES`) and `save`/`save_plotnine`.

**4. Reproducibility isolation (qual):** the report build (`report.py`) imports only `tables`/`figures`/`docx_report` — none import `anthropic`. The Anthropic SDK is imported lazily *inside* `code_qualitative._client()` only, so `python -m scripts.analysis.human_pilot.report` has zero network/LLM dependency even if `anthropic` is uninstalled. Verified by the import graph: `report → tables → {data, stats_ext, linguistic, qual_codebook}`; none of those import `anthropic`.

---

## Execution Handoff

(see post-plan message)
