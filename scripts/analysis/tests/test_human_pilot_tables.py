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

def test_survey_descriptives_nine_items():
    t = T.survey_descriptives(m_con())
    assert t["item"].nunique() == 9

def test_comparison_mode_has_fisher_attr():
    t = T.comparison_mode(m_con())
    assert "fisher" in t.attrs
    assert "p" in t.attrs["fisher"]

def test_comparison_role_has_fisher_attr():
    t = T.comparison_role(m_con())
    assert "fisher" in t.attrs

def test_variable_inventory_nonempty():
    t = T.variable_inventory(m_con())
    assert len(t) >= 5 and {"variable", "n"} <= set(t.columns)

def test_data_quality_nonempty():
    t = T.data_quality(m_con())
    assert len(t) >= 1 and {"metric", "value"} <= set(t.columns)
