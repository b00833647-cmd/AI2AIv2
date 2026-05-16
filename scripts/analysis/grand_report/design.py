"""The single source of visual + numeric coherence.

Every colour, font, figure, table, and number in the document is styled
from this module — nothing is formatted ad hoc. Mode is encoded by hue
family and Role by shade, so the four experiments (X1–X4) look identical
everywhere in the manuscript.
"""
from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

# ── paths / manuscript constants ────────────────────────────────────
FIG_DIR = Path("docs/reports/figures-grand")
TBL_DIR = Path("docs/reports/tables-grand")
OUT = Path("docs/reports/2026-05-16-ai2ai-grand-comprehensive-apa-report.docx")
RUNNING_HEAD = "AI2AI FOUR-EXPERIMENT COMPREHENSIVE PILOT REPORT"
TITLE = ("Delegating a Negotiation to Artificial Intelligence: A "
         "Comprehensive Four-Experiment Exploratory Analysis of the "
         "AI2AI Human Pilot")
BODY_FONT = "Times New Roman"
FIG_FONT = "DejaVu Sans"

# ── the four experiments (Mode × Role cells) ────────────────────────
EXPERIMENTS = {
    "X1": {"label": "X1 · Delegated · Buyer", "mode": "delegated",
           "role": "buyer", "mode2": "AI-to-AI"},
    "X2": {"label": "X2 · Delegated · Seller", "mode": "delegated",
           "role": "seller", "mode2": "AI-to-AI"},
    "X3": {"label": "X3 · Direct · Buyer", "mode": "direct",
           "role": "buyer", "mode2": "Human-to-AI"},
    "X4": {"label": "X4 · Direct · Seller", "mode": "direct",
           "role": "seller", "mode2": "Human-to-AI"},
}
EXP_ORDER = ["X1", "X2", "X3", "X4"]

# Okabe–Ito colourblind-safe base. Mode = hue family, Role = shade.
EXP_COLORS = {
    "X1": "#0072B2",  # delegated buyer  — deep blue
    "X2": "#56B4E9",  # delegated seller — light blue
    "X3": "#D55E00",  # direct buyer     — deep vermilion
    "X4": "#E69F00",  # direct seller    — amber
}
MODE_COLORS = {"delegated": "#0072B2", "direct": "#D55E00",
               "AI-to-AI": "#0072B2", "Human-to-AI": "#D55E00"}
ROLE_COLORS = {"buyer": "#0072B2", "seller": "#009E73"}
OUTCOME_COLORS = {"agreed": "#009E73", "rejected": "#D55E00",
                  "impasse": "#E69F00", "aborted": "#999999"}
LIKERT_DIVERGING = ["#D55E00", "#F0E442", "#0072B2"]  # 1 … 4 … 7
SEQUENTIAL = "viridis"


def exp_of(mode: str, role: str) -> str:
    for k, v in EXPERIMENTS.items():
        if v["mode"] == mode and v["role"] == role:
            return k
    return "?"


# ── matplotlib / seaborn theme ──────────────────────────────────────
def apply_theme() -> None:
    sns.set_theme(style="whitegrid", context="paper", rc={
        "figure.dpi": 150, "savefig.dpi": 300,
        "font.family": FIG_FONT,
        "font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold",
        "axes.labelsize": 9, "legend.fontsize": 8,
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.edgecolor": "#444444", "grid.color": "#DDDDDD",
        "grid.alpha": 0.5, "figure.facecolor": "white",
    })


def save(fig, name: str, *, w: float = 6.4, aspect: float = 0.6) -> Path:
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    fig.set_size_inches(w, w * aspect)
    fig.tight_layout()
    p = FIG_DIR / f"{name}.png"
    fig.savefig(p, bbox_inches="tight", dpi=300)
    plt.close(fig)
    return p


def save_external(fig_or_obj, name: str) -> Path:
    """For objects (great_tables / plotnine) that save themselves."""
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    return FIG_DIR / f"{name}.png"


# ── APA number formatting (one place) ───────────────────────────────
def _isnan(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def fmt_p(p) -> str:
    if _isnan(p):
        return "p = NA"
    if p < .001:
        return "p < .001"
    return f"p = {p:.3f}".replace("0.", ".")


def fmt_q(q) -> str:
    if _isnan(q):
        return "NA"
    return f"{q:.3f}".replace("0.", ".")


def fmt_d(x) -> str:
    """Bounded statistic (δ, r, η², α): no leading zero, U+2212 minus."""
    if _isnan(x):
        return "NA"
    s = f"{x:.2f}"
    return s.replace("-0.", "−.").replace("-", "−") if s.startswith("-") \
        else s.replace("0.", ".")


def fmt_num(x, nd: int = 2) -> str:
    if _isnan(x):
        return "NA"
    return f"{x:,.{nd}f}"


def fmt_ci(lo, hi, *, bounded: bool = True) -> str:
    f = fmt_d if bounded else (lambda v: fmt_num(v, 2))
    return f"[{f(lo)}, {f(hi)}]"


def fmt_pct(x, nd: int = 0) -> str:
    if _isnan(x):
        return "NA"
    return f"{100 * x:.{nd}f}%"


def stars(p) -> str:
    if _isnan(p):
        return ""
    return "***" if p < .001 else "**" if p < .01 else "*" if p < .05 \
        else "†" if p < .10 else ""
