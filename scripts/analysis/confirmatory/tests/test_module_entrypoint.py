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
