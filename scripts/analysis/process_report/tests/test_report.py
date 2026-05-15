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
