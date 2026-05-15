"""Standalone figure suite for the process report — all 4 pillars.

Self-contained: only stdlib + matplotlib/plotnine + numpy/pandas + the
package's own db/extract/metrics. No imports from
scripts.analysis.human_pilot or scripts.analysis.core.

Own colourblind-safe Okabe-Ito palette, own matplotlib theme, own save
helpers. Every figure is titled, honest about the small N (points shown
where sensible), faceted/grouped by the 4 study cells. Deterministic.
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless, deterministic raster backend
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import plotnine as p9  # noqa: E402

from . import db, extract, metrics  # noqa: E402

# --------------------------------------------------------------------------- #
# Palette — Okabe-Ito (8 colours, colourblind-safe for deuteranopia,           #
# protanopia, tritanopia). https://jfly.uni-koeln.de/color/                    #
# --------------------------------------------------------------------------- #
PALETTE = {
    "black": "#000000",
    "orange": "#E69F00",
    "sky": "#56B4E9",
    "green": "#009E73",
    "yellow": "#F0E442",
    "blue": "#0072B2",
    "vermillion": "#D55E00",
    "purple": "#CC79A7",
    "grey": "#999999",
}

# Two-group splits
MODE2_COLORS = {"AI-to-AI": PALETTE["blue"], "Human-to-AI": PALETTE["orange"]}
ROLE_COLORS = {"buyer": PALETTE["sky"], "seller": PALETTE["vermillion"]}

# Four-cell split, keyed by the exact db.CELLS strings
CELL_COLORS = {
    db.CELLS[0]: PALETTE["blue"],        # AI-to-AI · buyer
    db.CELLS[1]: PALETTE["sky"],         # AI-to-AI · seller
    db.CELLS[2]: PALETTE["vermillion"],  # Human-to-AI · buyer
    db.CELLS[3]: PALETTE["orange"],      # Human-to-AI · seller
}

# 7-stop diverging sequence (blue -> grey -> vermillion), perceptually safe
SEQ = ["#0072B2", "#56B4E9", "#BFD8E8", "#999999",
       "#E8C39E", "#E69F00", "#D55E00"]

OUT = Path("docs/reports/figures-process")


def apply_theme() -> None:
    """Clean, readable matplotlib defaults — no chartjunk."""
    plt.rcParams.update({
        "figure.dpi": 150,
        "savefig.dpi": 150,
        "savefig.bbox": "tight",
        "font.size": 11,
        "font.family": "sans-serif",
        "axes.titlesize": 13,
        "axes.titleweight": "bold",
        "axes.labelsize": 11,
        "axes.edgecolor": "#444444",
        "axes.linewidth": 0.8,
        "axes.grid": True,
        "axes.axisbelow": True,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "grid.color": "#DDDDDD",
        "grid.linewidth": 0.6,
        "legend.frameon": False,
        "legend.fontsize": 10,
        "xtick.color": "#444444",
        "ytick.color": "#444444",
        "figure.facecolor": "white",
        "axes.facecolor": "white",
    })


apply_theme()


def save(fig, name: str, aspect: float = 0.6) -> Path:
    """Save a matplotlib figure as PNG (returned) + SVG into OUT."""
    OUT.mkdir(parents=True, exist_ok=True)
    w = fig.get_size_inches()[0]
    fig.set_size_inches(w, w * aspect)
    png = OUT / f"{name}.png"
    fig.savefig(png)
    fig.savefig(OUT / f"{name}.svg")
    plt.close(fig)
    return png


def save_plotnine(g, name: str, w: float = 9.0, h: float = 5.4) -> Path:
    """Save a plotnine ggplot as PNG (returned) + SVG into OUT."""
    OUT.mkdir(parents=True, exist_ok=True)
    png = OUT / f"{name}.png"
    g.save(png, width=w, height=h, dpi=150, verbose=False)
    g.save(OUT / f"{name}.svg", width=w, height=h, dpi=150, verbose=False)
    return png


# --------------------------------------------------------------------------- #
# Local helpers                                                                #
# --------------------------------------------------------------------------- #
def _cell_cat(s: pd.Series) -> pd.Series:
    """Order a cell column as an ordered categorical (stable facet order)."""
    return pd.Categorical(s, categories=db.CELLS, ordered=True)


def _box_jit(df: pd.DataFrame, cat_col: str, y: str,
             cats: list, jit: float = 0.16, seed: int = 42):
    """Box-with-points helper with *deterministic* jitter.

    plotnine's geom_jitter reseeds internally each call, so PNG bytes are
    not stable. We instead place categories on a numeric x and add a
    seeded uniform offset, then relabel the ticks with the category
    names. Returns (frame, xpos_map) ready for geom_boxplot/geom_point.
    """
    d = df[df[cat_col].isin(cats)].copy()
    d = d.dropna(subset=[y])
    xpos = {c: i + 1 for i, c in enumerate(cats)}
    d["_xc"] = d[cat_col].map(xpos).astype(float)
    rng = np.random.default_rng(seed)
    d["_xj"] = d["_xc"] + rng.uniform(-jit, jit, len(d))
    return d, xpos


def _cell_box(df: pd.DataFrame, y: str, title: str, ylab: str,
              cats: list | None = None):
    """A by-cell box-with-points ggplot with deterministic jitter and
    CELL_COLORS fill. Box grouped on the numeric cell position; points
    seeded-jittered; x ticks relabelled to the cell names."""
    cats = cats or [c for c in db.CELLS if c in set(df["cell"])]
    d, xpos = _box_jit(df, "cell", y, cats)
    return (
        p9.ggplot(d, p9.aes("_xc", y))
        + p9.geom_boxplot(p9.aes(group="_xc", fill="cell"),
                          alpha=0.55, outlier_alpha=0, width=0.6)
        + p9.geom_point(p9.aes("_xj", y), size=2.2, alpha=0.85,
                        color=PALETTE["black"])
        + p9.scale_fill_manual({k: CELL_COLORS[k] for k in cats})
        + p9.scale_x_continuous(breaks=list(xpos.values()),
                                labels=list(xpos.keys()),
                                limits=(0.4, len(cats) + 0.6))
        + p9.labs(title=title, x="", y=ylab)
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4), legend_position="none",
                   axis_text_x=p9.element_text(rotation=20, ha="right"))
    )


def _offer_path_frame(con) -> pd.DataFrame:
    """Long per-session price-by-turn frame for completer sessions.

    Reads `turns`, applies extract.parse_proposals, yields one row per
    priced proposal: [session_id, cell, turn_number, side, price].
    Settlement (last accepted price) per agreed session is flagged with
    is_settlement=True on the row carrying that price/turn.
    """
    base = db.completers(con)[["session_id", "cell"]]
    sids = set(base["session_id"])
    t = db.load(con, "turns",
                "session_id, turn_number, emitter_id, tool_calls_json")
    t = t[t["session_id"].isin(sids)].copy()
    t["turn_number"] = pd.to_numeric(t["turn_number"], errors="coerce")
    cell_by = dict(zip(base["session_id"], base["cell"]))

    rows = []
    settle = {}  # session_id -> (turn_number, price) of the accept
    for _, r in t.sort_values(["session_id", "turn_number"]).iterrows():
        sid = r["session_id"]
        for p in extract.parse_proposals(r["tool_calls_json"]):
            if p["price"] is None:
                continue
            rows.append({
                "session_id": sid,
                "cell": cell_by.get(sid),
                "turn_number": int(r["turn_number"]),
                "side": r["emitter_id"],
                "price": float(p["price"]),
            })
            if p["action"] == "accept":
                settle[sid] = (int(r["turn_number"]), float(p["price"]))

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["is_settlement"] = False
    for sid, (tn, pr) in settle.items():
        m = ((df["session_id"] == sid) & (df["turn_number"] == tn)
             & (np.isclose(df["price"], pr)))
        df.loc[m, "is_settlement"] = True
    return df.reset_index(drop=True)


def _events(con) -> pd.DataFrame:
    """Completer participant_events with parsed payload helpers."""
    base = db.completers(con)[["participant_id", "cell", "mode2", "role"]]
    pids = set(base["participant_id"])
    ev = db.load(con, "participant_events",
                 "participant_id, screen, event_type, payload_json")
    ev = ev[ev["participant_id"].isin(pids)].copy()
    return ev.merge(base, on="participant_id", how="left")


def _payload_num(s, key):
    try:
        v = (json.loads(s) if s else {}).get(key)
        return float(v) if v is not None else np.nan
    except Exception:
        return np.nan


# --------------------------------------------------------------------------- #
# §1  Bargaining                                                               #
# --------------------------------------------------------------------------- #
def fig_offer_paths(con) -> Path:
    df = _offer_path_frame(con)
    df = df.assign(cell=_cell_cat(df["cell"]))
    sett = df[df["is_settlement"]]
    g = (
        p9.ggplot(df, p9.aes("turn_number", "price", color="side"))
        + p9.geom_line(p9.aes(group="side"), alpha=0.55)
        + p9.geom_point(size=1.6, alpha=0.8)
        + p9.geom_point(data=sett, mapping=p9.aes("turn_number", "price"),
                        color=PALETTE["black"], shape="D", size=2.6,
                        inherit_aes=False)
        + p9.geom_hline(yintercept=metrics.ZOPA_LOW, linetype="dotted",
                        color=PALETTE["grey"])
        + p9.geom_hline(yintercept=metrics.ZOPA_HIGH, linetype="dotted",
                        color=PALETTE["grey"])
        + p9.facet_wrap("cell", scales="free_x")
        + p9.scale_color_manual({"buyer": ROLE_COLORS["buyer"],
                                 "seller": ROLE_COLORS["seller"]})
        + p9.labs(title="Offer paths by session (price per priced proposal; "
                  "settlement = black diamond; dotted = ZOPA 22.5k–23.5k)",
                  x="Turn number", y="Proposed price (USD)", color="Side")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 6), legend_position="top",
                   strip_background=p9.element_rect(fill="#EEEEEE"))
    )
    return save_plotnine(g, "fig_offer_paths", 9, 6)


def fig_concession_box(con) -> Path:
    bf = metrics.bargaining_frame(con).copy()
    bf = bf[bf["n_concessions"] > 0]
    g = _cell_box(bf, "mean_concession",
                  "Concession size by cell (mean own-side concession, "
                  "sessions with ≥1 concession; points = sessions)",
                  "Mean concession (USD)")
    return save_plotnine(g, "fig_concession_box", 9, 5.4)


def fig_surplus_split(con) -> Path:
    sf = metrics.surplus_frame(con)
    inz = sf[sf["pareto_efficient"]].copy()
    n_out = int((~sf["pareto_efficient"]).sum())
    g = (inz.groupby("cell")[["buyer_share_of_surplus"]]
         .mean().reset_index())
    g["seller_share_of_surplus"] = 1.0 - g["buyer_share_of_surplus"]
    n_by = inz.groupby("cell").size().to_dict()
    long = g.melt("cell", value_name="share", var_name="party")
    long["party"] = long["party"].map({
        "buyer_share_of_surplus": "buyer",
        "seller_share_of_surplus": "seller"})
    long["cell"] = pd.Categorical(
        long["cell"], categories=[c for c in db.CELLS if c in n_by],
        ordered=True)

    fig, ax = plt.subplots(figsize=(9, 5.4))
    cells = [c for c in db.CELLS if c in n_by]
    x = np.arange(len(cells))
    bb = [g.set_index("cell").loc[c, "buyer_share_of_surplus"]
          for c in cells]
    ss = [g.set_index("cell").loc[c, "seller_share_of_surplus"]
          for c in cells]
    ax.bar(x, bb, 0.6, label="buyer", color=ROLE_COLORS["buyer"])
    ax.bar(x, ss, 0.6, bottom=bb, label="seller",
           color=ROLE_COLORS["seller"])
    for i, c in enumerate(cells):
        ax.text(i, 1.02, f"n={n_by[c]}", ha="center", fontsize=9,
                color="#444444")
    ax.set_xticks(x)
    ax.set_xticklabels(cells, rotation=20, ha="right")
    ax.set_ylim(0, 1.12)
    ax.set_ylabel("Mean share of surplus")
    ax.set_title("Surplus split by cell (in-ZOPA deals only)")
    ax.legend(loc="lower right", ncol=2)
    ax.annotate(
        f"{n_out} out-of-ZOPA deal(s) excluded: one party has negative "
        f"surplus, so the share is undefined.",
        xy=(0.0, -0.30), xycoords="axes fraction", fontsize=8.5,
        color="#666666")
    return save(fig, "fig_surplus_split", aspect=0.6)


def fig_settlement_zopa(con) -> Path:
    sf = metrics.surplus_frame(con).copy()
    sf["zone"] = np.where(sf["pareto_efficient"], "in ZOPA", "out of ZOPA")
    # Numeric x position so the shaded ZOPA rect (continuous coords) is
    # accepted; ticks relabelled to the cell names below.
    xpos = {c: i + 1 for i, c in enumerate(db.CELLS)}
    sf["xc"] = sf["cell"].map(xpos).astype(float)
    rng = np.random.default_rng(42)
    sf["xj"] = sf["xc"] + rng.uniform(-0.16, 0.16, len(sf))
    g = (
        p9.ggplot(sf, p9.aes("xj", "settlement_price"))
        + p9.annotate("rect", xmin=0.4, xmax=len(db.CELLS) + 0.6,
                      ymin=metrics.ZOPA_LOW, ymax=metrics.ZOPA_HIGH,
                      alpha=0.12, fill=PALETTE["green"])
        + p9.geom_hline(yintercept=metrics.ZOPA_LOW, color=PALETTE["grey"],
                        linetype="dashed")
        + p9.geom_hline(yintercept=metrics.ZOPA_HIGH, color=PALETTE["grey"],
                        linetype="dashed")
        + p9.geom_hline(yintercept=metrics.ZOPA_MID, color=PALETTE["black"],
                        linetype="dotted")
        + p9.geom_point(p9.aes(color="zone"), size=2.6, alpha=0.85)
        + p9.scale_color_manual({"in ZOPA": PALETTE["green"],
                                 "out of ZOPA": PALETTE["vermillion"]})
        + p9.scale_x_continuous(breaks=list(xpos.values()),
                                labels=list(xpos.keys()),
                                limits=(0.4, len(db.CELLS) + 0.6))
        + p9.labs(title="Settlement prices vs ZOPA band "
                  "(shaded 22.5k–23.5k; dotted = midpoint 23k)",
                  x="", y="Settlement price (USD)", color="")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4), legend_position="top",
                   axis_text_x=p9.element_text(rotation=20, ha="right"))
    )
    return save_plotnine(g, "fig_settlement_zopa", 9, 5.4)


def fig_anchor_distance(con) -> Path:
    bf = metrics.bargaining_frame(con).copy()
    bf = bf.dropna(subset=["anchor_distance"])
    g = _cell_box(bf, "anchor_distance",
                  "Opening anchor distance by cell "
                  "(|own opening − own target|; points = sessions)",
                  "Anchor distance (USD)")
    return save_plotnine(g, "fig_anchor_distance", 9, 5.4)


# --------------------------------------------------------------------------- #
# §2  Tempo                                                                    #
# --------------------------------------------------------------------------- #
def fig_latency_emitter(con) -> Path:
    base = db.completers(con)[["session_id", "role"]]
    sids = set(base["session_id"])
    t = db.load(con, "turns", "session_id, emitter, latency_ms")
    t = t[t["session_id"].isin(sids)].merge(base, on="session_id",
                                            how="left")
    t["latency_s"] = pd.to_numeric(t["latency_ms"], errors="coerce") / 1000.0
    t = t.dropna(subset=["latency_s", "emitter"])
    t["grp"] = t["emitter"] + " · " + t["role"]
    order = ["human · buyer", "human · seller",
             "participant · buyer", "participant · seller"]
    t = t[t["grp"].isin(order)]
    xpos = {c: i + 1 for i, c in enumerate(order)}
    t["_xc"] = t["grp"].map(xpos).astype(float)
    rng = np.random.default_rng(42)
    t["_xj"] = t["_xc"] + rng.uniform(-0.16, 0.16, len(t))
    g = (
        p9.ggplot(t, p9.aes("_xc", "latency_s"))
        + p9.geom_boxplot(p9.aes(group="_xc", fill="emitter"),
                          alpha=0.55, outlier_alpha=0, width=0.6)
        + p9.geom_point(p9.aes("_xj", "latency_s"), size=1.3, alpha=0.4,
                        color=PALETTE["black"])
        + p9.scale_y_log10()
        + p9.scale_x_continuous(breaks=list(xpos.values()),
                                labels=list(xpos.keys()),
                                limits=(0.4, len(order) + 0.6))
        + p9.scale_fill_manual({"human": PALETTE["orange"],
                                "participant": PALETTE["blue"]})
        + p9.labs(title="Per-turn latency by emitter × role "
                  "(log scale; human = think+type, "
                  "participant = AI agent)",
                  x="", y="Latency (s, log10)", fill="Emitter")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4), legend_position="top",
                   axis_text_x=p9.element_text(rotation=20, ha="right"))
    )
    return save_plotnine(g, "fig_latency_emitter", 9, 5.4)


def fig_latency_arc(con) -> Path:
    base = db.completers(con)[["session_id", "mode2"]]
    sids = set(base["session_id"])
    t = db.load(con, "turns", "session_id, turn_number, latency_ms")
    t = t[t["session_id"].isin(sids)].merge(base, on="session_id",
                                            how="left")
    t["turn_number"] = pd.to_numeric(t["turn_number"], errors="coerce")
    t["latency_s"] = pd.to_numeric(t["latency_ms"], errors="coerce") / 1000.0
    t = t.dropna(subset=["turn_number", "latency_s", "mode2"])
    t = t[t["turn_number"] <= 16]
    arc = (t.groupby(["mode2", "turn_number"])["latency_s"]
           .median().reset_index())
    g = (
        p9.ggplot(arc, p9.aes("turn_number", "latency_s", color="mode2"))
        + p9.geom_line(size=1.0)
        + p9.geom_point(size=2.2)
        + p9.scale_color_manual(MODE2_COLORS)
        + p9.labs(title="Latency arc — median per-turn latency by "
                  "turn number",
                  x="Turn number", y="Median latency (s)", color="Mode")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4), legend_position="top")
    )
    return save_plotnine(g, "fig_latency_arc", 9, 5.4)


def fig_tokens_cell(con) -> Path:
    tf = metrics.tempo_frame(con).copy()
    tf = tf.dropna(subset=["tokens_total"])
    mean_share = float(tf["orch_token_share"].mean())
    g = _cell_box(tf, "tokens_total",
                  "Total tokens per session by cell "
                  f"(mean orchestrator share = {mean_share:.0%}; "
                  "points = sessions)",
                  "Total tokens")
    return save_plotnine(g, "fig_tokens_cell", 9, 5.4)


# --------------------------------------------------------------------------- #
# §3  Orchestrator                                                             #
# --------------------------------------------------------------------------- #
def fig_routing(con) -> Path:
    of = metrics.orchestrator_frame(con).copy()
    of = of.dropna(subset=["alternation_rate"])
    g = _cell_box(of, "alternation_rate",
                  "Orchestrator routing alternation by cell "
                  "(share of turn handoffs that switch side)",
                  "Alternation rate")
    return save_plotnine(g, "fig_routing", 9, 5.4)


def fig_declare_timing(con) -> Path:
    of = metrics.orchestrator_frame(con).copy()
    of = of.dropna(subset=["declare_turn"])
    g = _cell_box(of, "declare_turn",
                  "Outcome-declaration timing by cell "
                  "(turn number at declare_outcome; points = sessions)",
                  "Declare turn number")
    return save_plotnine(g, "fig_declare_timing", 9, 5.4)


# --------------------------------------------------------------------------- #
# §4  UX                                                                       #
# --------------------------------------------------------------------------- #
def fig_screen_dwell(con) -> Path:
    ev = _events(con)
    se = ev[ev["event_type"] == "screen_exit"].copy()
    se["dwell_s"] = se["payload_json"].map(
        lambda s: _payload_num(s, "dwellMs")) / 1000.0
    se = se.dropna(subset=["dwell_s", "screen"])
    se["screen"] = se["screen"].astype(int)
    agg = (se.groupby("screen")["dwell_s"]
           .mean().reset_index().sort_values("screen"))
    agg["screen_lbl"] = "Screen " + agg["screen"].astype(str)
    agg["screen_lbl"] = pd.Categorical(
        agg["screen_lbl"], categories=list(agg["screen_lbl"]), ordered=True)
    g = (
        p9.ggplot(agg, p9.aes("screen_lbl", "dwell_s"))
        + p9.geom_col(fill=PALETTE["blue"], alpha=0.85, width=0.7)
        + p9.geom_text(p9.aes(label="round(dwell_s, 1)"), va="bottom",
                       size=8, nudge_y=0.5)
        + p9.labs(title="Mean dwell time per study screen "
                  "(screen_exit.dwellMs, completers)",
                  x="", y="Mean dwell (s)")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4),
                   axis_text_x=p9.element_text(rotation=30, ha="right"))
    )
    return save_plotnine(g, "fig_screen_dwell", 9, 5.4)


def fig_engine_dwell(con) -> Path:
    ux = metrics.ux_frame(con).copy()
    g = _cell_box(ux, "engine_dwell_s",
                  "Time on the live-negotiation screen by cell "
                  "(engine dwell; points = participants)",
                  "Engine dwell (s)")
    return save_plotnine(g, "fig_engine_dwell", 9, 5.4)


def fig_attention(con) -> Path:
    ux = metrics.ux_frame(con)
    m = (ux.groupby("cell")[["total_idle_s", "n_tab_away"]]
         .mean().reset_index())
    cells = [c for c in db.CELLS if c in set(m["cell"])]
    mi = m.set_index("cell")
    fig, ax1 = plt.subplots(figsize=(9, 5.4))
    x = np.arange(len(cells))
    w = 0.36
    ax1.bar(x - w / 2, [mi.loc[c, "total_idle_s"] for c in cells], w,
            label="mean idle (s)", color=PALETTE["vermillion"], alpha=0.85)
    ax1.set_ylabel("Mean total idle (s)", color=PALETTE["vermillion"])
    ax1.tick_params(axis="y", colors=PALETTE["vermillion"])
    ax2 = ax1.twinx()
    ax2.bar(x + w / 2, [mi.loc[c, "n_tab_away"] for c in cells], w,
            label="mean tab-aways", color=PALETTE["blue"], alpha=0.85)
    ax2.set_ylabel("Mean tab-aways", color=PALETTE["blue"])
    ax2.tick_params(axis="y", colors=PALETTE["blue"])
    ax2.grid(False)
    ax1.set_xticks(x)
    ax1.set_xticklabels(cells, rotation=20, ha="right")
    ax1.set_title("Attention drift by cell (mean idle time & tab-aways)")
    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, loc="upper right")
    return save(fig, "fig_attention", aspect=0.6)


def fig_listing_engagement(con) -> Path:
    ux = metrics.ux_frame(con)
    m = (ux.groupby("cell")[["n_thumbnail_views", "n_zoom_opens"]]
         .mean().reset_index())
    long = m.melt("cell", var_name="kind", value_name="mean_count")
    long["kind"] = long["kind"].map({
        "n_thumbnail_views": "thumbnail views",
        "n_zoom_opens": "zoom opens"})
    long["cell"] = pd.Categorical(
        long["cell"], categories=[c for c in db.CELLS
                                  if c in set(m["cell"])], ordered=True)
    g = (
        p9.ggplot(long, p9.aes("cell", "mean_count", fill="kind"))
        + p9.geom_col(position="dodge", width=0.7, alpha=0.9)
        + p9.scale_fill_manual({"thumbnail views": PALETTE["sky"],
                                "zoom opens": PALETTE["purple"]})
        + p9.labs(title="Listing engagement by cell "
                  "(mean thumbnail views & zoom opens per participant)",
                  x="", y="Mean count", fill="")
        + p9.theme_bw()
        + p9.theme(figure_size=(9, 5.4), legend_position="top",
                   axis_text_x=p9.element_text(rotation=20, ha="right"))
    )
    return save_plotnine(g, "fig_listing_engagement", 9, 5.4)


def fig_human_cadence(con) -> Path:
    hc = metrics.human_cadence(con)
    m = (hc.groupby("role")[["mean_compose_s", "mean_charcount"]]
         .mean().reset_index())
    roles = [r for r in ["buyer", "seller"] if r in set(m["role"])]
    mi = m.set_index("role")
    fig, ax1 = plt.subplots(figsize=(9, 5.4))
    x = np.arange(len(roles))
    w = 0.36
    ax1.bar(x - w / 2, [mi.loc[r, "mean_compose_s"] for r in roles], w,
            label="mean compose (s)", color=PALETTE["green"], alpha=0.85)
    ax1.set_ylabel("Mean compose time (s)", color=PALETTE["green"])
    ax1.tick_params(axis="y", colors=PALETTE["green"])
    ax2 = ax1.twinx()
    ax2.bar(x + w / 2, [mi.loc[r, "mean_charcount"] for r in roles], w,
            label="mean char count", color=PALETTE["orange"], alpha=0.85)
    ax2.set_ylabel("Mean char count", color=PALETTE["orange"])
    ax2.tick_params(axis="y", colors=PALETTE["orange"])
    ax2.grid(False)
    ax1.set_xticks(x)
    ax1.set_xticklabels([r.capitalize() for r in roles])
    ax1.set_title("Human composition cadence by role "
                  "(Human-to-AI participants only)")
    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, loc="upper right")
    return save(fig, "fig_human_cadence", aspect=0.6)


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #
ALL_FIGURES: list = [
    # §1 Bargaining
    ("fig_offer_paths", fig_offer_paths),
    ("fig_concession_box", fig_concession_box),
    ("fig_surplus_split", fig_surplus_split),
    ("fig_settlement_zopa", fig_settlement_zopa),
    ("fig_anchor_distance", fig_anchor_distance),
    # §2 Tempo
    ("fig_latency_emitter", fig_latency_emitter),
    ("fig_latency_arc", fig_latency_arc),
    ("fig_tokens_cell", fig_tokens_cell),
    # §3 Orchestrator
    ("fig_routing", fig_routing),
    ("fig_declare_timing", fig_declare_timing),
    # §4 UX
    ("fig_screen_dwell", fig_screen_dwell),
    ("fig_engine_dwell", fig_engine_dwell),
    ("fig_attention", fig_attention),
    ("fig_listing_engagement", fig_listing_engagement),
    ("fig_human_cadence", fig_human_cadence),
]
