from scripts.analysis.human_pilot.palette import (
    PALETTE, MODE2_COLORS, ROLE_COLORS, CELL_COLORS, OUTCOME_COLORS,
)

def test_palette_hex():
    for v in PALETTE.values():
        assert v.startswith("#") and len(v) == 7

def test_mode2_two_levels():
    assert set(MODE2_COLORS) == {"AI-to-AI", "Human-to-AI"}

def test_role_two_levels():
    assert set(ROLE_COLORS) == {"buyer", "seller"}

def test_cell_four_levels():
    assert set(CELL_COLORS) == {"agent/buyer", "agent/seller",
                                "human_buyer/buyer", "human_seller/seller"}

def test_outcome_levels():
    assert {"agreed", "rejected", "impasse", "aborted"} <= set(OUTCOME_COLORS)
