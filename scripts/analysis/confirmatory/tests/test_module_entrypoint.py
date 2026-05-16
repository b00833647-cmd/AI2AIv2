"""End-to-end: `python -m scripts.analysis.confirmatory.report` actually
runs as a module and the pilot path is a stamped DRY-RUN (distinct from
test_report.py which calls build_report() in-process)."""
import os
import subprocess
import sys

import pytest

PILOT = "data/ai2ai-human-pilot-2026-05-15.db"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


@pytest.mark.skipif(not os.path.exists(os.path.join(REPO, PILOT)),
                    reason="frozen pilot DB absent")
def test_module_runs_via_python_m_and_dry_run_stamped(tmp_path):
    out = tmp_path / "e2e_cli.docx"
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.analysis.confirmatory.report",
         PILOT, str(out)],
        cwd=REPO, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "'dry_run': True" in proc.stdout
    assert "'clean': False" in proc.stdout
    assert out.exists()
    from docx import Document
    from scripts.analysis.confirmatory.report import DRY_RUN_STAMP
    text = "\n".join(p.text for p in Document(str(out)).paragraphs)
    assert DRY_RUN_STAMP in text
