import sys
import pandas as pd
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot import tables as T

def setup_module(m):
    m.con = load_db(SNAPSHOT)

def m_con():
    return sys.modules[__name__].con

def test_sample_composition_sums_to_40():
    t = T.sample_composition(m_con())
    assert int(t["n"].sum()) == 40

def test_demographics_summary_has_levels():
    t = T.demographics_summary(m_con())
    assert {"variable", "level", "n", "pct"} <= set(t.columns)

def test_outcome_descriptives_four_cells():
    t = T.outcome_descriptives(m_con())
    assert "agreement_rate" in t.columns
    assert len(t) == 4

def test_variable_inventory_nonempty():
    t = T.variable_inventory(m_con())
    assert len(t) >= 5 and {"variable", "n"} <= set(t.columns)

def test_data_quality_nonempty():
    t = T.data_quality(m_con())
    assert len(t) >= 1 and {"metric", "value"} <= set(t.columns)


def test_dv_group_descriptives_shape():
    t = T.dv_group_descriptives(m_con())
    assert len(t) == 36  # 9 DVs × 4 cells
    assert set(["dv", "priority", "mode2", "role", "n", "M", "SD", "Mdn", "IQR"]) <= set(t.columns)
    assert t["n"].tolist() == [10] * 36
    assert t[t["priority"]]["dv"].nunique() == 4


def test_srh_results_shape():
    t = T.srh_results(m_con())
    assert len(t) == 9
    cols = {"dv", "priority", "mode_H", "mode_p", "mode_eta2", "role_H",
            "role_p", "role_eta2", "inter_H", "inter_p", "inter_eta2", "N"}
    assert cols <= set(t.columns)
    for c in ("mode_p", "role_p", "inter_p"):
        assert ((t[c] >= 0) & (t[c] <= 1)).all()
    assert (t["N"] == 40).all()
    assert t["priority"].sum() == 4


def test_agreement_2x2_dict():
    a = T.agreement_2x2(m_con())
    assert set(a) == {"by_mode", "by_role"}
    for k in ("by_mode", "by_role"):
        assert {"odds_ratio", "p", "rate_a", "rate_b"} <= set(a[k])
        assert 0.0 <= a[k]["p"] <= 1.0
