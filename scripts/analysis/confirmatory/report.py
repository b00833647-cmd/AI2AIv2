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
# Date is the pre-registration date — deliberately fixed, NOT datetime.today().
DEFAULT_OUT = "docs/reports/2026-05-15-confirmatory-report.docx"


def _con(db_path: str):
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def build_report(db_path: str, out_path: str = DEFAULT_OUT) -> dict:
    con = _con(db_path)
    try:
        sample, audit, clean = analyzable(con)
        dry = not clean
        res = run_battery(sample) if len(sample) else {
            "primary": {"dv": "satisfaction", "test": "mann_whitney_two_sided",
                        "p": float("nan")}, "srh": {}, "secondary": [],
            "opponent_sensitivity": {}, "exploratory": {"label": "n/a"},
            "delegated_only": {}}

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
        dx.table(doc, pd.DataFrame(res["secondary"]), "Secondary family")
        dx.h2(doc, title("Delegated-only (excluded from BH family)"))
        dx.table(doc, pd.DataFrame([res["delegated_only"]]) if res.get("delegated_only")
                 else pd.DataFrame(), "agent_represented (delegated-only descriptive)")
        dx.h2(doc, title("Opponent sensitivity (controlled covariate)"))
        dx.table(doc, pd.DataFrame([res["opponent_sensitivity"]]),
                 "Opponent KW (not a factor of interest)")
        dx.para(doc, res["exploratory"]["label"], italic=True)

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        doc.save(out_path)
        TABLES_DIR.mkdir(parents=True, exist_ok=True)
        audit.to_csv(TABLES_DIR / "exclusions_audit.csv", index=False)
        pd.DataFrame([res["primary"]]).to_csv(TABLES_DIR / "primary.csv", index=False)
        if len(res["secondary"]):
            pd.DataFrame(res["secondary"]).to_csv(
                TABLES_DIR / "secondary_family.csv", index=False)
        return {"clean": clean, "dry_run": dry, "n": len(sample), "out": out_path}
    finally:
        con.close()


if __name__ == "__main__":  # pragma: no cover
    import sys
    _db = sys.argv[1] if len(sys.argv) > 1 else "data/ai2ai-human-pilot-2026-05-15.db"
    _out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    print(build_report(_db, _out))
