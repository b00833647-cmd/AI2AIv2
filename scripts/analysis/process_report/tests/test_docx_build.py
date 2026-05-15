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
