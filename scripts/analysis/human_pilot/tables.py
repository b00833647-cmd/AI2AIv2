"""Every report table as a DataFrame. CSVs written by report.py."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scripts.analysis.human_pilot.data import (
    completers_frame, survey_long, behavior_prompts_frame, events_frame,
    V2_SURVEY_KEYS,
)
from scripts.analysis.human_pilot.stats_ext import (
    fisher_2x2, cliff_delta, fdr_bh, mann_whitney,
)


def sample_composition(con) -> pd.DataFrame:
    df = completers_frame(con)
    t = (df.groupby(["experiment_mode", "role", "opponent_personality"])
            .size().reset_index(name="n")
            .sort_values(["experiment_mode", "role", "opponent_personality"]))
    return t.reset_index(drop=True)


def demographics_summary(con) -> pd.DataFrame:
    df = completers_frame(con)
    rows = []
    for var in ["gender", "experience", "ai_familiarity"]:
        vc = df[var].value_counts(dropna=True)
        for level, n in vc.items():
            rows.append({"variable": var, "level": str(level),
                         "n": int(n), "pct": round(100 * n / len(df), 1)})
    age = df["age"].dropna()
    rows.append({"variable": "age", "level": "mean (SD)",
                 "n": int(len(age)),
                 "pct": f"{age.mean():.1f} ({age.std():.1f})"})
    return pd.DataFrame(rows)


def outcome_descriptives(con) -> pd.DataFrame:
    df = completers_frame(con)
    rows = []
    for (mode, role), g in df.groupby(["experiment_mode", "role"]):
        agreed = g[g["outcome_type"] == "agreed"]
        price = agreed["final_price"].dropna()
        turns = g["turns_count"].dropna()
        secs = g["session_time_sec"].dropna()
        rows.append({
            "experiment_mode": mode, "role": role, "n": len(g),
            "agreement_rate": round((g["outcome_type"] == "agreed").mean(), 3),
            "price_median": float(price.median()) if len(price) else np.nan,
            "price_iqr": (f"{price.quantile(.25):.0f}-{price.quantile(.75):.0f}"
                          if len(price) else "—"),
            "turns_median": float(turns.median()) if len(turns) else np.nan,
            "time_median_s": float(secs.median()) if len(secs) else np.nan,
        })
    return pd.DataFrame(rows)


def dv_group_descriptives(con) -> pd.DataFrame:
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    prio = set(V2_SURVEY_KEYS[:4])
    order = {k: i for i, k in enumerate(V2_SURVEY_KEYS)}
    rows = []
    for dv in V2_SURVEY_KEYS:
        sub = s[s["key"] == dv]
        for (m2, role), g in sub.groupby(["mode2", "role"]):
            v = g["value_int"]
            rows.append({
                "dv": dv, "priority": dv in prio, "mode2": m2, "role": role,
                "n": int(len(v)), "M": round(float(v.mean()), 2),
                "SD": round(float(v.std()), 2), "Mdn": float(v.median()),
                "IQR": f"{v.quantile(.25):.0f}-{v.quantile(.75):.0f}",
            })
    df = pd.DataFrame(rows)
    df["_o"] = df["dv"].map(order)
    return (df.sort_values(["_o", "mode2", "role"])
              .drop(columns="_o").reset_index(drop=True))


def srh_results(con) -> pd.DataFrame:
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    prio = set(V2_SURVEY_KEYS[:4])
    out = []
    for dv in V2_SURVEY_KEYS:
        r = scheirer_ray_hare(s[s["key"] == dv], "value_int", "mode2", "role")
        out.append({
            "dv": dv, "priority": dv in prio,
            "mode_H": round(r["A"]["H"], 3), "mode_p": round(r["A"]["p"], 4),
            "mode_eta2": round(r["A"]["eta2"], 3),
            "role_H": round(r["B"]["H"], 3), "role_p": round(r["B"]["p"], 4),
            "role_eta2": round(r["B"]["eta2"], 3),
            "inter_H": round(r["AB"]["H"], 3), "inter_p": round(r["AB"]["p"], 4),
            "inter_eta2": round(r["AB"]["eta2"], 3), "N": r["N"],
        })
    return pd.DataFrame(out)


def agreement_2x2(con) -> dict:
    df = completers_frame(con)

    def _f(col, la, lb):
        ga = df[df[col] == la]
        gb = df[df[col] == lb]
        return fisher_2x2(
            success_a=int((ga["outcome_type"] == "agreed").sum()), n_a=len(ga),
            success_b=int((gb["outcome_type"] == "agreed").sum()), n_b=len(gb))

    return {"by_mode": _f("mode2", "AI-to-AI", "Human-to-AI"),
            "by_role": _f("role", "buyer", "seller")}


def data_quality(con) -> pd.DataFrame:
    ev = events_frame(con)
    flags = ev[ev["event_type"].isin(
        ["paste", "copy_attempt", "cut_attempt", "rightclick_attempt"])]
    by_pid = flags.groupby("participant_id").size()
    bp = behavior_prompts_frame(con)
    return pd.DataFrame([
        {"metric": "participants with any clipboard/right-click attempt",
         "value": int(by_pid.shape[0])},
        {"metric": "total clipboard/right-click events",
         "value": int(len(flags))},
        {"metric": "behavior prompts (agent modes)",
         "value": int(len(bp))},
        {"metric": "behavior prompt length median (chars)",
         "value": int(bp["prompt_len"].median()) if len(bp) else 0},
    ])


def variable_inventory(con) -> pd.DataFrame:
    return pd.DataFrame([
        {"variable": "experiment_mode (mode2)", "n": 40,
         "now": "descriptive + per-DV SRH 2×2 (exploratory)",
         "when_n_grows": "powered mode contrast"},
        {"variable": "role", "n": 40,
         "now": "descriptive + per-DV SRH 2×2 (exploratory)",
         "when_n_grows": "powered role contrast"},
        {"variable": "opponent_personality", "n": 40,
         "now": "descriptive only (≈13/level)",
         "when_n_grows": "3-group KW"},
        {"variable": "final_price", "n": 27,
         "now": "descriptive (agreed only)",
         "when_n_grows": "price modelling"},
        {"variable": "9 survey DVs", "n": 40,
         "now": "rainclouds + per-DV SRH 2×2 by 4 cells (exploratory)",
         "when_n_grows": "powered DV tests + subscales"},
        {"variable": "mode × role × personality", "n": 40,
         "now": "NOT analysable (cells 2-4)",
         "when_n_grows": "3-way once ≥~15/cell"},
    ])


# ─── Section 8 — qualitative ──────────────────────────────────────────
import json as _json
from pathlib import Path as _Path

from scripts.analysis.human_pilot.qual_codebook import (
    THEME_FLAGS as _THEMES, TAXONOMY as _TAX, CODER_RUN_DATE as _QDATE,
)
from scripts.analysis.human_pilot.linguistic import human_turn_features as _htf

_QCACHE = _Path(f"data/qual-codes-{_QDATE}.json")


def qual_cache_available() -> bool:
    return _QCACHE.exists()


def _qual_rows(kind: str):
    if not _QCACHE.exists():
        return []
    data = _json.loads(_QCACHE.read_text())
    return [r for r in data.get("rows", []) if r.get("kind") == kind]


def theme_prevalence(con) -> pd.DataFrame:
    rows = _qual_rows("prompt")
    n = len(rows) or 1
    out = []
    for th in _THEMES:
        k = sum(1 for r in rows if r.get(th) is True)
        out.append({"theme": th, "n": k, "pct": round(100 * k / n, 1)})
    return pd.DataFrame(out).sort_values("n", ascending=False).reset_index(drop=True)


def taxonomy_by_role(con) -> pd.DataFrame:
    rows = _qual_rows("prompt")
    out = []
    for dim, levels in _TAX.items():
        for lvl in levels:
            for role in ("buyer", "seller"):
                k = sum(1 for r in rows
                        if r.get("role") == role and r.get(dim) == lvl)
                out.append({"dimension": dim, "level": lvl,
                            "role": role, "n": k})
    return pd.DataFrame(out)


def comment_sentiment(con) -> pd.DataFrame:
    rows = _qual_rows("comment")
    if not rows:
        return pd.DataFrame(columns=["valence", "topic", "n"])
    df = pd.DataFrame(rows)
    return (df.groupby(["valence", "topic"]).size()
              .reset_index(name="n"))


def linguistic_by_role(con) -> pd.DataFrame:
    f = _htf(con)
    g = f.groupby("role").agg(
        n=("char_len", "size"),
        char_len_med=("char_len", "median"),
        politeness_mean=("politeness", "mean"),
        hedges_mean=("hedges", "mean"),
        questions_mean=("questions", "mean"),
        concession_mean=("concession", "mean"),
        directness_mean=("directness", "mean"),
    ).round(2).reset_index()
    return g


def qual_quant_link(con) -> pd.DataFrame:
    """8E — agreed price (agent modes) by taxonomy orientation + satisfaction
    by comment sentiment. Descriptive medians, illustrative only."""
    rows_p = _qual_rows("prompt")
    out = []
    if rows_p:
        df = completers_frame(con)
        agreed = df[df["outcome_type"] == "agreed"][["participant_id", "final_price"]]
        codes = pd.DataFrame(rows_p)[["participant_id", "orientation"]]
        m = codes.merge(agreed, on="participant_id", how="inner")
        for ori, g in m.groupby("orientation"):
            out.append({"link": "price~orientation", "group": ori,
                        "n": len(g),
                        "value_median": float(g["final_price"].median())
                        if len(g) else None})
    rows_c = _qual_rows("comment")
    if rows_c:
        s = survey_long(con)
        sat = s[(s["key"] == "satisfaction") & s["value_int"].notna()][
            ["participant_id", "value_int"]]
        cc = pd.DataFrame(rows_c)[["participant_id", "valence"]]
        m = cc.merge(sat, on="participant_id", how="inner")
        for val, g in m.groupby("valence"):
            out.append({"link": "satisfaction~comment_sentiment",
                        "group": val, "n": len(g),
                        "value_median": float(g["value_int"].median())
                        if len(g) else None})
    return pd.DataFrame(out)
