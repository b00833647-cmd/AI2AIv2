"""Modern colorblind-safe report palette (Okabe-Ito based) + locked
condition→colour maps so the same group is the same colour everywhere."""

PALETTE = {
    "blue":       "#0072B2",
    "orange":     "#E69F00",
    "green":      "#009E73",
    "vermillion": "#D55E00",
    "sky":        "#56B4E9",
    "purple":     "#CC79A7",
    "yellow":     "#F0E442",
    "grey":       "#999999",
}

MODE2_COLORS = {"AI-to-AI": PALETTE["blue"], "Human-to-AI": PALETTE["orange"]}
ROLE_COLORS = {"buyer": PALETTE["sky"], "seller": PALETTE["vermillion"]}
CELL_COLORS = {
    "agent/buyer":          PALETTE["blue"],
    "agent/seller":         PALETTE["sky"],
    "human_buyer/buyer":    PALETTE["orange"],
    "human_seller/seller":  PALETTE["vermillion"],
}
OUTCOME_COLORS = {
    "agreed":   PALETTE["green"],
    "rejected": PALETTE["vermillion"],
    "impasse":  PALETTE["orange"],
    "aborted":  PALETTE["grey"],
}
LIKERT_DIVERGING = ["#B2182B", "#EF8A62", "#FDDBC7", "#F7F7F7",
                    "#D1E5F0", "#67A9CF", "#2166AC"]
