"""Single orchestrator → one coherent APA-7 .docx.

Run: python -m scripts.analysis.grand_report.report

Part I  Foundations
Part II  The Four Experiments — one by one (L1, distinct)
Part III The Forty-Five Analyses — each with L1/L2(2×2+pairwise)/L3/L4
Part IV  Cross-Experiment Synthesis, Robustness & Confirmatory Roadmap
+ References, Appendices (data dictionary, verbatim, exports, methods)

Deterministic, offline, self-contained (only this package).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from . import apa as A
from . import db
from . import figures as F
from . import metrics as M
from . import narrative as N
from . import tables as TB
from .design import (EXP_ORDER, EXPERIMENTS, OUT, RUNNING_HEAD, TITLE,
                      TBL_DIR, fmt_d, fmt_p)
from .framework import multi_quad, quad_binary, quad_continuous


def _csv(df, name):
    TBL_DIR.mkdir(parents=True, exist_ok=True)
    try:
        df.to_csv(TBL_DIR / f"{name}.csv", index=False)
    except Exception:
        pass


def _t(doc, df, title, note=None, *, csv=None):
    if csv:
        _csv(df, csv)
    A.table(doc, TB.prep(df), title, note)


def _headline(con):
    g01 = M.g01(con)["tables"]["Funnel"]
    n = int(g01.loc[g01.Stage.str.startswith("Completed"), "n"].iloc[0])
    na = int(g01.loc[g01.Stage == "Reached agreement", "n"].iloc[0])
    econ = M.g_econ(con)["tables"]["Economic summary"]
    inz = econ.loc[econ.Metric == "Within ZOPA", "Value"].iloc[0]
    w = db.survey_wide(con)
    q = quad_continuous(w.rename(columns={}), "satisfaction") \
        if "satisfaction" in w else None
    mm = q["raw"]["mw_mode"]
    return {"n": n, "n_agreed": na, "inzopa": inz,
            "sat_p": mm["p"], "sat_d": mm["delta"], "sat_band": mm["band"]}


def _experiment_dossier(con):
    """Part II — the same metric battery for each experiment, side by
    side (distinct one-by-one + directly comparable)."""
    c = db.completers(con)
    w = db.survey_wide(con)
    instr = M._instr(con)
    bg = M._bargain(con)
    rows = {}
    for x in EXP_ORDER:
        cx = c[c["exp"] == x]
        wx = w[w["exp"] == x]
        ix = instr[instr["exp"] == x]
        bx = bg[bg["exp"] == x]
        ap = cx.loc[cx["outcome_type"] == "agreed", "settlement_price"]
        rows[x] = {
            "n": len(cx),
            "Agreement rate": f"{cx['agreed'].mean():.0%}",
            "Settlement Mdn (USD)": (f"{ap.median():.0f}"
                                     if len(ap) else "—"),
            "Satisfaction M": f"{pd.to_numeric(wx['satisfaction'],errors='coerce').mean():.2f}",
            "Would-use-again M": f"{pd.to_numeric(wx['would_use_again'],errors='coerce').mean():.2f}",
            "Perceived control M": f"{pd.to_numeric(wx['control'],errors='coerce').mean():.2f}",
            "Anxious affect M": f"{pd.to_numeric(wx['emot_anxious'],errors='coerce').mean():.2f}",
            "Outcome fairness M": f"{pd.to_numeric(wx['outfair_share'],errors='coerce').mean():.2f}",
            "Turns Mdn": f"{pd.to_numeric(cx['turns_consumed'],errors='coerce').median():.0f}",
            "Active time Mdn (s)": f"{ix['active_s'].median():.0f}",
            "Concessions Mdn": f"{bx['n_concessions'].median():.0f}",
            "Anchor dist Mdn": f"{bx['anchor_distance'].median():.0f}",
        }
    df = pd.DataFrame(rows).reset_index(names="Metric")
    return df


def build(snapshot=db.SNAPSHOT, out: Path = OUT) -> dict:
    M.clear_cache()
    con = db.connect(snapshot)
    db.verify_reservations(con)
    hd = _headline(con)
    doc = A.new_doc(RUNNING_HEAD)

    # ── front matter ──
    A.title_page(
        doc, title=TITLE, author="Faraz Ghodratizadeh",
        affiliation="ESSEC Business School",
        course="AI2AI Negotiation Platform — Comprehensive Pilot Report",
        note=[
            "Conducted at ESSEC Business School under the supervision of "
            "Amir Sepehri (ESSEC Business School).",
            "Comprehensive exploratory analysis of the first human pilot. "
            + N.HONESTY,
            "Correspondence: Faraz Ghodratizadeh, ESSEC Business School "
            "(b00833647@essec.edu).",
        ])
    A.abstract_page(doc, N.abstract_text(hd),
                     ["human–AI negotiation", "delegation",
                      "automated negotiation", "algorithm aversion",
                      "four-experiment design", "exploratory pilot"])
    A.front_lists(doc)

    # ── Part I — Foundations ──
    A.h1(doc, "Part I — Foundations")
    A.h2(doc, "Data Provenance")
    A.body(doc, "The analysed database is the frozen snapshot "
                "data/ai2ai-human-pilot-2026-05-15.db. Reservation "
                "values were verified uniform from every session's "
                "scenario pack. Two base tables (outcomes, scores) are "
                "empty and cannot be analysed.")
    _t(doc, M.g01(con)["tables"]["Funnel"], "Participant Flow",
       csv="p1_flow")
    A.h2(doc, "The Four-Experiment Framework")
    fw = pd.DataFrame([{"Experiment": k, "Label": v["label"],
                        "Mode": v["mode"], "Role": v["role"],
                        "n": 10} for k, v in EXPERIMENTS.items()])
    _t(doc, fw, "The Four Experiments (Mode × Role cells)",
       "Every applicable analysis is reported one-by-one (each "
       "experiment), as a 2×2 factorial with structured pairwise "
       "contrasts, pooled overall, and an integrative review.",
       csv="p1_framework")
    A.h2(doc, "Methodology")
    for k, v in N.method(con).items():
        A.h3(doc, k)
        A.body(doc, v)
    A.h2(doc, "Honesty & Limitations Charter")
    A.body(doc, N.HONESTY, italic=True)
    A.page_break(doc)

    # ── Part II — The Four Experiments, one by one ──
    A.h1(doc, "Part II — The Four Experiments (One by One)")
    A.body(doc, "Each experiment receives the identical metric battery "
                "below, presented side-by-side so X1–X4 are directly "
                "comparable. This is the ‘distinct / one-by-one’ lens; "
                "factorial, pooled, and review lenses follow in Parts "
                "III–IV.")
    _t(doc, _experiment_dossier(con),
       "Standardised Experiment Dossier (X1–X4, side by side)",
       "Per-experiment battery; n = 10 each, so values are descriptive.",
       csv="p2_dossier")
    A.figure(doc, F.fig_outcomes(con),
             "Outcome type by experiment.", None)
    A.figure(doc, F.fig_survey_panel(con),
             "Each subjective measure by experiment.", None)
    A.figure(doc, F.fig_offer_paths(con),
             "Offer trajectories by experiment (ZOPA shaded).",
             "One line per session; price vs turn.")
    A.page_break(doc)

    # ── Part III — The Forty-Five Analyses ──
    A.h1(doc, "Part III — The Forty-Five Analyses")
    A.body(doc, "Each analysis group is reported at all four levels: L1 "
                "distinct (per experiment), L2 2×2 + pairwise, L3 "
                "overall, L4 review. Effect sizes and intervals carry "
                "the interpretation; p-values are exploratory.")
    cur_ch = None
    for fn in M.GROUPS:
        r = fn(con)
        if r["chapter"] != cur_ch:
            cur_ch = r["chapter"]
            A.h2(doc, f"Chapter {cur_ch}. {M.CHAPTERS[cur_ch]}")
        A.h3(doc, f"{r['id']} · {r['title']}")
        for nt in r["notes"]:
            A.body(doc, nt, italic=True)
        for tname, tdf in r["tables"].items():
            _t(doc, tdf, f"{r['id']} — {tname}",
               csv=f"{r['id']}_{tname[:20].replace(' ','_')}")
        pf = r["participant"]
        if pf is not None and r["value_cols"]:
            mq = multi_quad(pf, r["value_cols"])
            _t(doc, mq["l1"], f"{r['id']} — L1 Distinct (mean per "
               f"experiment)", csv=f"{r['id']}_L1")
            _t(doc, mq["l2"], f"{r['id']} — L2 2×2 + Pairwise "
               f"(Mode/Role/Mode×Role; best pairwise)",
               "Mode/Role via Mann–Whitney + Cliff's δ (95% bootstrap "
               "CI); Mode×Role and opponent via SRH/Kruskal–Wallis.",
               csv=f"{r['id']}_L2")
            _t(doc, mq["l3"], f"{r['id']} — L3 Overall (pooled / Mode / "
               f"Role)", csv=f"{r['id']}_L3")
            focal = r["value_cols"][0]
            qf = quad_continuous(pf, focal)
            _t(doc, qf["l2_pairwise"],
               f"{r['id']} — Pairwise detail: {focal}",
               "Six structured contrasts among X1–X4; q = BH-adjusted.",
               csv=f"{r['id']}_pairwise_{focal[:14]}")
            A.figure(doc, F.fig_distribution(
                pf, focal, f"{r['id']}_dist",
                f"{r['id']}: {focal} by experiment"),
                f"{r['id']}: distribution of {focal} across X1–X4.")
            try:
                A.figure(doc, F.fig_interaction(
                    pf, focal, f"{r['id']}_int",
                    f"{r['id']}: {focal} Mode×Role"),
                    f"{r['id']}: {focal} Mode×Role interaction.")
            except Exception:
                pass
            A.body(doc, "L4 review. " + N.group_review(r["title"],
                                                       mq["raw"]))
        elif pf is not None and r["binary_cols"]:
            qb = quad_binary(pf, r["binary_cols"][0])
            _t(doc, qb["l1"], f"{r['id']} — L1 Distinct (rate per "
               f"experiment)", csv=f"{r['id']}_L1b")
            _t(doc, qb["l2_factorial"], f"{r['id']} — L2 2×2 "
               f"(Fisher/χ²)", csv=f"{r['id']}_L2b")
            _t(doc, qb["l2_pairwise"], f"{r['id']} — Pairwise (Fisher, "
               f"BH)", csv=f"{r['id']}_L2bp")
            _t(doc, qb["l3"], f"{r['id']} — L3 Overall",
               csv=f"{r['id']}_L3b")
            A.body(doc, "L4 review. Binary outcome; exploratory at "
                        "n = 10 per experiment — interpret rates "
                        "descriptively.")
        else:
            A.body(doc, "L4 review. " + N.group_review(r["title"], {}))
    A.page_break(doc)

    # ── Part IV — Synthesis ──
    A.h1(doc, "Part IV — Cross-Experiment Synthesis, Robustness & "
              "Confirmatory Roadmap")
    A.figure(doc, F.fig_survey_heatmap(con),
             "Nine measures × four experiments (means).", None)
    A.figure(doc, F.fig_affect(con),
             "Affect space (pleasant × anxious) by experiment.", None)
    A.figure(doc, F.fig_engagement(con),
             "Engagement instrumentation by experiment.", None)
    for k, v in N.discussion(hd).items():
        A.h2(doc, k)
        A.body(doc, v)
    A.page_break(doc)

    # ── References ──
    A.references(doc, N.REFERENCES)
    A.page_break(doc)

    # ── Appendices ──
    A.h1(doc, "Appendix A — Data Dictionary & Database Profile")
    _t(doc, M.data_dictionary(), "Data Dictionary and Caveats",
       csv="A_dictionary")
    prof = []
    for nm in [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name "
            "NOT LIKE 'sqlite_%' ORDER BY name")]:
        prof.append({"Table": nm, "Rows": con.execute(
            f"SELECT COUNT(*) FROM [{nm}]").fetchone()[0]})
    _t(doc, pd.DataFrame(prof), "Base-Table Row Counts", csv="A_profile")
    A.page_break(doc)
    A.h1(doc, "Appendix B — Verbatim Open-Text")
    _t(doc, M.g10(con)["tables"]["Verbatim (anonymised)"],
       "Anonymised Verbatim Entries", "Deterministic; no LLM coding.",
       csv="B_verbatim")
    A.page_break(doc)
    A.h1(doc, "Appendix C — Reproducibility & Exported Tables")
    A.body(doc, "Every table is exported as CSV under "
                "docs/reports/tables-grand/. The document rebuilds "
                "deterministically via "
                "python -m scripts.analysis.grand_report.report. Stack: "
                "pandas, scipy (bootstrap/permutation), pingouin "
                "(Bayesian/TOST), statsmodels, scikit-posthocs, "
                "lifelines, scikit-learn, textstat; figures via "
                "matplotlib/seaborn on one shared theme.", indent=False)

    Path(out).parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    con.close()
    res = {"out": str(out), "bytes": Path(out).stat().st_size,
           "tables": len(doc.tables), "n": hd["n"],
           "n_agreed": hd["n_agreed"], "groups": len(M.GROUPS)}
    print(res)
    return res


if __name__ == "__main__":  # pragma: no cover
    build()
