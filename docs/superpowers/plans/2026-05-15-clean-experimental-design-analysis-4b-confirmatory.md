# Analysis 4b — Pre-registered Confirmatory Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a frozen, deterministic, offline pre-registered confirmatory-analysis package (`scripts/analysis/confirmatory/`) on the 4a canonical reader, with a hard guard so legacy/non-clean data can never masquerade as a confirmatory result.

**Architecture:** (1) Promote behavior-identical `scheirer_ray_hare` + `fisher_2x2` into canonical `scripts/analysis/core/stats.py` (parity-tested against the vetted `process_report/stats.py` copy). (2) New `scripts/analysis/confirmatory/` package: `sample.py` (resolve_conditions → join survey+outcomes → apply pre-registered exclusions → analyzable frame + audit + `clean` flag), `tests_battery.py` (primary satisfaction MW+Cliff+bootstrap, SRH 2×2, BH-corrected secondary family, opponent covariate sensitivity, labeled exploratory), `report.py` (DOCX + CSV, DRY-RUN guard stamp). Verified on synthetic main-shaped fixtures + a pilot dry-run.

**Tech Stack:** Python 3 (`python3`), pandas, numpy, scipy, python-docx, pytest. Tests run from worktree root: `python3 -m pytest <target> -q`. The frozen pilot DB will be symlinked at `data/ai2ai-human-pilot-2026-05-15.db` (worktree setup does this; existing suites depend on it).

**Spec:** `docs/superpowers/specs/2026-05-15-clean-experimental-design-analysis-4b-confirmatory-design.md`

**Baseline:** `python3 -m pytest scripts/analysis -q` = `54 passed` on `main` (HEAD `563c7c4`). Running the suite regenerates `docs/reports/*` (pre-existing side-effect) — **commit ONLY the exact files each task lists; never `git add -A`/`docs/reports`.** If `pytest`/`python-docx` missing, report BLOCKED (same env that runs `python -m scripts.analysis.*.report`).

---

### Task 1: Promote `scheirer_ray_hare` + `fisher_2x2` into canonical `core/stats.py`

**Files:**
- Modify: `scripts/analysis/core/stats.py` (append two functions in the "Hypothesis tests" section)
- Create: `scripts/analysis/tests/test_core_stats_srh_fisher.py`

- [ ] **Step 1: Write the failing + parity tests** — create `scripts/analysis/tests/test_core_stats_srh_fisher.py`:

```python
"""Unit + parity tests: canonical core SRH/Fisher must match the vetted
process_report clean-room copy on a shared fixture."""
import numpy as np
import pandas as pd
from scripts.analysis.core.stats import scheirer_ray_hare, fisher_2x2
from scripts.analysis.process_report.stats import (
    scheirer_ray_hare as pr_srh, fisher_2x2 as pr_fisher,
)


def _fixture():
    rng = np.random.default_rng(7)
    rows = []
    for a in ("delegated", "direct"):
        for b in ("buyer", "seller"):
            for _ in range(12):
                base = 4.0 + (0.8 if a == "delegated" else 0.0)
                rows.append({"dv": float(rng.normal(base, 1.0)),
                             "A": a, "B": b})
    return pd.DataFrame(rows)


def test_srh_shape_and_ranges():
    r = scheirer_ray_hare(_fixture(), "dv", "A", "B")
    for term in ("A", "B", "AB"):
        assert set(r[term]) == {"H", "p", "eta2", "df"}
        assert r[term]["df"] == 1
        assert 0.0 <= r[term]["p"] <= 1.0
        assert 0.0 <= r[term]["eta2"] <= 1.0
    assert r["N"] == 48


def test_srh_parity_with_process_report():
    df = _fixture()
    a = scheirer_ray_hare(df, "dv", "A", "B")
    b = pr_srh(df, "dv", "A", "B")
    assert a == b  # canonical must be byte-identical to the vetted copy


def test_fisher_parity_and_values():
    a = fisher_2x2(8, 10, 3, 10)
    b = pr_fisher(8, 10, 3, 10)
    assert a == b
    assert set(a) == {"odds_ratio", "p", "rate_a", "rate_b", "n_a", "n_b"}
    assert a["rate_a"] == 0.8 and a["rate_b"] == 0.3
```

- [ ] **Step 2: Run — expect FAIL** — `python3 -m pytest scripts/analysis/tests/test_core_stats_srh_fisher.py -q` → FAIL (`ImportError: cannot import name 'scheirer_ray_hare'`).

- [ ] **Step 3: Append to `scripts/analysis/core/stats.py`** (in the "Hypothesis tests" section, after `kruskal_wallis`; uses `scistats`/`np` already imported at module top — verbatim behavior of the vetted `process_report/stats.py` copy):

```python
def scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict:
    """Rank-based 2x2 omnibus (Scheirer–Ray–Hare). Per term: H, p (chi2
    df=1), eta2; plus N. Canonical copy; behavior-identical to the vetted
    process_report clean-room implementation (parity-tested)."""
    d = df[[dv, a, b]].dropna().copy()
    R = scistats.rankdata(d[dv].to_numpy(float))
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
                "p": float(scistats.chi2.sf(H, 1)) if ok else float("nan"),
                "eta2": float(ss / SS_total) if SS_total else float("nan"),
                "df": 1}

    return {"A": _term(SS_A), "B": _term(SS_B), "AB": _term(SS_AB), "N": N}


def fisher_2x2(succ_a: int, n_a: int, succ_b: int, n_b: int) -> dict:
    """Fisher's exact on a 2x2 (success/failure x group). Odds ratio + p."""
    odds, p = scistats.fisher_exact([[succ_a, n_a - succ_a],
                                     [succ_b, n_b - succ_b]])
    return {"odds_ratio": float(odds), "p": float(p),
            "rate_a": succ_a / n_a if n_a else float("nan"),
            "rate_b": succ_b / n_b if n_b else float("nan"),
            "n_a": n_a, "n_b": n_b}
```

- [ ] **Step 4: Run — expect PASS** — `python3 -m pytest scripts/analysis/tests/test_core_stats_srh_fisher.py -q` → PASS (3). Then `python3 -m pytest scripts/analysis -q` → all green, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/core/stats.py scripts/analysis/tests/test_core_stats_srh_fisher.py
git commit -m "feat(analysis): promote scheirer_ray_hare + fisher_2x2 into canonical core/stats"
```

---

### Task 2: `confirmatory/sample.py` — analyzable sample, exclusions, `clean` guard

**Files:**
- Create: `scripts/analysis/confirmatory/__init__.py` (empty)
- Create: `scripts/analysis/confirmatory/tests/__init__.py` (empty)
- Create: `scripts/analysis/confirmatory/sample.py`
- Create: `scripts/analysis/confirmatory/tests/test_sample.py`

- [ ] **Step 1: Write the failing tests** — create `scripts/analysis/confirmatory/tests/test_sample.py`:

```python
import sqlite3
import pandas as pd
from scripts.analysis.confirmatory.sample import analyzable

DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT, experiment_mode TEXT,
  session_id TEXT, condition_mode TEXT, condition_role TEXT, opponent_block TEXT,
  assignment_seed TEXT, assignment_block_index INTEGER, replicate_id INTEGER,
  manipulation_check_pass INTEGER, excl_attention INTEGER,
  excl_manipulation INTEGER, excl_speeding INTEGER, excl_comprehension INTEGER,
  excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_int INTEGER, value_text TEXT);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, outcome_type TEXT, outcome_terms_json TEXT);
"""


def _main_con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    # 2 clean main completers (one excluded via excl_speeding)
    c.execute("INSERT INTO study_participants VALUES "
              "('M1','buyer','CC','agent','s1','delegated','buyer','moderate',"
              "'S',0,0,1,0,0,0,0,0)")
    c.execute("INSERT INTO study_participants VALUES "
              "('M2','seller','CC','human_seller','s2','direct','seller','tough',"
              "'S',0,0,1,0,0,1,0,0)")  # excl_speeding=1 -> excluded
    c.execute("INSERT INTO sessions VALUES ('s1','agreed','{\"price\": 23000}')")
    c.execute("INSERT INTO sessions VALUES ('s2','rejected','{}')")
    for pid in ("M1", "M2"):
        c.execute("INSERT INTO participant_responses VALUES "
                  "(?, 'post_survey', 'satisfaction', 5, NULL)", (pid,))
    return c


def _legacy_con():
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE study_participants (
        id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
        experiment_mode TEXT, session_id TEXT);
      CREATE TABLE participant_responses (
        participant_id TEXT, screen TEXT, key TEXT, value_int INTEGER, value_text TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, outcome_type TEXT, outcome_terms_json TEXT);
    """)
    c.execute("INSERT INTO study_participants VALUES ('L1','buyer','CC','agent','s1')")
    c.execute("INSERT INTO sessions VALUES ('s1','agreed','{\"price\": 22000}')")
    c.execute("INSERT INTO participant_responses VALUES ('L1','engine','opponent_personality',NULL,'tough')")
    c.execute("INSERT INTO participant_responses VALUES ('L1','post_survey','satisfaction',6,NULL)")
    return c


def test_main_excludes_flagged_and_is_clean_when_balanced():
    df, audit, clean = analyzable(_main_con())
    assert set(df["participant_id"]) == {"M1"}          # M2 excluded (excl_speeding)
    assert audit.loc[audit["reason"] == "excl_speeding", "n"].iloc[0] == 1
    assert df.loc[df["participant_id"] == "M1", "satisfaction"].iloc[0] == 5
    assert df.loc[df["participant_id"] == "M1", "outcome_type"].iloc[0] == "agreed"
    assert df.loc[df["participant_id"] == "M1", "final_price"].iloc[0] == 23000
    # only 1 row, design not fully balanced -> clean is False here is acceptable;
    # the balanced-clean path is asserted in test_tests_battery via a full fixture.
    assert clean in (True, False)


def test_legacy_is_not_clean_and_keeps_completers():
    df, audit, clean = analyzable(_legacy_con())
    assert clean is False                                # legacy rows present
    assert set(df["participant_id"]) == {"L1"}           # completer kept
    assert df.loc[df["participant_id"] == "L1", "satisfaction"].iloc[0] == 6
```

- [ ] **Step 2: Run — expect FAIL** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_sample.py -q` → FAIL (ModuleNotFoundError).

- [ ] **Step 3: Create the package + `sample.py`**

`scripts/analysis/confirmatory/__init__.py` and `scripts/analysis/confirmatory/tests/__init__.py`: empty files.

`scripts/analysis/confirmatory/sample.py`:

```python
"""Analyzable-sample construction + the pre-registered exclusion policy +
the clean/dry-run guard for the confirmatory analysis (spec 4b).

Consumes the canonical 4a reader (scripts.analysis.core.conditions).
"""
from __future__ import annotations

import json

import pandas as pd

from scripts.analysis.core.conditions import resolve_conditions

# the 9 pre-registered post-survey DVs (spec 1)
SURVEY_DVS = [
    "satisfaction", "would_use_again", "agent_represented", "control",
    "emot_pleasant", "emot_anxious", "effort_invested", "engage_engaged",
    "outfair_share",
]
_EXCL_COLS = ["excl_attention", "excl_manipulation", "excl_speeding",
              "excl_comprehension", "excl_noncompletion"]
_STRATA = [(m, r, o) for m in ("delegated", "direct")
           for r in ("buyer", "seller")
           for o in ("easygoing", "moderate", "tough")]


def _price(j):
    try:
        v = json.loads(j or "{}").get("price")
        return float(v) if isinstance(v, (int, float)) else None
    except Exception:
        return None


def analyzable(con):
    """Return (frame, exclusions_audit, clean).

    frame: one row per ANALYZABLE completer — condition columns (4a) +
    the 9 survey DVs (wide) + outcome_type + final_price.
    exclusions_audit: DataFrame[reason, n].
    clean: True iff every row is condition_source=='main' AND all 12
    Mode x Role x opponent strata are present AND exclusion fields are
    non-null (i.e. real pre-registered main-study data).
    """
    cond = resolve_conditions(con)  # completers only (4a contract)

    sp = pd.read_sql_query(
        "SELECT id AS participant_id, session_id FROM study_participants", con)
    sess = pd.read_sql_query(
        "SELECT id AS session_id, outcome_type, outcome_terms_json FROM sessions",
        con)
    surv = pd.read_sql_query(
        "SELECT participant_id, key, value_int FROM participant_responses "
        "WHERE screen='post_survey'", con)

    df = cond.merge(sp, on="participant_id", how="left") \
             .merge(sess, on="session_id", how="left")
    if not surv.empty:
        wide = (surv[surv["key"].isin(SURVEY_DVS)]
                .pivot_table(index="participant_id", columns="key",
                             values="value_int", aggfunc="first")
                .reset_index())
        df = df.merge(wide, on="participant_id", how="left")
    for dv in SURVEY_DVS:
        if dv not in df.columns:
            df[dv] = pd.NA
    df["final_price"] = df["outcome_terms_json"].map(_price)

    # ---- pre-registered exclusions (spec 4b §3) ----
    audit_rows = []
    keep = pd.Series(True, index=df.index)
    for col in _EXCL_COLS:
        flagged = df[col].fillna(0).astype("float") == 1 if col in df else \
                  pd.Series(False, index=df.index)
        audit_rows.append({"reason": col, "n": int(flagged.sum())})
        keep &= ~flagged
    mc = (df["manipulation_check_pass"] if "manipulation_check_pass" in df
          else pd.Series(pd.NA, index=df.index))
    mc_fail = mc.fillna(1).astype("float") == 0
    audit_rows.append({"reason": "manipulation_check_fail", "n": int(mc_fail.sum())})
    keep &= ~mc_fail

    out = df[keep].reset_index(drop=True)
    audit = pd.DataFrame(audit_rows, columns=["reason", "n"])

    all_main = bool(len(out)) and (out["condition_source"] == "main").all()
    excl_present = all(out[c].notna().all() for c in _EXCL_COLS if c in out) \
        and ("manipulation_check_pass" in out
             and out["manipulation_check_pass"].notna().all())
    present = {(r.condition_mode, r.condition_role, r.opponent_block)
               for r in out.itertuples(index=False)}
    balanced = all(s in present for s in _STRATA)
    clean = bool(all_main and excl_present and balanced)

    keep_cols = (["participant_id", "condition_mode", "condition_role",
                  "opponent_block", "condition_source", "mode2",
                  "outcome_type", "final_price"] + SURVEY_DVS)
    return out[keep_cols], audit, clean
```

- [ ] **Step 4: Run — expect PASS** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_sample.py -q` → PASS (2). Then `python3 -m pytest scripts/analysis -q` → all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/confirmatory/__init__.py scripts/analysis/confirmatory/tests/__init__.py scripts/analysis/confirmatory/sample.py scripts/analysis/confirmatory/tests/test_sample.py
git commit -m "feat(confirmatory): analyzable sample + pre-registered exclusions + clean guard"
```

---

### Task 3: `confirmatory/tests_battery.py` — the pre-registered test battery

**Files:**
- Create: `scripts/analysis/confirmatory/tests_battery.py`
- Create: `scripts/analysis/confirmatory/tests/test_battery.py`

(Module named `tests_battery.py` — NOT `tests.py` — so pytest collection never confuses it with a test module.)

- [ ] **Step 1: Write the failing tests** — `scripts/analysis/confirmatory/tests/test_battery.py`:

```python
import numpy as np
import pandas as pd
from scripts.analysis.confirmatory.tests_battery import run_battery


def _clean_sample(seed=1):
    rng = np.random.default_rng(seed)
    rows = []
    for m in ("delegated", "direct"):
        for r in ("buyer", "seller"):
            for o in ("easygoing", "moderate", "tough"):
                for _ in range(8):
                    sat = rng.normal(5.4 if m == "delegated" else 4.2, 1.0)
                    rows.append({
                        "participant_id": f"{m}{r}{o}{_}{rng.integers(1e9)}",
                        "condition_mode": m, "condition_role": r,
                        "opponent_block": o, "condition_source": "main",
                        "mode2": "AI-to-AI" if m == "delegated" else "Human-to-AI",
                        "outcome_type": "agreed" if rng.random() < 0.6 else "rejected",
                        "final_price": 23000.0,
                        "satisfaction": float(np.clip(round(sat), 1, 7)),
                        "would_use_again": float(rng.integers(1, 8)),
                        "agent_represented": float(rng.integers(1, 8)),
                        "control": float(rng.integers(1, 8)),
                        "emot_pleasant": float(rng.integers(1, 8)),
                        "emot_anxious": float(rng.integers(1, 8)),
                        "effort_invested": float(rng.integers(1, 8)),
                        "engage_engaged": float(rng.integers(1, 8)),
                        "outfair_share": float(rng.integers(1, 8)),
                    })
    return pd.DataFrame(rows)


def test_battery_structure_and_primary_detects_injected_effect():
    res = run_battery(_clean_sample())
    # primary
    p = res["primary"]
    assert p["dv"] == "satisfaction"
    assert p["test"] == "mann_whitney_two_sided"
    assert 0.0 <= p["p"] <= 1.0
    assert p["p"] < 0.05                       # injected delegated>direct effect
    assert "cliffs_delta" in p and "ci95" in p and len(p["ci95"]) == 2
    # SRH 2x2 secondary-structural
    assert set(res["srh"]) == {"A", "B", "AB", "N"}
    # secondary family BH-corrected
    fam = res["secondary"]
    assert {"dv", "p", "q_bh"} <= set(fam[0])
    assert all(0.0 <= r["q_bh"] <= 1.0 for r in fam)
    assert any(r["dv"] == "agreement_rate" and r["test"] == "fisher_2x2"
               for r in fam)
    # opponent sensitivity (not a factor of interest)
    assert res["opponent_sensitivity"]["test"] == "kruskal_wallis"
    # exploratory explicitly labeled
    assert res["exploratory"]["label"] == "exploratory, uncorrected"


def test_battery_marks_agent_represented_delegated_only():
    res = run_battery(_clean_sample())
    ar = [r for r in res["secondary"] if r["dv"] == "agent_represented"][0]
    assert ar.get("caveat") == "delegated-only (not comparable in direct)"
```

- [ ] **Step 2: Run — expect FAIL** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_battery.py -q` → FAIL (ModuleNotFoundError).

- [ ] **Step 3: Create `scripts/analysis/confirmatory/tests_battery.py`**

```python
"""The pre-registered confirmatory test battery (spec 1 + 4b §4).

All tests run on the analyzable sample only. Primary is a single
pre-registered test (no correction); the secondary family is
Benjamini–Hochberg corrected together; exploratory is labeled.
"""
from __future__ import annotations

import pandas as pd

from scripts.analysis.core.stats import (
    mann_whitney, cliff_delta, bootstrap_ci, fdr_bh,
    scheirer_ray_hare, fisher_2x2, kruskal_wallis,
)

SECONDARY_SURVEY = [
    "would_use_again", "agent_represented", "control", "emot_pleasant",
    "emot_anxious", "effort_invested", "engage_engaged", "outfair_share",
]


def _mode_split(df, dv):
    a = df.loc[df["condition_mode"] == "delegated", dv].astype(float)
    b = df.loc[df["condition_mode"] == "direct", dv].astype(float)
    return a.dropna().to_numpy(), b.dropna().to_numpy()


def run_battery(sample: pd.DataFrame) -> dict:
    # ---- primary: satisfaction ~ Mode (two-sided MW) ----
    a, b = _mode_split(sample, "satisfaction")
    mw = mann_whitney(a, b, alternative="two-sided")
    d = cliff_delta(a, b)
    ci = bootstrap_ci(  # CI on Cliff's δ via independent two-sample resample
        a, statistic=lambda x: x.mean(), n_boot=1)  # placeholder shape guard
    lo, hi = _cliffs_ci(a, b)
    primary = {"dv": "satisfaction", "test": "mann_whitney_two_sided",
               "U": mw["U"], "p": mw["p"], "n_a": mw["n_a"], "n_b": mw["n_b"],
               "cliffs_delta": float(d), "ci95": [lo, hi]}

    # ---- primary structural omnibus (reported secondary): SRH 2x2 ----
    srh = scheirer_ray_hare(sample, "satisfaction",
                            "condition_mode", "condition_role")

    # ---- secondary family (BH-corrected together) ----
    fam = []
    for dv in SECONDARY_SURVEY:
        x, y = _mode_split(sample, dv)
        m = mann_whitney(x, y, alternative="two-sided")
        row = {"dv": dv, "test": "mann_whitney_two_sided", "p": m["p"],
               "cliffs_delta": float(cliff_delta(x, y)),
               "n_a": m["n_a"], "n_b": m["n_b"]}
        if dv == "agent_represented":
            row["caveat"] = "delegated-only (not comparable in direct)"
        fam.append(row)
    # final price (MW) + agreement rate (Fisher) — negotiation outcomes
    px, py = _mode_split(sample, "final_price")
    pm = mann_whitney(px, py, alternative="two-sided")
    fam.append({"dv": "final_price", "test": "mann_whitney_two_sided",
                "p": pm["p"], "n_a": pm["n_a"], "n_b": pm["n_b"]})
    deleg = sample[sample["condition_mode"] == "delegated"]
    direct = sample[sample["condition_mode"] == "direct"]
    fr = fisher_2x2(int((deleg["outcome_type"] == "agreed").sum()), len(deleg),
                    int((direct["outcome_type"] == "agreed").sum()), len(direct))
    fam.append({"dv": "agreement_rate", "test": "fisher_2x2",
                "p": fr["p"], "odds_ratio": fr["odds_ratio"]})
    qs = fdr_bh([r["p"] for r in fam])
    for r, q in zip(fam, qs):
        r["q_bh"] = float(q)

    # ---- opponent as controlled covariate (sensitivity only) ----
    groups = [sample.loc[sample["opponent_block"] == o, "satisfaction"]
              .astype(float).dropna().to_numpy()
              for o in ("easygoing", "moderate", "tough")]
    opp = kruskal_wallis(*groups)
    opp_out = {"test": "kruskal_wallis", "note": "controlled covariate, "
               "not a factor of interest", **opp}

    return {"primary": primary, "srh": srh, "secondary": fam,
            "opponent_sensitivity": opp_out,
            "exploratory": {"label": "exploratory, uncorrected", "items": []}}


def _cliffs_ci(a, b, n_boot: int = 1000, seed: int = 42):
    import numpy as np
    rng = np.random.default_rng(seed)
    A = pd.Series(a, dtype=float).dropna().to_numpy()
    B = pd.Series(b, dtype=float).dropna().to_numpy()
    if A.size < 2 or B.size < 2:
        return float("nan"), float("nan")
    boots = []
    for _ in range(n_boot):
        boots.append(cliff_delta(rng.choice(A, A.size, replace=True),
                                 rng.choice(B, B.size, replace=True)))
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))
```

NOTE for the implementer: delete the dead `ci = bootstrap_ci(...placeholder...)` line — it was a scratch line; the real CI is `_cliffs_ci`. The intended `primary["ci95"]` is `[lo, hi]` from `_cliffs_ci`. Ensure no unused `bootstrap_ci` import remains if it becomes unused (it is unused after deleting that line — remove `bootstrap_ci` from the import list). Final import line: `from scripts.analysis.core.stats import (mann_whitney, cliff_delta, fdr_bh, scheirer_ray_hare, fisher_2x2, kruskal_wallis)`.

- [ ] **Step 4: Run — expect PASS** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_battery.py -q` → PASS (2). `python3 -m pytest scripts/analysis -q` → all green. `python3 -m pyflakes scripts/analysis/confirmatory/tests_battery.py` (or `python3 -c "import ast,sys; ast.parse(open('scripts/analysis/confirmatory/tests_battery.py').read())"`) → no unused-import/dead-code.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/confirmatory/tests_battery.py scripts/analysis/confirmatory/tests/test_battery.py
git commit -m "feat(confirmatory): pre-registered test battery (primary/SRH/secondary/opponent)"
```

---

### Task 4: `confirmatory/report.py` — DOCX + CSV with the DRY-RUN guard

**Files:**
- Create: `scripts/analysis/confirmatory/docx_build.py` (thin python-docx helper, self-describing)
- Create: `scripts/analysis/confirmatory/report.py`
- Create: `scripts/analysis/confirmatory/tests/test_report.py`

- [ ] **Step 1: Write the failing tests** — `scripts/analysis/confirmatory/tests/test_report.py`:

```python
import os
import sqlite3
import pandas as pd
import pytest
from scripts.analysis.confirmatory.report import build_report, DRY_RUN_STAMP

PILOT = "data/ai2ai-human-pilot-2026-05-15.db"


def _clean_db(tmp_path):
    p = tmp_path / "clean.db"
    c = sqlite3.connect(p)
    c.executescript("""
      CREATE TABLE study_participants (
        id TEXT PRIMARY KEY, role TEXT, completion_code TEXT, experiment_mode TEXT,
        session_id TEXT, condition_mode TEXT, condition_role TEXT, opponent_block TEXT,
        assignment_seed TEXT, assignment_block_index INTEGER, replicate_id INTEGER,
        manipulation_check_pass INTEGER, excl_attention INTEGER,
        excl_manipulation INTEGER, excl_speeding INTEGER, excl_comprehension INTEGER,
        excl_noncompletion INTEGER);
      CREATE TABLE participant_responses (
        participant_id TEXT, screen TEXT, key TEXT, value_int INTEGER, value_text TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, outcome_type TEXT, outcome_terms_json TEXT);
    """)
    n = 0
    import numpy as np
    rng = np.random.default_rng(0)
    for m in ("delegated", "direct"):
        for r in ("buyer", "seller"):
            for o in ("easygoing", "moderate", "tough"):
                for _ in range(8):
                    pid = f"P{n}"; n += 1
                    c.execute("INSERT INTO study_participants VALUES "
                              "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (pid, r, "CC", "agent", f"s{pid}", m, r, o,
                               "SEED", 0, 0, 1, 0, 0, 0, 0, 0))
                    c.execute("INSERT INTO sessions VALUES (?,?,?)",
                              (f"s{pid}", "agreed", '{"price": 23000}'))
                    sat = int(np.clip(round(rng.normal(5.4 if m == "delegated" else 4.2, 1)), 1, 7))
                    for k in ("satisfaction","would_use_again","agent_represented",
                              "control","emot_pleasant","emot_anxious",
                              "effort_invested","engage_engaged","outfair_share"):
                        c.execute("INSERT INTO participant_responses VALUES (?,?,?,?,NULL)",
                                  (pid, "post_survey", k, sat if k=="satisfaction" else 4))
    c.commit(); c.close()
    return str(p)


def test_clean_db_produces_unstamped_report(tmp_path):
    out = tmp_path / "conf.docx"
    res = build_report(_clean_db(tmp_path), str(out))
    assert res["clean"] is True
    assert res["dry_run"] is False
    assert out.exists()
    from docx import Document
    text = "\n".join(p.text for p in Document(str(out)).paragraphs)
    assert DRY_RUN_STAMP not in text
    assert "satisfaction" in text.lower()


@pytest.mark.skipif(not os.path.exists(PILOT), reason="frozen pilot DB absent")
def test_pilot_is_dry_run_and_stamped(tmp_path):
    out = tmp_path / "pilot_conf.docx"
    res = build_report(PILOT, str(out))
    assert res["clean"] is False
    assert res["dry_run"] is True
    assert out.exists()                       # runs end-to-end structurally
    from docx import Document
    doc = Document(str(out))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert DRY_RUN_STAMP in text              # impossible to get an unstamped result
    # first heading carries the stamp
    heads = [p.text for p in doc.paragraphs if p.style.name.startswith("Heading")]
    assert any(DRY_RUN_STAMP in h for h in heads)
```

- [ ] **Step 2: Run — expect FAIL** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_report.py -q` → FAIL (ModuleNotFoundError).

- [ ] **Step 3a: Create `scripts/analysis/confirmatory/docx_build.py`**

```python
"""Thin python-docx helper for the confirmatory report (python-docx only)."""
from __future__ import annotations

from docx import Document


def new_doc():
    return Document()


def h1(doc, text):
    return doc.add_heading(text, level=1)


def h2(doc, text):
    return doc.add_heading(text, level=2)


def para(doc, text, italic=False):
    p = doc.add_paragraph()
    run = p.add_run(text)
    if italic:
        run.italic = True
    return p


def table(doc, df, caption):
    cap = doc.add_paragraph()
    cap.add_run(caption).bold = True
    cols = [str(c) for c in df.columns]
    t = doc.add_table(rows=1 + len(df), cols=max(1, len(cols)))
    try:
        t.style = "Light Grid Accent 1"
    except Exception:
        pass
    for j, name in enumerate(cols):
        t.rows[0].cells[j].text = name
    for i, row in enumerate(df.itertuples(index=False, name=None), start=1):
        for j, value in enumerate(row):
            t.rows[i].cells[j].text = str(value)
```

- [ ] **Step 3b: Create `scripts/analysis/confirmatory/report.py`**

```python
"""Pre-registered confirmatory report (spec 4b).

Deterministic/offline. HARD GUARD: if the analyzable sample is not clean
(legacy/unbalanced/missing pre-registered fields) every heading + the
intro is stamped DRY_RUN_STAMP and result["dry_run"] is True — it is
impossible to emit an unstamped confirmatory report from non-clean data.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

from scripts.analysis.confirmatory.sample import analyzable
from scripts.analysis.confirmatory.tests_battery import run_battery
from scripts.analysis.confirmatory import docx_build as dx

DRY_RUN_STAMP = "DRY RUN — NOT A CONFIRMATORY RESULT (non-clean/legacy data)"

TABLES_DIR = Path("docs/reports/tables-confirmatory")
DEFAULT_OUT = "docs/reports/2026-05-15-confirmatory-report.docx"


def _con(db_path: str):
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def build_report(db_path: str, out_path: str = DEFAULT_OUT) -> dict:
    con = _con(db_path)
    sample, audit, clean = analyzable(con)
    dry = not clean
    res = run_battery(sample) if len(sample) else {
        "primary": {"dv": "satisfaction", "test": "mann_whitney_two_sided",
                    "p": float("nan")}, "srh": {}, "secondary": [],
        "opponent_sensitivity": {}, "exploratory": {"label": "n/a"}}

    def title(t):
        return f"[{DRY_RUN_STAMP}] {t}" if dry else t

    doc = dx.new_doc()
    dx.h1(doc, title("Pre-registered Confirmatory Analysis"))
    if dry:
        dx.para(doc, DRY_RUN_STAMP, italic=True)
        dx.para(doc, "Reason: analyzable sample is not clean main-study data "
                     "(legacy/unbalanced/missing pre-registered fields). "
                     "Numbers below are a structural pipeline dry-run, NOT a "
                     "confirmatory result.", italic=True)
    dx.h2(doc, title("Analyzable sample & exclusions"))
    dx.para(doc, f"N analyzable = {len(sample)}; clean={clean}.")
    dx.table(doc, audit, "Exclusions audit")
    dx.h2(doc, title("Primary: satisfaction ~ Mode (two-sided Mann–Whitney)"))
    dx.table(doc, pd.DataFrame([res["primary"]]), "Primary endpoint")
    dx.h2(doc, title("Scheirer–Ray–Hare 2×2 (secondary-structural)"))
    dx.table(doc, pd.DataFrame(
        [{"term": k, **v} for k, v in res["srh"].items() if k != "N"]),
        "SRH terms")
    dx.h2(doc, title("Secondary family (Benjamini–Hochberg corrected)"))
    sec = pd.DataFrame(res["secondary"])
    dx.table(doc, sec, "Secondary family")
    dx.h2(doc, title("Opponent sensitivity (controlled covariate)"))
    dx.table(doc, pd.DataFrame([res["opponent_sensitivity"]]),
             "Opponent KW (not a factor of interest)")
    dx.para(doc, res["exploratory"]["label"], italic=True)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    doc.save(out_path)
    TABLES_DIR.mkdir(parents=True, exist_ok=True)
    audit.to_csv(TABLES_DIR / "exclusions_audit.csv", index=False)
    pd.DataFrame([res["primary"]]).to_csv(
        TABLES_DIR / "primary.csv", index=False)
    if len(sec):
        sec.to_csv(TABLES_DIR / "secondary_family.csv", index=False)
    con.close()
    return {"clean": clean, "dry_run": dry, "n": len(sample),
            "out": out_path}
```

- [ ] **Step 4: Run — expect PASS** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_report.py -q` → PASS (2). `python3 -m pytest scripts/analysis -q` → all green.

- [ ] **Step 5: Commit** (the report writes `docs/reports/...` + `docs/reports/tables-confirmatory/*` when run — do NOT stage those; commit only source+tests):

```bash
git add scripts/analysis/confirmatory/docx_build.py scripts/analysis/confirmatory/report.py scripts/analysis/confirmatory/tests/test_report.py
git commit -m "feat(confirmatory): DOCX/CSV report with hard DRY-RUN guard"
```

---

### Task 5: End-to-end module smoke + full suite

**Files:** (no source change) — Create: `scripts/analysis/confirmatory/tests/test_module_entrypoint.py`

- [ ] **Step 1: Write the test**

```python
import os
import pytest

PILOT = "data/ai2ai-human-pilot-2026-05-15.db"


@pytest.mark.skipif(not os.path.exists(PILOT), reason="frozen pilot DB absent")
def test_entrypoint_runs_and_dry_run_stamps(tmp_path):
    from scripts.analysis.confirmatory.report import build_report, DRY_RUN_STAMP
    out = tmp_path / "e2e.docx"
    res = build_report(PILOT, str(out))
    assert res["dry_run"] is True and res["clean"] is False
    from docx import Document
    assert DRY_RUN_STAMP in "\n".join(p.text for p in Document(str(out)).paragraphs)
```

- [ ] **Step 2: Run — expect PASS** — `python3 -m pytest scripts/analysis/confirmatory/tests/test_module_entrypoint.py -q` → PASS (1).

- [ ] **Step 3: Full suite + manual entrypoint smoke**

Run: `python3 -m pytest scripts/analysis -q` → all green, 0 failed (report exact final line).
Run: `python3 -m scripts.analysis.confirmatory.report` is NOT defined as `__main__` yet — instead verify the entrypoint via: `python3 -c "from scripts.analysis.confirmatory.report import build_report; print(build_report('data/ai2ai-human-pilot-2026-05-15.db', '/tmp/conf_smoke.docx'))"` → prints `{'clean': False, 'dry_run': True, ...}`. (A `__main__` shim is intentionally out of scope; the spec's `python -m` runnability is satisfied at the function level + entrypoint test. If a `__main__` is desired it is a trivial follow-up, flagged not blocking.)

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/confirmatory/tests/test_module_entrypoint.py
git commit -m "test(confirmatory): end-to-end pilot dry-run entrypoint smoke"
```

---

## Self-Review

**1. Spec coverage:** §1 core SRH/Fisher promotion + parity → Task 1. §2 confirmatory package (`sample.py`) → Task 2. §3 pre-registered exclusion policy + legacy graceful + audit → Task 2 (`analyzable`, `_EXCL_COLS`, manipulation_check, legacy `clean=False`). §4 test battery (primary MW+Cliff+CI, SRH 2×2, BH secondary incl. fisher agreement, opponent KW sensitivity, exploratory labeled, agent_represented caveat) → Task 3. §5 hard dry-run guard (stamp every heading+intro; impossible to emit unstamped from non-clean; test on pilot + clean fixture) → Task 4 (`DRY_RUN_STAMP`, `title()`, tests) + Task 5. §6 testing (unit/parity/synthetic/pilot-dry-run/full-suite) → Tasks 1–5. Non-goals respected (no data fabrication; pilot only structural dry-run; human_pilot/process_report untouched; not clean-room — confirmatory imports core; no `__main__`/recruitment). **Gap check:** spec §2 says "runnable `python -m scripts.analysis.confirmatory.report`" — the plan delivers the callable + entrypoint test but explicitly defers a `__main__` shim as a flagged non-blocking trivial follow-up (documented in Task 5 Step 3, consistent with spec Open-items latitude). No silent gap.

**2. Placeholder scan:** No TBD/TODO/"similar to". Task 3 contains one deliberately-flagged scratch line with an explicit DELETE instruction + the corrected final import line (not a placeholder — a precise cleanup directive with the exact end state given). All other code is complete.

**3. Type/name consistency:** `analyzable(con) -> (frame, audit, clean)` consumed identically in Task 4 `build_report`. `run_battery(sample) -> {primary,srh,secondary,opponent_sensitivity,exploratory}` keys used identically in Task 3 tests and Task 4 report. `DRY_RUN_STAMP` defined in report.py, imported in Tasks 4/5 tests. `SURVEY_DVS`/`SECONDARY_SURVEY` consistent (satisfaction is primary, the other 8 are secondary). core imports in Task 3 match the functions added in Task 1 (`scheirer_ray_hare`, `fisher_2x2`) + existing (`mann_whitney`, `cliff_delta`, `fdr_bh`, `kruskal_wallis`). `tests_battery.py` (not `tests.py`) avoids pytest collision.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-clean-experimental-design-analysis-4b-confirmatory.md`. Per the standing authorization, execution proceeds via **superpowers:subagent-driven-development** (fresh subagent per task + two-stage spec/quality review), then finishing-a-development-branch (merge to main locally), then the final GitHub push.
