"""Every report table as a DataFrame. CSVs written by report.py."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scripts.analysis.human_pilot.data import (
    completers_frame, survey_long, behavior_prompts_frame, events_frame,
    V2_SURVEY_KEYS,
)
from scripts.analysis.human_pilot.stats_ext import (
    fisher_2x2, cliff_delta, bootstrap_ci, fdr_bh, mann_whitney,
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


def survey_descriptives(con) -> pd.DataFrame:
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()]
    rows = []
    for (item, mode2), g in s.groupby(["key", "mode2"]):
        v = g["value_int"].astype(float)
        rows.append({
            "item": item, "mode2": mode2, "n": len(v),
            "M": round(v.mean(), 2), "SD": round(v.std(), 2),
            "Mdn": float(v.median()),
            "IQR": f"{v.quantile(.25):.0f}-{v.quantile(.75):.0f}",
        })
    return pd.DataFrame(rows).sort_values(["item", "mode2"]).reset_index(drop=True)


def _two_group_survey(con, group_col: str, a_label, b_label) -> pd.DataFrame:
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    out = []
    for item in V2_SURVEY_KEYS:
        sub = s[s["key"] == item]
        a = sub[sub[group_col] == a_label]["value_int"].astype(float).tolist()
        b = sub[sub[group_col] == b_label]["value_int"].astype(float).tolist()
        if len(a) < 3 or len(b) < 3:
            continue
        d = cliff_delta(a, b)
        lo, hi = bootstrap_ci(
            np.array([1] * len(a) + [0] * len(b)),
            statistic=lambda x: cliff_delta(
                list(np.array(a + b)[x == 1]), list(np.array(a + b)[x == 0])),
            n_boot=1000, random_state=42,
        )
        mw = mann_whitney(a, b)
        out.append({"item": item, "n_a": len(a), "n_b": len(b),
                    "delta": d, "ci_lo": lo, "ci_hi": hi, "p_mw": mw["p"]})
    df = pd.DataFrame(out)
    if not df.empty:
        df["q_bh"] = fdr_bh(df["p_mw"].tolist())
    return df


def comparison_mode(con) -> pd.DataFrame:
    df = completers_frame(con)
    ai = df[df["mode2"] == "AI-to-AI"]
    hu = df[df["mode2"] == "Human-to-AI"]
    fisher = fisher_2x2(
        success_a=int((ai["outcome_type"] == "agreed").sum()), n_a=len(ai),
        success_b=int((hu["outcome_type"] == "agreed").sum()), n_b=len(hu),
    )
    items = _two_group_survey(con, "mode2", "AI-to-AI", "Human-to-AI")
    items.attrs["fisher"] = fisher
    return items


def comparison_role(con) -> pd.DataFrame:
    df = completers_frame(con)
    bu = df[df["role"] == "buyer"]
    se = df[df["role"] == "seller"]
    fisher = fisher_2x2(
        success_a=int((bu["outcome_type"] == "agreed").sum()), n_a=len(bu),
        success_b=int((se["outcome_type"] == "agreed").sum()), n_b=len(se),
    )
    items = _two_group_survey(con, "role", "buyer", "seller")
    items.attrs["fisher"] = fisher
    return items


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
         "now": "descriptive + 20v20 exploratory test",
         "when_n_grows": "powered mode contrast"},
        {"variable": "role", "n": 40,
         "now": "descriptive + 20v20 exploratory test",
         "when_n_grows": "powered role contrast"},
        {"variable": "opponent_personality", "n": 40,
         "now": "descriptive only (≈13/level)",
         "when_n_grows": "3-group KW"},
        {"variable": "final_price", "n": 27,
         "now": "descriptive (agreed only)",
         "when_n_grows": "price modelling"},
        {"variable": "9 survey items", "n": 40,
         "now": "per-item δ + CI, FDR (exploratory)",
         "when_n_grows": "powered item tests + subscales"},
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
                        "price_median": float(g["final_price"].median())
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
                        "price_median": float(g["value_int"].median())
                        if len(g) else None})
    return pd.DataFrame(out)
