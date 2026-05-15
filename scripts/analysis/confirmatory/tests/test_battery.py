import numpy as np
import pandas as pd
from scripts.analysis.confirmatory.tests_battery import run_battery


def _clean_sample(seed=1):
    rng = np.random.default_rng(seed)
    rows = []
    for m in ("delegated", "direct"):
        for r in ("buyer", "seller"):
            for o in ("easygoing", "moderate", "tough"):
                for _ in range(8):
                    sat = rng.normal(5.4 if m == "delegated" else 4.2, 1.0)
                    rows.append({
                        "participant_id": f"{m}{r}{o}{_}{rng.integers(1e9)}",
                        "condition_mode": m, "condition_role": r,
                        "opponent_block": o, "condition_source": "main",
                        "mode2": "AI-to-AI" if m == "delegated" else "Human-to-AI",
                        "outcome_type": "agreed" if rng.random() < 0.6 else "rejected",
                        "final_price": 23000.0,
                        "satisfaction": float(np.clip(round(sat), 1, 7)),
                        "would_use_again": float(rng.integers(1, 8)),
                        "agent_represented": float(rng.integers(1, 8)),
                        "control": float(rng.integers(1, 8)),
                        "emot_pleasant": float(rng.integers(1, 8)),
                        "emot_anxious": float(rng.integers(1, 8)),
                        "effort_invested": float(rng.integers(1, 8)),
                        "engage_engaged": float(rng.integers(1, 8)),
                        "outfair_share": float(rng.integers(1, 8)),
                    })
    return pd.DataFrame(rows)


def test_battery_structure_and_primary_detects_injected_effect():
    res = run_battery(_clean_sample())
    p = res["primary"]
    assert p["dv"] == "satisfaction"
    assert p["test"] == "mann_whitney_two_sided"
    assert 0.0 <= p["p"] <= 1.0
    assert p["p"] < 0.05
    assert "cliffs_delta" in p and "ci95" in p and len(p["ci95"]) == 2
    assert set(res["srh"]) == {"A", "B", "AB", "N"}
    fam = res["secondary"]
    assert {"dv", "p", "q_bh"} <= set(fam[0])
    assert all(0.0 <= r["q_bh"] <= 1.0 for r in fam)
    assert any(r["dv"] == "agreement_rate" and r["test"] == "fisher_2x2"
               for r in fam)
    assert res["opponent_sensitivity"]["test"] == "kruskal_wallis"
    assert res["exploratory"]["label"] == "exploratory, uncorrected"


def test_battery_marks_agent_represented_delegated_only():
    res = run_battery(_clean_sample())
    ar = [r for r in res["secondary"] if r["dv"] == "agent_represented"][0]
    assert ar.get("caveat") == "delegated-only (not comparable in direct)"
