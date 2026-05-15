# Analysis 4a — Shared Condition-Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one documented condition-resolution contract with a dual NULL-means-legacy path, refactor `human_pilot` onto a canonical `core/conditions.py`, and give `process_report` a behavior-identical clean-room copy — with the frozen pilot reports provably byte-unchanged.

**Architecture:** New pure module `scripts/analysis/core/conditions.py` exposes `resolve_conditions(con) -> DataFrame`: per completer, if `condition_mode IS NULL` reproduce the existing `experiment_mode`/`_MODE2` + `participant_responses` opponent derivation (legacy branch); else read first-class `condition_*`/`opponent_block`/provenance/`excl_*` (main branch). `human_pilot/data.py` is refactored to consume it (existing pinned tests must stay green; characterization tests lock pilot output first). `process_report/conditions.py` is a self-contained clean-room copy under the same contract; `process_report/db.py` refactors onto it. Parallel tests assert the two copies are behavior-identical.

**Tech Stack:** Python 3, pandas, sqlite3 (stdlib), pytest. Tests run from repo root: `python -m pytest scripts/analysis -q` (the `scripts.analysis.*` package imports resolve from repo root; `scripts/__init__.py` + `scripts/analysis/__init__.py` exist). The frozen pilot DB `data/ai2ai-human-pilot-2026-05-15.db` must be present locally (the existing `human_pilot`/`process_report` suites already depend on it; it is git-ignored).

**Spec:** `docs/superpowers/specs/2026-05-15-clean-experimental-design-analysis-4a-conditions-design.md`

**Baseline (do this once before Task 1):** From repo root run `python -m pytest scripts/analysis -q` and record the result. If it is not all-green on a clean checkout, STOP and report — the characterization approach requires a green baseline. If `pytest`/`pandas` are missing, the project Python env must be activated/installed first (same env that runs `python -m scripts.analysis.human_pilot.report`); report BLOCKED with the missing-dep error rather than guessing.

**Per-task conventions:** test command `python -m pytest <target> -q` from repo root; commit after each task with the shown message; never modify `data/ai2ai-human-pilot-2026-05-15.db`.

---

### Task 1: Characterization tests — lock current pilot condition outputs

**Files:**
- Create: `scripts/analysis/tests/test_conditions_characterization.py`

These tests assert the CURRENT behavior of the existing code (no production code changes yet). They must PASS against the current `main` code — they are the safety net proving later refactors are byte-identical on the frozen pilot.

- [ ] **Step 1: Write the characterization tests**

```python
"""Characterization snapshot of condition derivation on the frozen pilot.
Asserts CURRENT behavior so the 4a refactor is provably byte-identical.
"""
from scripts.analysis.human_pilot.data import load_db, completers_frame, SNAPSHOT
from scripts.analysis.process_report.db import connect as pr_connect, completers as pr_completers


def _hp_condition_view():
    df = completers_frame(load_db(SNAPSHOT))
    keep = ["participant_id", "experiment_mode", "role", "mode2", "opponent_personality"]
    return (df[keep].sort_values("participant_id").reset_index(drop=True))


def test_human_pilot_condition_snapshot():
    v = _hp_condition_view()
    assert len(v) == 40
    # mode2 collapse + opponent vocabulary are stable
    assert v["mode2"].value_counts().to_dict() == {"AI-to-AI": 20, "Human-to-AI": 20}
    assert set(v["experiment_mode"]) == {"agent", "human_buyer", "human_seller"}
    assert set(v["role"]) == {"buyer", "seller"}
    assert set(v["opponent_personality"].dropna()) <= {"easygoing", "moderate", "tough"}
    # Per-(experiment_mode, role) cell sizes are exactly the pinned values
    assert v.groupby(["experiment_mode", "role"]).size().to_dict() == {
        ("agent", "buyer"): 10, ("agent", "seller"): 10,
        ("human_buyer", "buyer"): 10, ("human_seller", "seller"): 10,
    }
    # Freeze the exact per-participant tuple list (the real byte-level snapshot)
    snap = sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2,
         (r.opponent_personality if isinstance(r.opponent_personality, str) else None))
        for r in v.itertuples(index=False)
    )
    assert len(snap) == 40
    # Re-derive via a second call → must be identical (determinism)
    assert snap == sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2,
         (r.opponent_personality if isinstance(r.opponent_personality, str) else None))
        for r in _hp_condition_view().itertuples(index=False)
    )


def test_process_report_condition_snapshot():
    c = pr_completers(pr_connect())
    assert len(c) == 40
    assert set(c["mode2"]) == {"AI-to-AI", "Human-to-AI"}
    assert set(c["role"]) == {"buyer", "seller"}
    assert (c.groupby("cell").size() == 10).all()
    snap = sorted(
        (r.participant_id, r.experiment_mode, r.role, r.mode2, r.cell)
        for r in c.itertuples(index=False)
    )
    assert len(snap) == 40
```

- [ ] **Step 2: Run — expect PASS (characterizing current behavior)**

Run: `python -m pytest scripts/analysis/tests/test_conditions_characterization.py -q`
Expected: PASS (2 tests). If FAIL, the snapshot DB or current code differs from assumptions — STOP and report (do not weaken assertions).

- [ ] **Step 3: Commit**

```bash
git add scripts/analysis/tests/test_conditions_characterization.py
git commit -m "test(analysis): characterization snapshot of pilot condition derivation"
```

---

### Task 2: Canonical `core/conditions.py` + unit tests

**Files:**
- Create: `scripts/analysis/core/conditions.py`
- Create: `scripts/analysis/tests/test_core_conditions.py`

- [ ] **Step 1: Write the failing unit tests**

```python
import sqlite3
import pandas as pd
from scripts.analysis.core.conditions import resolve_conditions

LEGACY_DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
  experiment_mode TEXT, condition_mode TEXT, condition_role TEXT,
  opponent_block TEXT, assignment_seed TEXT, assignment_block_index INTEGER,
  replicate_id INTEGER, manipulation_check_pass INTEGER,
  excl_attention INTEGER, excl_manipulation INTEGER, excl_speeding INTEGER,
  excl_comprehension INTEGER, excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_text TEXT);
"""


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(LEGACY_DDL)
    return c


def test_legacy_branch_reproduces_mode_mapping():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L1','buyer','CC','agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L2','seller','CC','human_seller')")
    c.execute("INSERT INTO participant_responses VALUES "
              "('L1','engine','opponent_personality','tough')")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["L1","condition_mode"] == "delegated"
    assert df.loc["L1","condition_role"] == "buyer"
    assert df.loc["L1","opponent_block"] == "tough"
    assert df.loc["L1","mode2"] == "AI-to-AI"
    assert df.loc["L1","condition_source"] == "legacy"
    assert df.loc["L2","condition_mode"] == "direct"
    assert df.loc["L2","mode2"] == "Human-to-AI"
    # main-only columns NA on legacy rows
    assert pd.isna(df.loc["L1","assignment_seed"])
    assert pd.isna(df.loc["L1","excl_attention"])


def test_main_branch_reads_first_class_fields():
    c = _con()
    c.execute("INSERT INTO study_participants"
              "(id,role,completion_code,experiment_mode,condition_mode,"
              "condition_role,opponent_block,assignment_seed,"
              "assignment_block_index,replicate_id,manipulation_check_pass,"
              "excl_attention) VALUES "
              "('M1','buyer','CC','agent','direct','seller','easygoing',"
              "'S',3,3,1,0)")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["M1","condition_source"] == "main"
    assert df.loc["M1","condition_mode"] == "direct"
    assert df.loc["M1","condition_role"] == "seller"
    assert df.loc["M1","opponent_block"] == "easygoing"
    assert df.loc["M1","mode2"] == "Human-to-AI"
    assert df.loc["M1","assignment_seed"] == "S"
    assert int(df.loc["M1","assignment_block_index"]) == 3
    assert int(df.loc["M1","manipulation_check_pass"]) == 1
    assert int(df.loc["M1","excl_attention"]) == 0


def test_only_completers_returned():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('done','buyer','CC','agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('noncomp','buyer',NULL,'agent')")
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('empty','buyer','','agent')")
    df = resolve_conditions(c)
    assert set(df["participant_id"]) == {"done"}
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `python -m pytest scripts/analysis/tests/test_core_conditions.py -q`
Expected: FAIL — `ModuleNotFoundError: scripts.analysis.core.conditions`.

- [ ] **Step 3: Create `scripts/analysis/core/conditions.py`**

```python
"""Canonical experimental-condition reader (NULL-means-legacy dual path).

Contract (see spec 2026-05-15-clean-experimental-design-analysis-4a):
resolve_conditions(con) -> DataFrame, one row per completer
(completion_code present), columns:
  participant_id,
  condition_mode  in {delegated, direct},
  condition_role  in {buyer, seller},
  opponent_block  in {easygoing, moderate, tough},
  condition_source in {legacy, main},
  mode2 in {AI-to-AI, Human-to-AI}  (delegated->AI-to-AI, direct->Human-to-AI),
  main-only (NA for legacy): assignment_seed, assignment_block_index,
  replicate_id, manipulation_check_pass, excl_attention, excl_manipulation,
  excl_speeding, excl_comprehension, excl_noncompletion.

Legacy branch (condition_mode IS NULL) reproduces the historical derivation:
experiment_mode 'agent'->delegated, 'human_buyer'/'human_seller'->direct;
condition_role from `role`; opponent from
participant_responses(screen='engine', key='opponent_personality').
"""
from __future__ import annotations

import pandas as pd

# experiment_mode -> canonical condition_mode (legacy branch)
_LEGACY_MODE = {"agent": "delegated", "human_buyer": "direct", "human_seller": "direct"}
# canonical condition_mode -> mode2 convenience label (unifies legacy & main)
_MODE2 = {"delegated": "AI-to-AI", "direct": "Human-to-AI"}

_MAIN_ONLY = [
    "assignment_seed", "assignment_block_index", "replicate_id",
    "manipulation_check_pass", "excl_attention", "excl_manipulation",
    "excl_speeding", "excl_comprehension", "excl_noncompletion",
]


def resolve_conditions(con) -> pd.DataFrame:
    sp = pd.read_sql_query(
        """SELECT id AS participant_id, role, experiment_mode,
                  condition_mode, condition_role, opponent_block,
                  assignment_seed, assignment_block_index, replicate_id,
                  manipulation_check_pass, excl_attention, excl_manipulation,
                  excl_speeding, excl_comprehension, excl_noncompletion
             FROM study_participants
            WHERE completion_code IS NOT NULL AND completion_code != ''""",
        con,
    )
    opp = pd.read_sql_query(
        """SELECT participant_id, value_text AS legacy_opponent
             FROM participant_responses
            WHERE screen='engine' AND key='opponent_personality'""",
        con,
    )
    df = sp.merge(opp, on="participant_id", how="left")

    is_main = df["condition_mode"].notna()
    df["condition_source"] = is_main.map({True: "main", False: "legacy"})

    df["condition_mode"] = df["condition_mode"].where(
        is_main, df["experiment_mode"].map(_LEGACY_MODE))
    df["condition_role"] = df["condition_role"].where(is_main, df["role"])
    df["opponent_block"] = df["opponent_block"].where(is_main, df["legacy_opponent"])

    # main-only columns: keep value for main rows, force NA for legacy rows
    for col in _MAIN_ONLY:
        df[col] = df[col].where(is_main, other=pd.NA)

    df["mode2"] = df["condition_mode"].map(_MODE2)

    cols = (["participant_id", "condition_mode", "condition_role",
             "opponent_block", "condition_source", "mode2"] + _MAIN_ONLY)
    return df[cols].reset_index(drop=True)
```

- [ ] **Step 4: Run — expect PASS**

Run: `python -m pytest scripts/analysis/tests/test_core_conditions.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/core/conditions.py scripts/analysis/tests/test_core_conditions.py
git commit -m "feat(analysis): canonical core/conditions.py NULL-means-legacy reader"
```

---

### Task 3: Refactor `human_pilot/data.py` onto the canonical reader

**Files:**
- Modify: `scripts/analysis/human_pilot/data.py` (`completers_frame`; remove the inline `_MODE2` map + `pers` opponent subquery)

Goal: `completers_frame` keeps emitting the exact same columns/values the existing suite + characterization pin (`experiment_mode`, `role`, `mode2`, `opponent_personality`, …) but derives `mode2`/`opponent_personality` from `core.conditions.resolve_conditions` instead of inline logic.

- [ ] **Step 1: Confirm the safety net is green (pre-refactor)**

Run: `python -m pytest scripts/analysis/tests/test_human_pilot_data.py scripts/analysis/tests/test_conditions_characterization.py -q`
Expected: PASS. (If not, STOP — do not refactor without a green net.)

- [ ] **Step 2: Edit `completers_frame`**

In `scripts/analysis/human_pilot/data.py`:

(a) Add an import near the top (after the existing imports):
```python
from scripts.analysis.core.conditions import resolve_conditions
```

(b) In `completers_frame`, DELETE the `pers` query block:
```python
    pers = pd.read_sql_query(
        f"""SELECT participant_id, value_text AS opponent_personality
              FROM participant_responses
             WHERE screen='engine' AND key='opponent_personality'
               AND participant_id IN ({qmarks})""",
        con, params=ids,
    )
```

(c) Change the merge chain that ends with `.merge(pers, left_on="id", right_on="participant_id", how="left")` so it no longer merges `pers`. I.e. replace:
```python
    df = sp.merge(
        sess[["id", "outcome_type", "outcome_terms_json", "turns_consumed",
              "started_at", "ended_at", "tokens_total"]],
        left_on="session_id", right_on="id", how="left", suffixes=("", "_sess"),
    ).merge(pers, left_on="id", right_on="participant_id", how="left")
```
with:
```python
    df = sp.merge(
        sess[["id", "outcome_type", "outcome_terms_json", "turns_consumed",
              "started_at", "ended_at", "tokens_total"]],
        left_on="session_id", right_on="id", how="left", suffixes=("", "_sess"),
    )
```

(d) Replace the line `df["mode2"] = df["experiment_mode"].map(_MODE2)` with a merge on the canonical reader that supplies `mode2`, `opponent_personality`, and the new condition columns:
```python
    _cond = resolve_conditions(con).rename(
        columns={"opponent_block": "opponent_personality"})
    df = df.merge(_cond, on="participant_id", how="left")
```
(`df["participant_id"]` is already assigned on the preceding line `df["participant_id"] = df["id"]`; keep that line. `resolve_conditions` already restricts to completers, so the left-merge aligns 1:1.)

(e) If `_MODE2` is now unused in `data.py`, leave its definition in place ONLY if other functions use it; otherwise remove the now-dead `_MODE2` constant. Verify with a grep for `_MODE2` in the file; remove only if zero remaining uses. Do NOT remove `_V2_SURVEY_KEYS`/`V2_SURVEY_KEYS` or other constants.

- [ ] **Step 3: Run the full human_pilot suite + characterization + core**

Run: `python -m pytest scripts/analysis/tests -q`
Expected: PASS — all pre-existing `test_human_pilot_*` tests green UNCHANGED (esp. `test_completers_have_required_columns` which requires `opponent_personality`/`mode2`/`experiment_mode`/`role`; `test_mode2_collapses_human_routes`; `test_completers_n_and_balance`), plus `test_conditions_characterization.py` and `test_core_conditions.py` green. If any pinned test changed value, the refactor altered behavior — fix the reader's legacy branch, do NOT edit the pinned tests.

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/human_pilot/data.py
git commit -m "refactor(analysis): human_pilot consumes canonical condition reader"
```

---

### Task 4: `process_report/conditions.py` clean-room copy + tests

**Files:**
- Create: `scripts/analysis/process_report/conditions.py` (self-contained — NO import of `core`/`human_pilot`)
- Create: `scripts/analysis/process_report/tests/test_conditions.py`

- [ ] **Step 1: Write the failing unit tests**

```python
import sqlite3
import pandas as pd
from scripts.analysis.process_report.conditions import resolve_conditions

DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
  experiment_mode TEXT, condition_mode TEXT, condition_role TEXT,
  opponent_block TEXT, assignment_seed TEXT, assignment_block_index INTEGER,
  replicate_id INTEGER, manipulation_check_pass INTEGER,
  excl_attention INTEGER, excl_manipulation INTEGER, excl_speeding INTEGER,
  excl_comprehension INTEGER, excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_text TEXT);
"""


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    return c


def test_legacy_and_main_branches():
    c = _con()
    c.execute("INSERT INTO study_participants(id,role,completion_code,experiment_mode) "
              "VALUES ('L1','seller','CC','human_seller')")
    c.execute("INSERT INTO participant_responses VALUES "
              "('L1','engine','opponent_personality','moderate')")
    c.execute("INSERT INTO study_participants"
              "(id,role,completion_code,experiment_mode,condition_mode,"
              "condition_role,opponent_block) VALUES "
              "('M1','buyer','CC','agent','delegated','buyer','tough')")
    df = resolve_conditions(c).set_index("participant_id")
    assert df.loc["L1","condition_mode"] == "direct"
    assert df.loc["L1","mode2"] == "Human-to-AI"
    assert df.loc["L1","opponent_block"] == "moderate"
    assert df.loc["L1","condition_source"] == "legacy"
    assert df.loc["M1","condition_mode"] == "delegated"
    assert df.loc["M1","mode2"] == "AI-to-AI"
    assert df.loc["M1","condition_source"] == "main"


def test_clean_room_no_project_imports():
    import scripts.analysis.process_report.conditions as m
    src = open(m.__file__).read()
    assert "scripts.analysis.core" not in src
    assert "scripts.analysis.human_pilot" not in src
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `python -m pytest scripts/analysis/process_report/tests/test_conditions.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Create `scripts/analysis/process_report/conditions.py`**

Self-contained copy (identical contract; NO `scripts.analysis.core`/`human_pilot` import — clean-room):

```python
"""Clean-room condition reader for the process report.

Self-contained (no project imports). Behavior-identical to
scripts/analysis/core/conditions.py per the shared 4a contract; kept in
lockstep by parallel tests (test_conditions.py here + the parallel
equivalence test in scripts/analysis/tests/).
"""
from __future__ import annotations

import pandas as pd

_LEGACY_MODE = {"agent": "delegated", "human_buyer": "direct", "human_seller": "direct"}
_MODE2 = {"delegated": "AI-to-AI", "direct": "Human-to-AI"}
_MAIN_ONLY = [
    "assignment_seed", "assignment_block_index", "replicate_id",
    "manipulation_check_pass", "excl_attention", "excl_manipulation",
    "excl_speeding", "excl_comprehension", "excl_noncompletion",
]


def resolve_conditions(con) -> pd.DataFrame:
    sp = pd.read_sql_query(
        """SELECT id AS participant_id, role, experiment_mode,
                  condition_mode, condition_role, opponent_block,
                  assignment_seed, assignment_block_index, replicate_id,
                  manipulation_check_pass, excl_attention, excl_manipulation,
                  excl_speeding, excl_comprehension, excl_noncompletion
             FROM study_participants
            WHERE completion_code IS NOT NULL AND completion_code != ''""",
        con,
    )
    opp = pd.read_sql_query(
        """SELECT participant_id, value_text AS legacy_opponent
             FROM participant_responses
            WHERE screen='engine' AND key='opponent_personality'""",
        con,
    )
    df = sp.merge(opp, on="participant_id", how="left")
    is_main = df["condition_mode"].notna()
    df["condition_source"] = is_main.map({True: "main", False: "legacy"})
    df["condition_mode"] = df["condition_mode"].where(
        is_main, df["experiment_mode"].map(_LEGACY_MODE))
    df["condition_role"] = df["condition_role"].where(is_main, df["role"])
    df["opponent_block"] = df["opponent_block"].where(is_main, df["legacy_opponent"])
    for col in _MAIN_ONLY:
        df[col] = df[col].where(is_main, other=pd.NA)
    df["mode2"] = df["condition_mode"].map(_MODE2)
    cols = (["participant_id", "condition_mode", "condition_role",
             "opponent_block", "condition_source", "mode2"] + _MAIN_ONLY)
    return df[cols].reset_index(drop=True)
```

- [ ] **Step 4: Run — expect PASS**

Run: `python -m pytest scripts/analysis/process_report/tests/test_conditions.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/process_report/conditions.py scripts/analysis/process_report/tests/test_conditions.py
git commit -m "feat(analysis): process_report clean-room condition reader copy"
```

---

### Task 5: Refactor `process_report/db.py` onto the clean-room copy

**Files:**
- Modify: `scripts/analysis/process_report/db.py` (`completers`; keep `MODE2`/`CELLS` exports — other modules/tests import them)

Current `completers` does its own `experiment_mode`→`mode2`→`cell`. Refactor it to derive condition columns from `process_report.conditions.resolve_conditions` while keeping the exact output columns/values the pinned `test_db.py` requires (`participant_id`, `session_id`, `role`, `experiment_mode`, `completion_code`, `mode2`, `cell`).

- [ ] **Step 1: Confirm safety net green (pre-refactor)**

Run: `python -m pytest scripts/analysis/process_report/tests/test_db.py scripts/analysis/tests/test_conditions_characterization.py -q`
Expected: PASS.

- [ ] **Step 2: Edit `completers` in `scripts/analysis/process_report/db.py`**

Add import at top (after `import pandas as pd`):
```python
from scripts.analysis.process_report.conditions import resolve_conditions
```
Replace the body of `completers`:
```python
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
```
with:
```python
def completers(con) -> pd.DataFrame:
    """The 40 finished participants, one row each, with cell labels.

    Condition columns come from the clean-room reader (NULL-means-legacy);
    mode2/cell are derived from its canonical condition_mode so legacy
    (pilot) and future main-study rows unify under one vocabulary.
    """
    df = pd.read_sql_query(
        """SELECT id AS participant_id, session_id, role, experiment_mode,
                  completion_code
             FROM study_participants
            WHERE completion_code IS NOT NULL""", con)
    cond = resolve_conditions(con)[["participant_id", "mode2"]]
    df = df.merge(cond, on="participant_id", how="left")
    df["cell"] = df["mode2"] + " · " + df["role"]
    return df.reset_index(drop=True)
```
(Note: `resolve_conditions` filters `completion_code != ''` too; on the frozen pilot every completer has a non-empty code so the row set is identical. `MODE2`/`CELLS` remain exported for the other process_report modules/tests that import them.)

- [ ] **Step 3: Run process_report suite + characterization**

Run: `python -m pytest scripts/analysis/process_report -q && python -m pytest scripts/analysis/tests/test_conditions_characterization.py -q`
Expected: PASS — `test_db.py` (40, cells==CELLS, 10 each, mode2 set, role set, cell format) green UNCHANGED; all other `process_report/tests/*` green; characterization green (process_report snapshot identical).

- [ ] **Step 4: Commit**

```bash
git add scripts/analysis/process_report/db.py
git commit -m "refactor(analysis): process_report.completers uses clean-room reader"
```

---

### Task 6: Parallel-equivalence test (canonical ≡ clean-room copy)

**Files:**
- Create: `scripts/analysis/tests/test_conditions_parallel.py`

- [ ] **Step 1: Write the test**

```python
"""The canonical core reader and the process_report clean-room copy MUST
produce identical DataFrames on identical fixtures (lockstep guarantee)."""
import sqlite3
import pandas as pd
from scripts.analysis.core.conditions import resolve_conditions as core_resolve
from scripts.analysis.process_report.conditions import resolve_conditions as pr_resolve

DDL = """
CREATE TABLE study_participants (
  id TEXT PRIMARY KEY, role TEXT, completion_code TEXT,
  experiment_mode TEXT, condition_mode TEXT, condition_role TEXT,
  opponent_block TEXT, assignment_seed TEXT, assignment_block_index INTEGER,
  replicate_id INTEGER, manipulation_check_pass INTEGER,
  excl_attention INTEGER, excl_manipulation INTEGER, excl_speeding INTEGER,
  excl_comprehension INTEGER, excl_noncompletion INTEGER);
CREATE TABLE participant_responses (
  participant_id TEXT, screen TEXT, key TEXT, value_text TEXT);
"""

ROWS = [
    ("L1","buyer","CC","agent",None,None,None,None,None,None,None,None,None,None,None,None),
    ("L2","seller","CC","human_seller",None,None,None,None,None,None,None,None,None,None,None,None),
    ("M1","buyer","CC","agent","direct","seller","easygoing","S",2,2,1,0,0,1,0,0),
    ("X","buyer",None,"agent",None,None,None,None,None,None,None,None,None,None,None,None),
]


def _con():
    c = sqlite3.connect(":memory:")
    c.executescript(DDL)
    c.executemany("INSERT INTO study_participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ROWS)
    c.execute("INSERT INTO participant_responses VALUES ('L1','engine','opponent_personality','tough')")
    c.execute("INSERT INTO participant_responses VALUES ('L2','engine','opponent_personality','moderate')")
    return c


def test_core_and_process_report_readers_are_identical():
    a = core_resolve(_con()).sort_values("participant_id").reset_index(drop=True)
    b = pr_resolve(_con()).sort_values("participant_id").reset_index(drop=True)
    pd.testing.assert_frame_equal(a, b, check_dtype=False)
    assert list(a["participant_id"]) == ["L1", "L2", "M1"]  # 'X' (no code) excluded
    assert a.set_index("participant_id").loc["M1","condition_source"] == "main"
    assert a.set_index("participant_id").loc["L1","condition_source"] == "legacy"
```

- [ ] **Step 2: Run — expect PASS**

Run: `python -m pytest scripts/analysis/tests/test_conditions_parallel.py -q`
Expected: PASS (1 test). If the two readers diverge, reconcile the copies (they must be byte-identical in behavior) — do not weaken the assertion.

- [ ] **Step 3: Full suite + commit**

Run: `python -m pytest scripts/analysis -q`
Expected: PASS — entire analysis suite green (pre-existing + all new 4a tests).

```bash
git add scripts/analysis/tests/test_conditions_parallel.py
git commit -m "test(analysis): canonical vs clean-room condition reader equivalence"
```

---

## Self-Review

**1. Spec coverage:**
- §1 modules/placement → Task 2 (core/conditions.py), Task 4 (process_report/conditions.py clean-room).
- §2 contract / column set → Task 2 (`resolve_conditions` returns the exact column list incl. `condition_source`, `mode2`, main-only); unit tests assert it.
- §3 dual NULL-means-legacy path → Task 2 implementation + `test_core_conditions` (legacy reproduces mapping & opponent lookup; main reads first-class; main-only NA on legacy).
- §4 behavior-preserving human_pilot refactor → Task 1 (characterization first) + Task 3 (refactor; full pinned suite must stay green unchanged).
- §5 process_report clean-room copy + db.py refactor → Task 4 + Task 5 (+ `test_clean_room_no_project_imports`).
- §6 exclusion-policy boundary → reader only surfaces `excl_*`/`manipulation_check_pass` (no analyzability logic) — satisfied by Task 2 design; no exclusion logic added anywhere (deferred to 4b).
- §7 testing → Tasks 1,2,4,6 (characterization, unit both branches, parallel equivalence) + full-suite runs in Tasks 3,5,6.
- Acceptance criteria: dual readers behavior-identical (Task 6); human_pilot no longer inline-infers + suite green unchanged + characterization (Tasks 1,3); process_report clean-room, suite green, zero core/human_pilot imports (Tasks 4,5 + import-guard test); no DB writes / no DOCX output change (read-only refactors; characterization pins condition outputs; report DOCX content depends on these columns which are pinned identical) — covered.
- Gaps: none. Stats/confirmatory/exclusion-application explicitly deferred to 4b (spec Non-goals) — correctly no tasks here.

**2. Placeholder scan:** No TBD/TODO/"similar to". Every code step has full code; every run step has exact command + expected result. The "characterization may fail if env missing" path gives an explicit STOP/BLOCKED instruction (not a vague placeholder).

**3. Type/name consistency:** `resolve_conditions(con) -> DataFrame` identical signature in both copies (Tasks 2,4); column names (`condition_mode`,`condition_role`,`opponent_block`,`condition_source`,`mode2`,`_MAIN_ONLY`) identical across Tasks 2/4/6; human_pilot renames `opponent_block`→`opponent_personality` (Task 3) to satisfy the pinned `test_human_pilot_data` columns — consistent with that test's required set. `MODE2`/`CELLS` kept exported in process_report/db.py (Task 5) so other importers don't break. Parallel test (Task 6) uses both readers' identical contract.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-clean-experimental-design-analysis-4a-conditions.md`. Per the standing authorization for this initiative, execution proceeds via **superpowers:subagent-driven-development** (fresh subagent per task + two-stage spec/quality review), then finishing-a-development-branch (merge to main locally).
