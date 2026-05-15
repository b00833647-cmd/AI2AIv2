"""Shared figure infrastructure: Word-friendly sizing, dual png+svg save,
and consistent matplotlib/seaborn + plotnine themes."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

OUT_DIR = Path("docs/reports/figures-human-pilot")
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
