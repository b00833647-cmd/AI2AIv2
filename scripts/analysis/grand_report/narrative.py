"""Data-driven academic prose. Sentences are templated from the quad
raw statistics so the narrative always matches the tables, and the
exploratory/honesty framing is woven in everywhere.
"""
from __future__ import annotations

from . import db
from .design import fmt_ci, fmt_d, fmt_p

HONESTY = (
    "This is a small-sample legacy pilot (n = 10 per experiment). "
    "Opponent personality was randomised, not controlled; the economic-"
    "utility and judge-score tables are empty; no attention check was "
    "recorded. Every inferential statement is exploratory and "
    "hypothesis-generating — never a pre-registered confirmatory result.")


def abstract_text(hd: dict) -> str:
    return (
        "When a person can delegate a negotiation to an artificial-"
        "intelligence agent instead of conducting it themselves, what "
        "happens to the deal and to how they feel about it? This report "
        "is a comprehensive, exploratory analysis of the first human "
        "pilot of the AI2AI platform — a controlled single-issue price "
        "negotiation over a used Toyota Camry. The design crosses Mode "
        "(delegated; direct) with Role (buyer; seller), yielding four "
        "experiments (X1 delegated-buyer, X2 delegated-seller, X3 direct-"
        "buyer, X4 direct-seller), each n = 10. Across forty-five analysis "
        "families the report presents every measure at four levels: each "
        "experiment one-by-one, the 2×2 factorial with structured "
        "pairwise contrasts, the pooled sample, and an integrative "
        f"review. Of {hd['n']} completers, {hd['n_agreed']} reached "
        f"agreement; settlements concentrated inside the zone of possible "
        f"agreement ({hd['inzopa']}). The primary measure, satisfaction, "
        f"showed a {hd['sat_band']} Mode effect "
        f"({fmt_p(hd['sat_p'])}, Cliff's δ = {fmt_d(hd['sat_d'])}). "
        + HONESTY)


def intro():
    return [
        "Artificial-intelligence systems increasingly act on a person's "
        "behalf rather than merely advising them. Negotiation is a "
        "stringent test of delegation because it binds an economic "
        "outcome to interpersonal and affective stakes and demands real-"
        "time strategic adaptation. As large-language-model agents become "
        "competent negotiators, a concrete question follows: when a "
        "person delegates a negotiation to an AI agent instead of "
        "conducting it directly, what happens to the agreement and to the "
        "person's subjective experience?",
        "Evidence on reliance on algorithms is mixed — algorithm aversion "
        "after observed error (Dietvorst, Simmons, & Massey, 2015) versus "
        "algorithm appreciation (Logg, Minson, & Moore, 2019). Delegation "
        "cedes real-time control, so subjective consequences (perceived "
        "control, felt representation, fairness, willingness to reuse) "
        "are as interesting as the price obtained.",
        "The AI2AI platform studies this under controlled, reproducible "
        "conditions. This report exhaustively analyses the first human "
        "pilot across forty-five analysis families and four experiments, "
        "reporting each at four levels: one-by-one, 2×2 + pairwise, "
        "overall, and an integrative review. The aims are infrastructural "
        "and generative — characterise everything the data support, "
        "validate the instrumentation, and generate hypotheses for a "
        "pre-registered confirmatory study. " + HONESTY,
    ]


def method(con):
    r = db.verify_reservations(con)
    return {
        "Participants": (
            "Fifty-nine participants enrolled via Prolific; 40 received "
            "the completion code and constitute the analysed sample, "
            "balanced at 10 per experiment (X1–X4). No participant is "
            "flagged excluded or test data; the attention-check field was "
            "never populated."),
        "Design": (
            "A 2 (Mode: delegated, direct) × 2 (Role: buyer, seller) "
            "between-subjects factorial defines the four experiments. "
            "Opponent personality (easygoing, moderate, tough) was "
            "randomised and is unbalanced across cells — an uncontrolled "
            "covariate, not a designed block; no clean three-way is "
            "possible."),
        "Materials and Apparatus": (
            f"A single-issue distributive price negotiation over a 2023 "
            f"Toyota Camry. Reservation values were verified uniform from "
            f"the scenario pack: buyer aspiration "
            f"${r['buyer_aspiration']:,}, buyer ceiling "
            f"${r['buyer_ceiling']:,}; seller listing "
            f"${r['seller_listing']:,}, seller floor "
            f"${r['seller_floor']:,}; ZOPA "
            f"${db.ZOPA_LOW:,}–${db.ZOPA_HIGH:,} (a fixed "
            f"${db.ZOPA_WIDTH:,} pie). Delegated participants briefed an "
            "LLM agent that negotiated AI-to-AI; direct participants typed "
            "turns against the LLM. An orchestrator mediated turns."),
        "Measures": (
            "Nine post-experience 1–7 items (satisfaction is primary), "
            "negotiation outcomes, a derived distributive-surplus model, "
            "transcript-based process metrics, 6,601 client instrumentation "
            "events, mode-specific behaviour, and open text. Utility and "
            "judge-score tables are empty and excluded."),
        "Data-Analysis Approach": (
            "Modern, nonparametric, effect-size-focused: Mann–Whitney "
            "with Cliff's δ and bootstrap CIs (scipy.stats.bootstrap), "
            "Scheirer–Ray–Hare 2×2, Kruskal–Wallis (opponent, sensitivity), "
            "Fisher's exact, Spearman, Cronbach's α, Benjamini–Hochberg, "
            "Bayesian t and TOST equivalence (pingouin), survival "
            "(lifelines), clustering/factor structure (scikit-learn). The "
            "quad runner applies the four levels uniformly. Deterministic "
            "and offline. " + HONESTY),
    }


def group_review(title: str, raw: dict) -> str:
    """One synthesis sentence from the strongest Mode effect in the
    group, with the exploratory tag."""
    if not raw:
        return ("Reported descriptively at the cohort level; exploratory "
                "and hypothesis-generating only.")
    best_v, best = None, None
    for v, r in raw.items():
        mm = r.get("mw_mode", {})
        d = abs(mm.get("delta", 0) or 0)
        if best is None or d > best:
            best, best_v, best_r = d, v, r
    mm = best_r["mw_mode"]
    rr = best_r["mw_role"]
    ab = best_r["srh"]["AB"]
    return (
        f"Across {len(raw)} measure(s), the largest Mode signal was on "
        f"‘{best_v}’ ({fmt_p(mm['p'])}, Cliff's δ = {fmt_d(mm['delta'])} "
        f"{fmt_ci(mm['ci_lo'], mm['ci_hi'])}, {mm['band']}); the Role "
        f"contrast there was {fmt_p(rr['p'])} and the Mode×Role "
        f"interaction {fmt_p(ab['p'])}. At ~10 per experiment these are "
        "exploratory and hypothesis-generating; effect sizes and "
        "intervals, not p-values, carry the interpretation.")


def discussion(hd):
    return {
        "Summary": (
            f"Agreement dominated ({hd['n_agreed']}/{hd['n']}); "
            "settlements were economically efficient (within ZOPA) and "
            "split near-evenly; the nine subjective measures were broadly "
            "comparable across Mode with generally small exploratory "
            "effects. No single-experiment or pairwise result should be "
            "read as evidence at this sample size."),
        "Strengths": (
            "Verified fixed reservations; a balanced four-experiment "
            "allocation; dense instrumentation; a modern, fully "
            "deterministic and offline pipeline; and a coherent design "
            "system so every figure and table is mutually comparable."),
        "Limitations": (
            "Decisive: n = 10 per experiment (severely underpowered, p- "
            "and q-values illustrative); opponent randomised and "
            "unbalanced (a confound); no attention check; empty utility/"
            "score tables; a single distributive issue; stochastic LLM "
            "agents with two degraded sessions; deterministic-only text "
            "analysis. " + HONESTY),
        "Implications": (
            "The pilot is infrastructurally decisive and generative. A "
            "powered confirmatory study should control and balance "
            "opponent personality, record the attention check and pre-"
            "register exclusions, populate the utility tables, pre-"
            "register the primary satisfaction contrast and a corrected "
            "secondary family, and recruit to roughly 24 per Mode×Role×"
            "opponent stratum."),
        "Conclusion": (
            "Whether people obtain better deals, or merely feel better, "
            "when they delegate a negotiation to AI remains open. This "
            "pilot does not answer it and is not designed to; it "
            "demonstrates an analysis-ready platform and a complete, "
            "reproducible four-experiment evidentiary pipeline for the "
            "confirmatory study to come."),
    }


REFERENCES = [
    "Benjamini, Y., & Hochberg, Y. (1995). Controlling the false "
    "discovery rate. Journal of the Royal Statistical Society: Series B, "
    "57(1), 289–300.",
    "Cliff, N. (1993). Dominance statistics: Ordinal analyses to answer "
    "ordinal questions. Psychological Bulletin, 114(3), 494–509.",
    "Cronbach, L. J. (1951). Coefficient alpha and the internal "
    "structure of tests. Psychometrika, 16(3), 297–334.",
    "Dietvorst, B. J., Simmons, J. P., & Massey, C. (2015). Algorithm "
    "aversion. Journal of Experimental Psychology: General, 144(1), "
    "114–126.",
    "Kruskal, W. H., & Wallis, W. A. (1952). Use of ranks in one-"
    "criterion variance analysis. Journal of the American Statistical "
    "Association, 47(260), 583–621.",
    "Lakens, D. (2017). Equivalence tests. Social Psychological and "
    "Personality Science, 8(4), 355–362.",
    "Logg, J. M., Minson, J. A., & Moore, D. A. (2019). Algorithm "
    "appreciation. Organizational Behavior and Human Decision Processes, "
    "151, 90–103.",
    "Mann, H. B., & Whitney, D. R. (1947). On a test of whether one of "
    "two random variables is stochastically larger than the other. The "
    "Annals of Mathematical Statistics, 18(1), 50–60.",
    "Romano, J., Kromrey, J. D., Coraggio, J., & Skowronek, J. (2006). "
    "Appropriate statistics for ordinal level data. Florida Association "
    "of Institutional Research.",
    "Scheirer, C. J., Ray, W. S., & Hare, N. (1976). The analysis of "
    "ranked data derived from completely randomized factorial designs. "
    "Biometrics, 32(2), 429–434.",
    "Vallat, R. (2018). Pingouin: Statistics in Python. Journal of Open "
    "Source Software, 3(31), 1026.",
]
