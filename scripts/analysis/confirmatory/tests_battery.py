"""The pre-registered confirmatory test battery (spec 1 + 4b §4).

All tests run on the analyzable sample only. Primary is a single
pre-registered test (no correction); the secondary family is
Benjamini–Hochberg corrected together; exploratory is labeled.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from scripts.analysis.core.stats import (
    mann_whitney, cliff_delta, fdr_bh, scheirer_ray_hare, fisher_2x2,
    kruskal_wallis,
)

SECONDARY_SURVEY = [
    "would_use_again", "control", "emot_pleasant", "emot_anxious",
    "effort_invested", "engage_engaged", "outfair_share",
]


def _mode_split(df: pd.DataFrame, dv: str):
    a = df.loc[df["condition_mode"] == "delegated", dv].astype(float)
    b = df.loc[df["condition_mode"] == "direct", dv].astype(float)
    return a.dropna().to_numpy(), b.dropna().to_numpy()


def _cliffs_ci(a, b, n_boot: int = 1000, seed: int = 42):
    """Two-sample percentile bootstrap CI for Cliff's δ. core.bootstrap_ci is single-sample only, so a joint two-array resample is done here."""
    rng = np.random.default_rng(seed)
    A = pd.Series(a, dtype=float).dropna().to_numpy()
    B = pd.Series(b, dtype=float).dropna().to_numpy()
    if A.size < 2 or B.size < 2:
        return float("nan"), float("nan")
    boots = [cliff_delta(rng.choice(A, A.size, replace=True),
                         rng.choice(B, B.size, replace=True))
             for _ in range(n_boot)]
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def run_battery(sample: pd.DataFrame) -> dict:
    # primary: satisfaction ~ Mode (two-sided MW) + Cliff's delta + 95% CI
    a, b = _mode_split(sample, "satisfaction")
    mw = mann_whitney(a, b, alternative="two-sided")
    lo, hi = _cliffs_ci(a, b)
    primary = {"dv": "satisfaction", "test": "mann_whitney_two_sided",
               "U": mw["U"], "p": mw["p"], "n_a": mw["n_a"], "n_b": mw["n_b"],
               "cliffs_delta": float(cliff_delta(a, b)), "ci95": [lo, hi]}

    # primary structural omnibus (reported secondary): SRH 2x2
    srh = scheirer_ray_hare(sample, "satisfaction",
                            "condition_mode", "condition_role")

    # secondary family (BH-corrected together)
    fam = []
    for dv in SECONDARY_SURVEY:
        x, y = _mode_split(sample, dv)
        m = mann_whitney(x, y, alternative="two-sided")
        row = {"dv": dv, "test": "mann_whitney_two_sided", "p": m["p"],
               "cliffs_delta": float(cliff_delta(x, y)),
               "n_a": m["n_a"], "n_b": m["n_b"]}
        fam.append(row)
    px, py = _mode_split(sample, "final_price")
    pm = mann_whitney(px, py, alternative="two-sided")
    fam.append({"dv": "final_price", "test": "mann_whitney_two_sided",
                "p": pm["p"], "cliffs_delta": float(cliff_delta(px, py)),
                "n_a": pm["n_a"], "n_b": pm["n_b"]})
    deleg = sample[sample["condition_mode"] == "delegated"]
    direct = sample[sample["condition_mode"] == "direct"]
    fr = fisher_2x2(int((deleg["outcome_type"] == "agreed").sum()), len(deleg),
                    int((direct["outcome_type"] == "agreed").sum()), len(direct))
    fam.append({"dv": "agreement_rate", "test": "fisher_2x2",
                "p": fr["p"], "odds_ratio": fr["odds_ratio"]})
    for r, q in zip(fam, fdr_bh([r["p"] for r in fam])):
        r["q_bh"] = float(q)

    # opponent as controlled covariate (sensitivity only)
    groups = [sample.loc[sample["opponent_block"] == o, "satisfaction"]
              .astype(float).dropna().to_numpy()
              for o in ("easygoing", "moderate", "tough")]
    opp = kruskal_wallis(*groups)
    opp_out = {"test": "kruskal_wallis",
               "note": "controlled covariate, not a factor of interest",
               **opp}

    ar = sample.loc[sample["condition_mode"] == "delegated",
                    "agent_represented"].astype(float).dropna()
    delegated_only = {
        "dv": "agent_represented",
        "caveat": "delegated-only (not comparable in direct); reported "
                  "descriptively, excluded from the BH secondary family",
        "n": int(ar.size),
        "mean": float(ar.mean()) if ar.size else float("nan"),
        "median": float(ar.median()) if ar.size else float("nan"),
    }

    return {"primary": primary, "srh": srh, "secondary": fam,
            "opponent_sensitivity": opp_out,
            "delegated_only": delegated_only,
            "exploratory": {"label": "exploratory, uncorrected", "items": []}}
