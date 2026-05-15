"""Process & interaction-dynamics report orchestrator.

Builds docs/reports/2026-05-15-negotiation-process-report.docx from the
package's own modules only (db / metrics / stats / viz / docx_build) plus
stdlib + pandas. Zero imports from scripts.analysis.human_pilot or
scripts.analysis.core. Offline, deterministic, no network/LLM.

For every continuous DV the stats_block runs, per the user's instruction:
  * Scheirer-Ray-Hare 2x2 (factor A = Mode, factor B = Role, A x B)
  * Mann-Whitney U for the Mode contrast + two-sample bootstrap CI of
    Cliff's delta, and the Role contrast
  * Kruskal-Wallis omnibus across the 4 study cells
All p uncorrected; strictly exploratory at n=10/cell; no post-hoc.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from . import db, docx_build, metrics, stats, viz

OUT = Path("docs/reports/2026-05-15-negotiation-process-report.docx")
TBL = Path("docs/reports/tables-process")

_CAPTION = "exploratory; n=10/cell; uncorrected"


def _csv(df: pd.DataFrame, name: str) -> None:
    """Persist a table as docs/reports/tables-process/<name>.csv."""
    TBL.mkdir(parents=True, exist_ok=True)
    df.to_csv(TBL / f"{name}.csv", index=False)


def _r4(x):
    """Round a float to 4 dp; pass NaN/None through as float('nan')."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return float("nan")
    if not np.isfinite(v):
        return float("nan")
    return round(v, 4)


def stats_block(frame: pd.DataFrame, dvs: list) -> pd.DataFrame:
    """One row per DV: SRH (Mode/Role/interaction) + MW (Mode, Role) +
    bootstrap CI of the Mode Cliff's delta + KW across the 4 cells.

    Robust: a DV with <2 observations per group yields NaN stats rather
    than crashing, and the row is kept (never silently dropped). All
    reported p are in [0, 1] or NaN.
    """
    rows = []
    for dv in dvs:
        rec = {"dv": dv, "n": 0,
               "mode_p": float("nan"), "mode_eta2": float("nan"),
               "role_p": float("nan"), "role_eta2": float("nan"),
               "inter_p": float("nan"),
               "mw_mode_p": float("nan"), "mw_mode_delta": float("nan"),
               "ci_lo": float("nan"), "ci_hi": float("nan"),
               "mw_role_p": float("nan"), "mw_role_delta": float("nan"),
               "kw_p": float("nan"), "kw_eps2": float("nan")}
        if dv not in frame.columns:
            rows.append(rec)
            continue

        sub = frame[[dv, "mode2", "role", "cell"]].copy()
        sub[dv] = pd.to_numeric(sub[dv], errors="coerce")
        sub = sub.dropna(subset=[dv])
        rec["n"] = int(len(sub))

        # --- SRH 2x2: A = Mode, B = Role ---
        try:
            srh = stats.scheirer_ray_hare(
                sub.rename(columns={"mode2": "A", "role": "B"}),
                dv, "A", "B")
            rec["mode_p"] = _r4(srh["A"]["p"])
            rec["mode_eta2"] = _r4(srh["A"]["eta2"])
            rec["role_p"] = _r4(srh["B"]["p"])
            rec["role_eta2"] = _r4(srh["B"]["eta2"])
            rec["inter_p"] = _r4(srh["AB"]["p"])
        except Exception:
            pass  # leave SRH fields as NaN

        # --- MW Mode contrast + two-sample bootstrap CI of Cliff's d ---
        a = sub.loc[sub["mode2"] == "AI-to-AI", dv].to_numpy(float)
        b = sub.loc[sub["mode2"] == "Human-to-AI", dv].to_numpy(float)
        mwm = stats.mann_whitney(a, b)
        rec["mw_mode_p"] = _r4(mwm["p"])
        rec["mw_mode_delta"] = _r4(mwm["cliffs_delta"])
        if a[~np.isnan(a)].size >= 2 and b[~np.isnan(b)].size >= 2:
            try:
                lo, hi = stats.bootstrap_ci(a[~np.isnan(a)],
                                            b[~np.isnan(b)])
                rec["ci_lo"], rec["ci_hi"] = _r4(lo), _r4(hi)
            except Exception:
                pass

        # --- MW Role contrast ---
        rb = sub.loc[sub["role"] == "buyer", dv].to_numpy(float)
        rs = sub.loc[sub["role"] == "seller", dv].to_numpy(float)
        mwr = stats.mann_whitney(rb, rs)
        rec["mw_role_p"] = _r4(mwr["p"])
        rec["mw_role_delta"] = _r4(mwr["cliffs_delta"])

        # --- KW omnibus across the 4 cells ---
        groups = [sub.loc[sub["cell"] == c, dv].dropna().to_numpy(float)
                  for c in db.CELLS]
        kw = stats.kruskal_wallis(*groups)
        rec["kw_p"] = _r4(kw["p"])
        rec["kw_eps2"] = _r4(kw["eps2"])

        rows.append(rec)

    cols = ["dv", "n", "mode_p", "mode_eta2", "role_p", "role_eta2",
            "inter_p", "mw_mode_p", "mw_mode_delta", "ci_lo", "ci_hi",
            "mw_role_p", "mw_role_delta", "kw_p", "kw_eps2"]
    return pd.DataFrame(rows, columns=cols)


def descriptives(frame: pd.DataFrame, dvs: list) -> pd.DataFrame:
    """Per-cell medians of the DVs (median, 4 dp), one row per cell."""
    keep = [d for d in dvs if d in frame.columns]
    sub = frame[["cell"] + keep].copy()
    for d in keep:
        sub[d] = pd.to_numeric(sub[d], errors="coerce")
    med = (sub.groupby("cell", as_index=False)[keep]
           .median(numeric_only=True))
    for d in keep:
        med[d] = med[d].map(_r4)
    return med.reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Hand-authored metric dictionaries (auditable; 1-line definitions)            #
# --------------------------------------------------------------------------- #
_DICTS = {
    "1": [
        ("opening_spread", "seller_open - buyer_open: distance between the "
         "two sides' first priced proposals", "turns.tool_calls_json "
         "(submit_proposal)", "continuous"),
        ("anchor_distance", "|own opening price - own scenario target|: how "
         "far the opener anchored from its brief target", "turns + fixed "
         "Camry scenario brief", "continuous"),
        ("n_concessions", "count of the focal side's own moves in the "
         "conceding direction across proposal rounds", "ordered proposal "
         "stream", "count"),
        ("mean_concession", "mean |price step| of the focal side's "
         "conceding moves (USD)", "ordered proposal stream", "continuous"),
        ("concession_rate", "focal side's total concession / number of "
         "proposal rounds (USD per round)", "ordered proposal stream",
         "continuous"),
        ("buyer_share_concession", "buyer total concession / (buyer + "
         "seller total concession)", "ordered proposal stream",
         "ratio [0,1]"),
        ("n_proposal_rounds", "count of priced submit_proposal calls in the "
         "session", "turns.tool_calls_json", "count"),
        ("turns_to_deal", "turn number of the accept that closed an agreed "
         "session (NaN if no deal)", "turns.tool_calls_json (accept)",
         "count"),
        ("n_final_offers", "count of proposals flagged is_final=true",
         "turns.tool_calls_json", "count"),
    ],
    "2": [
        ("median_latency_ms", "session median of per-turn latency_ms "
         "(think+type for humans, model time for agents)", "turns.latency_ms",
         "continuous"),
        ("mean_latency_ms", "session mean of per-turn latency_ms",
         "turns.latency_ms", "continuous"),
        ("negotiation_duration_s", "sessions.ended_at - started_at, in "
         "seconds", "sessions timestamps", "continuous"),
        ("time_to_deal_s", "seconds from first turn to the closing accept "
         "(NaN if no deal)", "turns timestamps", "continuous"),
        ("tokens_total", "total LLM tokens consumed in the session",
         "sessions.tokens_total", "count"),
        ("orch_token_share", "tokens_orchestrator / tokens_total (referee "
         "overhead share)", "sessions token fields", "ratio [0,1]"),
        ("tokens_per_turn", "tokens_total / turns_consumed",
         "sessions fields", "continuous"),
    ],
    "3": [
        ("alternation_rate", "fraction of consecutive request_turn routes "
         "that switch side", "orchestrator_decisions (request_turn)",
         "ratio [0,1]"),
        ("longest_same_streak", "longest run of consecutive routes to the "
         "same side", "orchestrator_decisions (request_turn)", "count"),
        ("declare_turn", "turn_number at the declare_outcome decision",
         "orchestrator_decisions (declare_outcome)", "count"),
        ("declare_latency_s", "seconds between the last turn and the "
         "declare_outcome decision", "orchestrator_decisions + turns ts",
         "continuous"),
        ("rationale_len", "character length of the declare_outcome "
         "rationale text", "orchestrator_decisions.rationale", "count"),
        ("orch_tokens_per_turn", "tokens_orchestrator / turns_consumed "
         "(per-turn referee cost)", "sessions fields", "continuous"),
        ("degraded", "session-level degraded flag (binary; Fisher 2x2)",
         "sessions.degraded", "binary"),
    ],
    "4": [
        ("total_active_s", "sum of screen_exit.dwellMs over all screens "
         "(seconds)", "participant_events (screen_exit)", "continuous"),
        ("engine_dwell_s", "screen_exit.dwellMs summed on the live-"
         "negotiation screen (seconds)", "participant_events (screen_exit)",
         "continuous"),
        ("total_idle_s", "sum of idle_end.idleMs (seconds of detected "
         "inactivity)", "participant_events (idle_end)", "continuous"),
        ("n_tab_away", "count of visibility_change events with hidden=true",
         "participant_events (visibility_change)", "count"),
        ("n_thumbnail_views", "count of listing_thumbnail_view events",
         "participant_events", "count"),
        ("n_zoom_opens", "count of listing_zoom_open events",
         "participant_events", "count"),
        ("n_clicks", "count of click events", "participant_events",
         "count"),
        ("mean_scroll_pct", "mean of per-screen max scroll.maxPct",
         "participant_events (scroll)", "continuous"),
        ("mean_compose_s", "mean seconds from human_turn_input_enabled to "
         "the following human_turn_submitted (Human-to-AI only)",
         "participant_events", "continuous"),
        ("mean_charcount", "mean charCount of human_turn_submitted "
         "(Human-to-AI only)", "participant_events", "continuous"),
    ],
}


def metric_dictionary(pillar: str) -> pd.DataFrame:
    """Static [name, definition, source, type] table for a pillar."""
    return pd.DataFrame(
        _DICTS[pillar],
        columns=["name", "definition", "source", "type"])


# --------------------------------------------------------------------------- #
# DV lists per pillar                                                          #
# --------------------------------------------------------------------------- #
_DV1 = ["opening_spread", "anchor_distance", "n_concessions",
        "mean_concession", "concession_rate", "buyer_share_concession",
        "n_proposal_rounds", "turns_to_deal", "n_final_offers"]
_DV2 = ["median_latency_ms", "mean_latency_ms", "negotiation_duration_s",
        "time_to_deal_s", "tokens_total", "orch_token_share",
        "tokens_per_turn"]
_DV3 = ["alternation_rate", "longest_same_streak", "declare_turn",
        "declare_latency_s", "rationale_len", "orch_tokens_per_turn"]
_DV4 = ["total_active_s", "engine_dwell_s", "total_idle_s", "n_tab_away",
        "n_thumbnail_views", "n_zoom_opens", "n_clicks", "mean_scroll_pct"]


def _fisher_table(of: pd.DataFrame) -> pd.DataFrame:
    """Fisher 2x2 for binary `degraded` across the Mode and Role contrasts."""
    d = of.copy()
    d["degraded"] = pd.to_numeric(d["degraded"], errors="coerce").fillna(0)
    rows = []
    for label, ga, gb in [
        ("Mode (AI-to-AI vs Human-to-AI)",
         d[d["mode2"] == "AI-to-AI"], d[d["mode2"] == "Human-to-AI"]),
        ("Role (buyer vs seller)",
         d[d["role"] == "buyer"], d[d["role"] == "seller"]),
    ]:
        sa, na = int(ga["degraded"].sum()), int(len(ga))
        sb, nb = int(gb["degraded"].sum()), int(len(gb))
        f = stats.fisher_2x2(sa, na, sb, nb)
        rows.append({
            "contrast": label, "succ_a": sa, "n_a": na,
            "rate_a": _r4(f["rate_a"]), "succ_b": sb, "n_b": nb,
            "rate_b": _r4(f["rate_b"]),
            "odds_ratio": _r4(f["odds_ratio"]), "p": _r4(f["p"])})
    return pd.DataFrame(rows)


def _human_mw_table(hc: pd.DataFrame, dvs: list) -> pd.DataFrame:
    """Human-to-AI only: buyer-vs-seller MW (2-group; no SRH/KW)."""
    rows = []
    for dv in dvs:
        rec = {"dv": dv, "n": 0, "mw_p": float("nan"),
               "cliffs_delta": float("nan"), "ci_lo": float("nan"),
               "ci_hi": float("nan")}
        if dv in hc.columns:
            s = pd.to_numeric(hc[dv], errors="coerce")
            rb = hc.loc[hc["role"] == "buyer", dv]
            rs = hc.loc[hc["role"] == "seller", dv]
            rb = pd.to_numeric(rb, errors="coerce").to_numpy(float)
            rs = pd.to_numeric(rs, errors="coerce").to_numpy(float)
            rec["n"] = int(s.notna().sum())
            mw = stats.mann_whitney(rb, rs)
            rec["mw_p"] = _r4(mw["p"])
            rec["cliffs_delta"] = _r4(mw["cliffs_delta"])
            ca = rb[~np.isnan(rb)]
            cb = rs[~np.isnan(rs)]
            if ca.size >= 2 and cb.size >= 2:
                try:
                    lo, hi = stats.bootstrap_ci(ca, cb)
                    rec["ci_lo"], rec["ci_hi"] = _r4(lo), _r4(hi)
                except Exception:
                    pass
        rows.append(rec)
    return pd.DataFrame(
        rows, columns=["dv", "n", "mw_p", "cliffs_delta", "ci_lo", "ci_hi"])


# --------------------------------------------------------------------------- #
# Pillar assembly                                                              #
# --------------------------------------------------------------------------- #
def _pillar(doc, con, num: str, title: str, fig_specs: list,
            frame: pd.DataFrame, dvs: list, surplus_note: bool = False):
    docx_build.h1(doc, f"{num}. {title}")

    md = metric_dictionary(num)
    docx_build.table(doc, md, f"Table {num}.0 — Metric dictionary (§{num})",
                     "Hand-authored definitions so every derived process "
                     "metric is auditable.")
    _csv(md, f"sec{num}_metric_dictionary")

    for k, (fn, ftitle, note) in enumerate(fig_specs, start=1):
        path = fn(con)
        docx_build.figure(doc, path, f"Figure {num}.{k} — {ftitle}",
                          f"{note} ({_CAPTION}).")

    desc = descriptives(frame, dvs)
    docx_build.table(doc, desc,
                     f"Table {num}.1 — Per-cell medians (§{num} DVs)",
                     f"Median per study cell ({_CAPTION}).")
    _csv(desc, f"sec{num}_descriptives")

    sb = stats_block(frame, dvs)
    docx_build.table(
        doc, sb, f"Table {num}.2 — SRH / MW / KW stats (§{num} DVs)",
        f"Scheirer-Ray-Hare 2x2 (Mode A, Role B, A x B), Mann-Whitney for "
        f"the Mode & Role contrasts (Cliff's delta + 95% two-sample "
        f"bootstrap CI on the Mode contrast), Kruskal-Wallis across the 4 "
        f"cells. {_CAPTION}; n=10/cell. p in [0,1] or NaN.")
    _csv(sb, f"sec{num}_stats_block")

    if surplus_note:
        sf = metrics.surplus_frame(con)
        _csv(sf, "sec1_surplus_frame")
        in_z = int(sf["pareto_efficient"].sum())
        docx_build.para(
            doc,
            f"Surplus split (deal sessions, n={len(sf)}; {in_z} in-ZOPA): "
            f"buyer/seller surplus is computed against the fixed Camry "
            f"reservations (buyer walk-away $23,500, seller floor $22,500). "
            f"Shares are only defined for in-ZOPA settlements; see "
            f"sec1_surplus_frame.csv. Exploratory; n=10/cell; uncorrected.",
            italic=True)


def build() -> None:
    """Assemble and save the process & interaction-dynamics report."""
    con = db.connect()
    try:
        doc = docx_build.new_doc()
        docx_build.h1(doc, "Negotiation Process & Interaction Dynamics")

        # §0 — method & sample note
        docx_build.para(
            doc,
            "Analytical sample = the 40 Prolific completers (4 balanced "
            "Mode x Role cells, n=10). Strictly exploratory; n=10/cell; p "
            "uncorrected; no pairwise post-hoc. Limitations: no private "
            "agent reasoning (thinking empty); reservation prices from the "
            "fixed Camry scenario brief (uniform across all 40); screen "
            "dwell from client telemetry. Derived process metrics are "
            "auditable via the per-pillar metric dictionaries.",
            italic=True)

        bf = metrics.bargaining_frame(con)
        tf = metrics.tempo_frame(con)
        of = metrics.orchestrator_frame(con)
        ux = metrics.ux_frame(con)
        hc = metrics.human_cadence(con)

        # §1 — Bargaining trajectory & strategy
        _pillar(
            doc, con, "1", "Bargaining trajectory & strategy",
            [(viz.fig_offer_paths, "Offer paths by session",
              "Price per priced proposal, faceted by cell; settlement "
              "marked; ZOPA band shown — exploratory"),
             (viz.fig_concession_box, "Concession size by cell",
              "Mean own-side concession, sessions with >=1 concession — "
              "exploratory"),
             (viz.fig_surplus_split, "Surplus split by cell",
              "Mean buyer/seller surplus share, in-ZOPA deals only — "
              "exploratory"),
             (viz.fig_settlement_zopa, "Settlement prices vs ZOPA",
              "Settlement price per deal vs the 22.5k-23.5k ZOPA band — "
              "exploratory"),
             (viz.fig_anchor_distance, "Opening anchor distance by cell",
              "|own opening - own target|; points = sessions — "
              "exploratory")],
            bf, _DV1, surplus_note=True)

        # §2 — Tempo, latency & token economy
        _pillar(
            doc, con, "2", "Tempo, latency & token economy",
            [(viz.fig_latency_emitter, "Per-turn latency by emitter x role",
              "Log-scale latency; human = think+type, participant = AI "
              "agent — exploratory"),
             (viz.fig_latency_arc, "Latency arc by turn number",
              "Median per-turn latency over turn number, by Mode — "
              "exploratory"),
             (viz.fig_tokens_cell, "Total tokens per session by cell",
              "Tokens per session with mean orchestrator share — "
              "exploratory")],
            tf, _DV2)

        # §3 — Orchestrator / referee behavior
        docx_build.h1(doc, "3. Orchestrator / referee behavior")
        md3 = metric_dictionary("3")
        docx_build.table(doc, md3,
                         "Table 3.0 — Metric dictionary (§3)",
                         "Hand-authored definitions so every derived "
                         "process metric is auditable.")
        _csv(md3, "sec3_metric_dictionary")
        for k, (fn, ftitle, note) in enumerate([
            (viz.fig_routing, "Orchestrator routing alternation by cell",
             "Share of turn handoffs that switch side — exploratory"),
            (viz.fig_declare_timing, "Outcome-declaration timing by cell",
             "Turn number at declare_outcome; points = sessions — "
             "exploratory"),
        ], start=1):
            path = fn(con)
            docx_build.figure(doc, path, f"Figure 3.{k} — {ftitle}",
                              f"{note} ({_CAPTION}).")
        desc3 = descriptives(of, _DV3)
        docx_build.table(doc, desc3,
                         "Table 3.1 — Per-cell medians (§3 DVs)",
                         f"Median per study cell ({_CAPTION}).")
        _csv(desc3, "sec3_descriptives")
        sb3 = stats_block(of, _DV3)
        docx_build.table(
            doc, sb3, "Table 3.2 — SRH / MW / KW stats (§3 DVs)",
            f"Scheirer-Ray-Hare 2x2 (Mode A, Role B, A x B), Mann-Whitney "
            f"for the Mode & Role contrasts (Cliff's delta + 95% two-"
            f"sample bootstrap CI on the Mode contrast), Kruskal-Wallis "
            f"across the 4 cells. {_CAPTION}; n=10/cell. p in [0,1] or "
            f"NaN.")
        _csv(sb3, "sec3_stats_block")
        ft = _fisher_table(of)
        docx_build.table(
            doc, ft, "Table 3.3 — Degraded-session rate (Fisher 2x2)",
            f"Binary `degraded` by the Mode and Role contrasts via "
            f"Fisher's exact test. {_CAPTION}; n=10/cell.")
        _csv(ft, "sec3_degraded_fisher")

        # §4 — Participant UX & engagement
        _pillar(
            doc, con, "4", "Participant UX & engagement",
            [(viz.fig_screen_dwell, "Mean dwell per study screen",
              "screen_exit.dwellMs by screen, completers — exploratory"),
             (viz.fig_engine_dwell, "Time on the live-negotiation screen",
              "Engine-screen dwell by cell; points = participants — "
              "exploratory"),
             (viz.fig_attention, "Attention drift by cell",
              "Mean idle time and tab-aways by cell — exploratory"),
             (viz.fig_listing_engagement, "Listing engagement by cell",
              "Mean thumbnail views and zoom opens per participant — "
              "exploratory"),
             (viz.fig_human_cadence, "Human composition cadence by role",
              "Mean compose time and char count, Human-to-AI only — "
              "exploratory")],
            ux, _DV4)

        hm = _human_mw_table(hc, ["mean_compose_s", "mean_charcount"])
        docx_build.table(
            doc, hm,
            "Table 4.3 — Human composition cadence (buyer vs seller MW)",
            f"Human-to-AI participants only (single mode -> no SRH/KW): "
            f"Mann-Whitney buyer vs seller with Cliff's delta + 95% "
            f"two-sample bootstrap CI. {_CAPTION}; n=10/cell.")
        _csv(hm, "sec4_human_cadence_mw")
        _csv(hc, "sec4_human_cadence_frame")

        # Closing — limitations & what this enables
        docx_build.h1(doc, "Limitations & what this enables")
        docx_build.para(
            doc,
            "Three standing limitations bound every reading above. (1) No "
            "private agent reasoning: turns.thinking is empty for all "
            "turns, so strategy is inferred only from the externalized "
            "proposal/message stream. (2) Reservation prices come from the "
            "fixed Camry scenario brief and are uniform across all 40 "
            "sessions, so surplus/ZOPA measures describe positioning within "
            "one fixed payoff structure, not preference variation. (3) "
            "Screen-dwell and attention metrics derive from client-side "
            "telemetry (participant_events). Accordingly, every AI-to-AI "
            "vs Human-to-AI process difference reported here is an "
            "exploratory signal at n=10/cell, not a confirmatory finding: "
            "p-values are uncorrected, there is no pairwise post-hoc, and "
            "effect sizes carry wide uncertainty. These dynamics map the "
            "process space and motivate powered follow-up; they do not "
            "establish it.",
            italic=True)

        OUT.parent.mkdir(parents=True, exist_ok=True)
        doc.save(OUT)
        print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
    finally:
        con.close()


if __name__ == "__main__":
    build()
