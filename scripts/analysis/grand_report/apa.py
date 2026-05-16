"""APA-7 python-docx builder with auto Table of Contents / List of
Tables / List of Figures (real Word fields) and SEQ-numbered captions,
so a 150-page single document stays navigable and coherent.

Open in Word and "Update Field" (or it updates on open) to populate the
ToC/LoT/LoF page numbers.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

FONT = "Times New Roman"
SZ = Pt(12)
SM = Pt(10)


def _r(p, text, *, b=False, i=False, sz=SZ, color=None):
    run = p.add_run(text)
    run.bold = b
    run.italic = i
    run.font.name = FONT
    run.font.size = sz
    if color:
        run.font.color.rgb = color
    return run


def _field(p, instr: str):
    """Insert a Word field (TOC / SEQ / PAGE)."""
    b = OxmlElement("w:fldChar")
    b.set(qn("w:fldCharType"), "begin")
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    s = OxmlElement("w:fldChar")
    s.set(qn("w:fldCharType"), "separate")
    e = OxmlElement("w:fldChar")
    e.set(qn("w:fldCharType"), "end")
    run = p.add_run()
    run.font.name = FONT
    run.font.size = SZ
    run._r.append(b)
    run._r.append(it)
    run._r.append(s)
    run._r.append(e)


def _style_headings(doc):
    spec = {"Heading 1": (16, True, False, WD_ALIGN_PARAGRAPH.CENTER),
            "Heading 2": (13, True, False, WD_ALIGN_PARAGRAPH.LEFT),
            "Heading 3": (12, True, True, WD_ALIGN_PARAGRAPH.LEFT)}
    for nm, (pt, bold, ital, al) in spec.items():
        st = doc.styles[nm]
        st.font.name = FONT
        st.font.size = Pt(pt)
        st.font.bold = bold
        st.font.italic = ital
        st.font.color.rgb = RGBColor(0, 0, 0)
        st.paragraph_format.alignment = al
        st.paragraph_format.space_before = Pt(14)
        st.paragraph_format.space_after = Pt(6)
        st.paragraph_format.keep_with_next = True
    if "Caption" in [s.name for s in doc.styles]:
        cap = doc.styles["Caption"]
    else:
        cap = doc.styles.add_style("Caption", WD_STYLE_TYPE.PARAGRAPH)
    cap.font.name = FONT
    cap.font.size = SM
    cap.font.italic = False
    cap.font.color.rgb = RGBColor(0, 0, 0)


def new_doc(running_head: str) -> Document:
    doc = Document()
    nm = doc.styles["Normal"]
    nm.font.name = FONT
    nm.font.size = SZ
    nm.paragraph_format.line_spacing = 2.0
    nm.paragraph_format.space_after = Pt(0)
    for s in doc.sections:
        s.left_margin = s.right_margin = Inches(1)
        s.top_margin = s.bottom_margin = Inches(1)
        hp = s.header.paragraphs[0]
        hp.text = ""
        hp.paragraph_format.line_spacing = 1.0
        hp.paragraph_format.tab_stops.add_tab_stop(
            Inches(6.5), WD_TAB_ALIGNMENT.RIGHT)
        _r(hp, running_head.upper()[:50])
        hp.add_run("\t")
        _field(hp, "PAGE")
    _style_headings(doc)
    return doc


def page_break(doc):
    doc.add_page_break()


def _center(doc, text, *, b=False):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _r(p, text, b=b)
    return p


def title_page(doc, *, title, author, affiliation, course, note):
    for _ in range(3):
        doc.add_paragraph()
    _center(doc, title, b=True)
    doc.add_paragraph()
    _center(doc, author)
    _center(doc, affiliation)
    _center(doc, course)
    for _ in range(4):
        doc.add_paragraph()
    _center(doc, "Author Note", b=True)
    for para in note:
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Inches(0.5)
        _r(p, para)
    page_break(doc)


def abstract_page(doc, text, keywords):
    _center(doc, "Abstract", b=True)
    p = doc.add_paragraph()
    _r(p, text)
    kp = doc.add_paragraph()
    kp.paragraph_format.first_line_indent = Inches(0.5)
    _r(kp, "Keywords: ", i=True)
    _r(kp, ", ".join(keywords))
    page_break(doc)


def front_lists(doc):
    """Auto Table of Contents + List of Tables + List of Figures."""
    for heading, instr in [
        ("Table of Contents", 'TOC \\o "1-3" \\h \\z \\u'),
        ("List of Tables", 'TOC \\h \\z \\c "Table"'),
        ("List of Figures", 'TOC \\h \\z \\c "Figure"')]:
        _center(doc, heading, b=True)
        p = doc.add_paragraph()
        _field(p, instr)
        note = doc.add_paragraph()
        _r(note, "(In Word: select all and press F9 to populate page "
                 "numbers.)", i=True, sz=SM)
        page_break(doc)


def h1(doc, text):
    doc.add_paragraph(text, style="Heading 1")


def h2(doc, text):
    doc.add_paragraph(text, style="Heading 2")


def h3(doc, text):
    doc.add_paragraph(text, style="Heading 3")


def body(doc, text, *, indent=True, italic=False):
    p = doc.add_paragraph()
    if indent:
        p.paragraph_format.first_line_indent = Inches(0.5)
    _r(p, text, i=italic)


def bullets(doc, items):
    for it in items:
        p = doc.add_paragraph(style="List Bullet")
        _r(p, it)
        p.paragraph_format.line_spacing = 2.0


def _caption(doc, kind: str, title: str):
    """Caption with a SEQ field so the LoT/LoF TOC fields collect it."""
    p = doc.add_paragraph(style="Caption")
    _r(p, f"{kind} ", b=True)
    _field(p, f"SEQ {kind} \\* ARABIC")
    _r(p, ". ", b=True)
    _r(p, title, i=True)


def _pad(cell):
    for p in cell.paragraphs:
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.space_after = Pt(0)


def _borders(table):
    pr = table._tbl.tblPr
    bd = OxmlElement("w:tblBorders")
    for e, val in (("top", "single"), ("bottom", "single"),
                   ("left", "none"), ("right", "none"),
                   ("insideV", "none"), ("insideH", "none")):
        el = OxmlElement(f"w:{e}")
        el.set(qn("w:val"), val)
        el.set(qn("w:sz"), "4")
        el.set(qn("w:color"), "000000")
        bd.append(el)
    pr.append(bd)
    for c in table.rows[0].cells:
        tcpr = c._tc.get_or_add_tcPr()
        tb = OxmlElement("w:tcBorders")
        bo = OxmlElement("w:bottom")
        bo.set(qn("w:val"), "single")
        bo.set(qn("w:sz"), "4")
        bo.set(qn("w:color"), "000000")
        tb.append(bo)
        tcpr.append(tb)


def table(doc, df: pd.DataFrame, title: str, note: str | None = None):
    _caption(doc, "Table", title)
    cols = [str(c) for c in df.columns]
    t = doc.add_table(rows=1 + len(df), cols=len(cols))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, c in enumerate(cols):
        cell = t.rows[0].cells[j]
        cell.text = ""
        _r(cell.paragraphs[0], c, b=True, sz=Pt(9))
        _pad(cell)
    for i, (_, row) in enumerate(df.iterrows()):
        for j, c in enumerate(df.columns):
            cell = t.rows[i + 1].cells[j]
            cell.text = ""
            v = "" if pd.isna(row[c]) else str(row[c])
            _r(cell.paragraphs[0], v, sz=Pt(9))
            _pad(cell)
    _borders(t)
    if note:
        np_ = doc.add_paragraph()
        _r(np_, "Note. ", i=True, sz=SM)
        _r(np_, note, sz=SM)
    doc.add_paragraph()


def figure(doc, png: Path, title: str, note: str | None = None,
           width_in: float = 6.0):
    _caption(doc, "Figure", title)
    ip = doc.add_paragraph()
    ip.alignment = WD_ALIGN_PARAGRAPH.CENTER
    ip.paragraph_format.line_spacing = 1.0
    ip.add_run().add_picture(str(png), width=Inches(width_in))
    if note:
        np_ = doc.add_paragraph()
        _r(np_, "Note. ", i=True, sz=SM)
        _r(np_, note, sz=SM)
    doc.add_paragraph()


def references(doc, refs):
    h1(doc, "References")
    for ref in refs:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.5)
        p.paragraph_format.first_line_indent = Inches(-0.5)
        _r(p, ref)
