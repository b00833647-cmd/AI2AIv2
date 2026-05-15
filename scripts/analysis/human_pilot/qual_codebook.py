# scripts/analysis/human_pilot/qual_codebook.py
"""The qualitative codebook. Shared by code_qualitative.py (LLM coding)
and tables.py / figures.py (rendering). One source of truth."""
from __future__ import annotations

# 8A — inductive theme presence flags (boolean per prompt/context text).
THEME_FLAGS = [
    "anchor_high",          # instruct to open high / hold near asking
    "concession_plan",      # explicit "if they offer X, do Y"
    "walkaway_threshold",   # a stated floor/ceiling number
    "relationship_tone",    # be polite/friendly/respectful
    "urgency_framing",      # moving soon / quick sale / avoid desperation
    "value_justification",  # point out condition / features / history
    "toughness",            # firm / don't budge / aggressive
    "flexibility",          # willing to negotiate / meet in the middle
]

# 8B — deductive taxonomy (one categorical value each).
TAXONOMY = {
    "orientation":          ["distributive", "integrative", "mixed"],
    "anchor":               ["high", "moderate", "none"],
    "threshold_stated":     ["yes", "no"],
    "politeness_instructed": ["yes", "no"],
    "info_strategy":        ["emphasize_value", "conceal", "neutral"],
}

# 8C — free-text study comment coding.
COMMENT_VALENCE = ["positive", "neutral", "negative"]
COMMENT_TOPIC = ["enjoyment", "ai_competence", "difficulty", "suggestion", "other"]

MODEL = "claude-sonnet-4-6"
CODER_RUN_DATE = "2026-05-15"
