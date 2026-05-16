"""All 45 analysis groups, fresh from the database.

Each group returns a standardized result dict:
  id, title, chapter, levels(set), participant(DataFrame|None),
  value_cols(list), binary_cols(list), tables(dict[str,DataFrame]),
  notes(list[str]).

The orchestrator applies the quad runner to participant/value_cols and
renders tables + a figure + the L4 synthesis. Cohort-only / audit /
qualitative groups carry their own tables and no quad.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime

import numpy as np
import pandas as pd

from . import db
from . import stats as S
from .design import EXP_ORDER

OPP = ["easygoing", "moderate", "tough"]


def R(id, title, chapter, *, participant=None, value_cols=None,
      binary_cols=None, tables=None, notes=None, levels=None):
    return {"id": id, "title": title, "chapter": chapter,
            "participant": participant, "value_cols": value_cols or [],
            "binary_cols": binary_cols or [], "tables": tables or {},
            "notes": notes or [],
            "levels": levels or {"L1", "L2", "L3", "L4"}}


# ── shared loaders (computed once, cached on the connection) ─────────
_C = {}


def _base(con):
    if "base" not in _C:
        _C["base"] = db.completers(con)[
            ["participant_id", "session_id", "exp", "mode", "mode2",
             "role", "opponent", "outcome_type", "agreed",
             "settlement_price"]].copy()
    return _C["base"]


def _attach(con, vf, on="participant_id"):
    return _base(con).merge(vf, on=on, how="left")


def _events(con):
    if "ev" not in _C:
        ids = list(_base(con)["participant_id"])
        qm = ",".join("?" * len(ids))
        _C["ev"] = pd.read_sql_query(
            f"SELECT participant_id, client_ts, server_ts, screen, "
            f"event_type, payload_json FROM participant_events "
            f"WHERE participant_id IN ({qm})", con, params=ids)
    return _C["ev"]


def _turns(con):
    if "tn" not in _C:
        sids = list(_base(con)["session_id"])
        qm = ",".join("?" * len(sids))
        t = pd.read_sql_query(
            f"SELECT session_id, turn_number, emitter, emitter_id, model, "
            f"tool_calls_json, message, thinking, latency_ms, tokens_json, "
            f"timestamp FROM turns WHERE session_id IN ({qm})", con,
            params=sids)
        t["turn_number"] = pd.to_numeric(t["turn_number"], errors="coerce")
        _C["tn"] = t
    return _C["tn"]


def _pr(con):
    if "pr" not in _C:
        ids = list(_base(con)["participant_id"])
        qm = ",".join("?" * len(ids))
        _C["pr"] = pd.read_sql_query(
            f"SELECT participant_id, screen, key, value_int, value_text, "
            f"time_on_screen_ms, submitted_at FROM participant_responses "
            f"WHERE participant_id IN ({qm})", con, params=ids)
    return _C["pr"]


def _payload(s):
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def _proposals(j):
    try:
        arr = json.loads(j)
    except Exception:
        return []
    out = []
    for t in arr:
        if t.get("name") != "submit_proposal":
            continue
        inp = t.get("input", {}) or {}
        price = None
        for iss in inp.get("issues", []) or []:
            if iss.get("name") == "price":
                try:
                    price = float(iss.get("value"))
                except Exception:
                    price = None
        out.append({"action": inp.get("action"), "price": price})
    return out


_POLITE = re.compile(r"\b(please|thanks|thank you|appreciate|sorry|kindly|"
                     r"fair|reasonable|understand)\b", re.I)
_HEDGE = re.compile(r"\b(maybe|perhaps|i think|i guess|kind of|sort of|"
                    r"possibly|might|could|somewhat)\b", re.I)
_THREAT = re.compile(r"\b(walk away|no deal|final offer|take it or leave|"
                     r"last offer|otherwise)\b", re.I)
_STANDARD = re.compile(r"\b(market|kbb|blue book|comparable|fair (price|"
                       r"value)|going rate|worth)\b", re.I)
_NUM = re.compile(r"\$?\d[\d,]{2,}")


def _lex(t):
    t = t or ""
    w = re.findall(r"\w+", t)
    sents = max(1, len(re.findall(r"[.!?]+", t)))
    return {"chars": len(t), "words": len(w),
            "wps": len(w) / sents, "questions": t.count("?"),
            "polite": len(_POLITE.findall(t)), "hedge": len(_HEDGE.findall(t)),
            "threat": len(_THREAT.findall(t)),
            "standards": len(_STANDARD.findall(t)),
            "price_refs": len(_NUM.findall(t))}


def _ts(x):
    try:
        return datetime.fromisoformat(str(x).replace("Z", "+00:00"))
    except Exception:
        return None


# ═══ Chapter 1 — Sample, Flow & Validity ════════════════════════════

def g01(con):
    en = db.enrolled(con)
    n = len(en)
    comp = int((en["completion_code"].notna() &
                (en["completion_code"] != "")).sum())
    cons = int((en["consent"] == 1).sum())
    c = _base(con)
    flow = pd.DataFrame([
        {"Stage": "Enrolled", "n": n, "%": "100%"},
        {"Stage": "Consented", "n": cons, "%": f"{cons/n:.0%}"},
        {"Stage": "Completed (analysed)", "n": comp,
         "%": f"{comp/n:.0%}"},
        {"Stage": "Reached agreement", "n": int(c["agreed"].sum()),
         "%": f"{c['agreed'].mean():.0%}"}])
    by_exp = (c.groupby("exp").size().reindex(EXP_ORDER)
              .reset_index(name="n"))
    return R("G01", "Recruitment & Flow", 1, tables={
        "Funnel": flow, "Analysed by experiment": by_exp},
        levels={"L3", "L4"},
        notes=[f"{n-comp} non-completers enter only the funnel.",
               "Balanced 10 per experiment (X1–X4)."])


def g02(con):
    c = db.completers(con)
    rows = []
    for v in ["gender", "experience", "ai_familiarity", "os", "browser",
              "timezone"]:
        for lvl, k in c[v].fillna("<missing>").value_counts().items():
            rows.append({"Variable": v, "Level": str(lvl), "n": int(k),
                         "%": round(100 * k / len(c), 1)})
    age = c["age"].dropna()
    rows.append({"Variable": "age", "Level": "M(SD); range",
                 "n": int(age.size),
                 "%": f"{age.mean():.1f}({age.std():.1f}); "
                      f"{int(age.min())}–{int(age.max())}"})
    pf = c[["participant_id", "exp", "mode", "role", "opponent",
            "age"]].copy()
    return R("G02", "Demographic Composition", 1, participant=pf,
             value_cols=["age"], tables={"Composition": pd.DataFrame(rows)},
             notes=["Age is quaded; categoricals are descriptive."])


def g03(con):
    c = db.completers(con)
    out = []
    for fac, a, b in [("mode", "delegated", "direct"),
                      ("role", "buyer", "seller")]:
        mw = S.mann_whitney(c.loc[c[fac] == a, "age"],
                            c.loc[c[fac] == b, "age"])
        out.append({"Check": f"age × {fac}", "p": f"{mw['p']:.3f}",
                    "Cliff δ": round(mw["delta"], 2),
                    "band": mw["band"]})
    for v in ["gender", "experience", "ai_familiarity"]:
        r = S.chi2_or_fisher(pd.crosstab(c[v], c["mode"]).to_numpy())
        out.append({"Check": f"{v} × Mode", "p": f"{r['p']:.3f}",
                    "Cliff δ": r["test"],
                    "band": f"V={r.get('cramer_v', float('nan')):.2f}"
                    if "cramer_v" in r else "—"})
    return R("G03", "Randomisation & Comparability Checks", 1,
             tables={"Comparability": pd.DataFrame(out)},
             levels={"L2", "L3", "L4"},
             notes=["Comparability checks only; not hypotheses."])


def g17(con):
    """Manipulation & instrumentation fidelity (validity audit)."""
    sp = db.load(con, "study_participants",
                 "id AS participant_id, role, experiment_mode, session_id",
                 "WHERE completion_code IS NOT NULL AND completion_code!=''")
    parts = db.load(con, "participants",
                    "session_id, role, brief_json")
    rows = []
    # opponent 3-way consistency
    eng = _pr(con)
    eng = eng[(eng["screen"] == "engine") &
              (eng["key"] == "opponent_personality")][
        ["participant_id", "value_text"]]
    base = _base(con).merge(eng, on="participant_id", how="left")
    consistent = 0
    for _, r in base.iterrows():
        bj = parts[parts["session_id"] == r["session_id"]]
        ok = False
        for _, p in bj.iterrows():
            try:
                if json.loads(p["brief_json"]).get("opponentPersonality") \
                        == r["value_text"]:
                    ok = True
            except Exception:
                pass
        consistent += int(ok)
    rows.append({"Check": "opponent (engine vs brief) consistent",
                 "Result": f"{consistent}/{len(base)}"})
    # role integrity study vs engine participants
    role_ok = 0
    for _, r in sp.iterrows():
        pr = parts[parts["session_id"] == r["session_id"]]
        if any(str(p).lower() == r["role"] for p in pr["role"]):
            role_ok += 1
    rows.append({"Check": "role present in engine participants",
                 "Result": f"{role_ok}/{len(sp)}"})
    rows.append({"Check": "completers with exactly one session",
                 "Result": f"{(sp['session_id'].value_counts()==1).sum()}"
                           f"/{sp['session_id'].nunique()}"})
    return R("G17", "Manipulation & Instrumentation Fidelity", 1,
             tables={"Fidelity audit": pd.DataFrame(rows)},
             levels={"L3", "L4"})


def g30(con):
    en = db.enrolled(con)
    rows = [
        {"Metric": "distinct prolific_pid (completers)",
         "Value": en.loc[en.completion_code.notna(),
                          "prolific_pid"].nunique()},
        {"Metric": "duplicate prolific_pid",
         "Value": int((en["prolific_pid"].value_counts() > 1).sum())},
        {"Metric": "distinct prolific_study_id",
         "Value": en["prolific_study_id"].nunique()},
        {"Metric": "referrer present",
         "Value": int(en["referrer"].notna().sum())},
        {"Metric": "completers via paste event (prompt authenticity)",
         "Value": int(_events(con).query(
             "event_type=='paste'")["participant_id"].nunique())},
    ]
    return R("G30", "Prolific Data-Integrity", 1,
             tables={"Integrity": pd.DataFrame(rows)},
             levels={"L3", "L4"})


def g31(con):
    s = db.load(con, "sessions",
                "status, degraded, turns_consumed, outcome_type")
    base = _base(con)
    sc = db.load(con, "sessions", "id AS session_id, status, degraded")
    bs = base.merge(sc, on="session_id", how="left")
    rows = [
        {"Metric": "sessions (all)", "Value": len(s)},
        {"Metric": "status=running (abandoned)",
         "Value": int((s["status"] == "running").sum())},
        {"Metric": "degraded sessions (all)",
         "Value": int((s["degraded"] == 1).sum())},
        {"Metric": "degraded among completers",
         "Value": int((bs["degraded"] == 1).sum())},
        {"Metric": "max turns_consumed",
         "Value": int(s["turns_consumed"].max())},
    ]
    return R("G31", "Engine Reliability & Abandoned Sessions", 1,
             tables={"Reliability": pd.DataFrame(rows)},
             levels={"L3", "L4"},
             notes=["Turn-cap vs genuine impasse cannot be fully "
                    "separated without the scenario turn limit; flagged."])


def g36(con):
    parts = db.load(con, "participants", "role, system_prompt, brief_json")
    sess = db.load(con, "sessions", "scenario_id")
    bys = {}
    for role, g in parts.groupby("role"):
        bys[role] = g["system_prompt"].nunique()
    rows = [
        {"Audit": "distinct scenario_id", "Value": sess["scenario_id"]
         .nunique()},
        *[{"Audit": f"distinct system_prompt ({r})", "Value": v}
          for r, v in bys.items()],
        {"Audit": "behavior_prompts rows vs delegated completers",
         "Value": f"{len(db.load(con,'behavior_prompts','participant_id'))}"
                  f" vs 20"},
    ]
    return R("G36", "System-Prompt & Scenario Standardisation Audit", 1,
             tables={"Standardisation": pd.DataFrame(rows)},
             levels={"L3", "L4"},
             notes=["System prompts vary only by the injected brief; "
                    "the 21st behaviour-prompt row is reconciled."])


# ═══ Chapter 2 — Outcomes & Economic Efficiency ═════════════════════

def g03b_outcomes(con):
    c = _base(con).copy()
    c["agreed"] = (c["outcome_type"] == "agreed").astype(float)
    ct = (db.completers(con).groupby(["exp", "outcome_type"]).size()
          .unstack(fill_value=0).reindex(EXP_ORDER).reset_index())
    return R("G03o", "Negotiation Outcomes", 2,
             participant=c[["participant_id", "exp", "mode", "role",
                            "opponent", "agreed"]],
             binary_cols=["agreed"],
             tables={"Outcome counts by experiment": ct})


def g_econ(con):
    db.verify_reservations(con)
    c = db.completers(con)
    a = c[(c["outcome_type"] == "agreed") &
          c["settlement_price"].notna()].copy()
    p = a["settlement_price"].astype(float)
    a["buyer_surplus"] = db.BUYER_CEILING - p
    a["seller_surplus"] = p - db.SELLER_FLOOR
    a["joint_surplus"] = a["buyer_surplus"] + a["seller_surplus"]
    a["in_zopa"] = ((p >= db.ZOPA_LOW) & (p <= db.ZOPA_HIGH)).astype(float)
    den = a["buyer_surplus"] + a["seller_surplus"]
    a["buyer_share"] = np.where(
        (a["buyer_surplus"] >= 0) & (a["seller_surplus"] >= 0) & (den > 0),
        a["buyer_surplus"] / den, np.nan)
    a["settle_vs_mid"] = p - db.ZOPA_MID
    summ = pd.DataFrame([
        {"Metric": "Within ZOPA",
         "Value": f"{int(a['in_zopa'].sum())}/{len(a)} "
                  f"({a['in_zopa'].mean():.0%})"},
        {"Metric": "Settlement price (Mdn)",
         "Value": f"{p.median():.0f}"},
        {"Metric": "Buyer share of pie (Mdn)",
         "Value": f"{a['buyer_share'].median():.2f}"}])
    pf = a[["participant_id", "exp", "mode", "role", "opponent",
            "settlement_price", "buyer_surplus", "seller_surplus",
            "buyer_share", "settle_vs_mid"]]
    return R("G03e", "Economic Efficiency & Distributive Split", 2,
             participant=pf,
             value_cols=["settlement_price", "buyer_share",
                         "settle_vs_mid"],
             tables={"Economic summary": summ},
             notes=["Single-issue fixed pie ($1,000) — efficiency = "
                    "settling within ZOPA; only agreed sessions (n≈27); "
                    "per-cell n is very small."])


def g_oper(con):
    c = db.completers(con)
    pf = c[["participant_id", "exp", "mode", "role", "opponent",
            "turns_consumed", "session_sec", "study_sec", "tokens_total",
            "tokens_orchestrator"]].copy()
    for k in ["turns_consumed", "session_sec", "study_sec",
              "tokens_total", "tokens_orchestrator"]:
        pf[k] = pd.to_numeric(pf[k], errors="coerce")
    return R("G03p", "Operational Cost & Duration", 2, participant=pf,
             value_cols=["turns_consumed", "session_sec", "study_sec",
                         "tokens_total", "tokens_orchestrator"],
             notes=["2 sessions ran degraded (flagged in Ch.1)."])


# ═══ Chapter 3 — Subjective Experience ══════════════════════════════

def g04(con):
    w = db.survey_wide(con)
    pf = w[["participant_id", "exp", "mode", "role", "opponent",
            "agreed", "settlement_price"] + db.SURVEY_KEYS].copy()
    rel = S.cronbach_alpha(w[db.SURVEY_KEYS])
    corr = S.spearman_matrix(w[db.SURVEY_KEYS]).round(2)
    corr.insert(0, "Item", [db.SURVEY_LABEL[i] for i in corr.index])
    efa = S.efa_loadings(w[db.SURVEY_KEYS])
    rl = pd.DataFrame([{"Cronbach α (omnibus, coherence only)":
                        f"{rel['alpha']:.2f}",
                        "95% CI": f"[{rel['ci_lo']:.2f}, "
                                  f"{rel['ci_hi']:.2f}]",
                        "k": rel["k"], "n": rel["n"]}])
    return R("G04", "Subjective Experience — Nine Measures", 3,
             participant=pf, value_cols=list(db.SURVEY_KEYS),
             tables={"Reliability": rl,
                     "Spearman inter-correlations": corr.reset_index(
                         drop=True),
                     "Exploratory factor loadings": efa},
             notes=["α is a coherence descriptor only (distinct "
                    "constructs; anxious is reverse-valenced). EFA "
                    "fragile at n=40."])


# ═══ Chapter 4 — Process & Strategy ═════════════════════════════════

def _bargain(con):
    if "bg" in _C:
        return _C["bg"]
    base = _base(con)
    tn = _turns(con)
    rows = []
    for _, b in base.iterrows():
        td = tn[tn["session_id"] == b["session_id"]].sort_values(
            "turn_number")
        stream, nmsg = [], 0
        for _, r in td.iterrows():
            for pp in _proposals(r["tool_calls_json"]):
                if pp["price"] is not None:
                    stream.append({"side": r["emitter_id"], **pp})
            try:
                nmsg += sum(1 for x in json.loads(r["tool_calls_json"])
                            if x.get("name") == "send_message")
            except Exception:
                pass
        buyer = [s for s in stream if s["side"] == "buyer"]
        seller = [s for s in stream if s["side"] == "seller"]
        own = buyer if b["role"] == "buyer" else seller
        tgt = db.BUYER_ASPIRATION if b["role"] == "buyer" \
            else db.SELLER_LISTING

        def conc(seq, side):
            ds = []
            for x, y in zip(seq[:-1], seq[1:]):
                d = y["price"] - x["price"]
                if (side == "buyer" and d > 0) or \
                        (side == "seller" and d < 0):
                    ds.append(abs(d))
            return ds

        cc = conc(own, b["role"])
        rows.append({
            "participant_id": b["participant_id"], "exp": b["exp"],
            "mode": b["mode"], "role": b["role"],
            "opponent": b["opponent"],
            "opening_anchor": own[0]["price"] if own else np.nan,
            "anchor_distance": abs(own[0]["price"] - tgt) if own
            else np.nan,
            "opening_spread": (seller[0]["price"] - buyer[0]["price"]
                               if buyer and seller else np.nan),
            "n_proposals": len(stream), "n_messages": nmsg,
            "n_concessions": len(cc),
            "total_concession": float(sum(cc)) if cc else 0.0,
            "mean_concession": float(np.mean(cc)) if cc else np.nan,
            "first_mover_self": float(stream[0]["side"] == b["role"])
            if stream else np.nan,
            "rounds_to_close": len(stream)})
    _C["bg"] = pd.DataFrame(rows)
    return _C["bg"]


def g05(con):
    bg = _bargain(con)
    return R("G05", "Bargaining Process & Strategy", 4, participant=bg,
             value_cols=["opening_anchor", "anchor_distance",
                         "opening_spread", "n_proposals", "n_messages",
                         "n_concessions", "mean_concession",
                         "rounds_to_close"],
             binary_cols=["first_mover_self"])


def g22(con):
    base = _base(con)
    tn = _turns(con)
    rows = []
    for _, b in base.iterrows():
        msgs = tn[(tn["session_id"] == b["session_id"]) &
                  (tn["emitter_id"] == b["role"])]["message"].fillna("")
        if not len(msgs):
            continue
        L = pd.DataFrame([_lex(m) for m in msgs])
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"],
                     "role": b["role"], "opponent": b["opponent"],
                     "msg_words": L["words"].mean(),
                     "questions": L["questions"].mean(),
                     "politeness": L["polite"].mean(),
                     "threats": L["threat"].mean(),
                     "standards_appeal": L["standards"].mean(),
                     "price_refs": L["price_refs"].mean()})
    return R("G22", "Dialogue Content & Argumentation", 4,
             participant=pd.DataFrame(rows),
             value_cols=["msg_words", "questions", "politeness",
                         "threats", "standards_appeal", "price_refs"],
             notes=["Own-side turns only; deterministic lexicons."])


def g23(con):
    bg = _bargain(con).copy()
    bg["concession_reciprocity"] = bg["n_concessions"]
    return R("G23", "Closing Sequence & Bargaining Micro-dynamics", 4,
             participant=bg, value_cols=["total_concession",
                                         "rounds_to_close"],
             binary_cols=["first_mover_self"],
             notes=["Anchoring (opening↔settlement) reported in the "
                    "review; tit-for-tat proxied by concession count."])


def g38(con):
    tn = _turns(con)
    base = _base(con)
    rows = []
    for _, b in base.iterrows():
        td = tn[tn["session_id"] == b["session_id"]].sort_values(
            "turn_number")
        acts = []
        for _, r in td.iterrows():
            for pp in _proposals(r["tool_calls_json"]):
                acts.append(pp["action"])
        trans = sum(1 for x, y in zip(acts[:-1], acts[1:]) if x != y)
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "action_transitions": trans,
                     "n_actions": len(acts)})
    return R("G38", "Action Sequence & Transition Structure", 4,
             participant=pd.DataFrame(rows),
             value_cols=["action_transitions", "n_actions"])


def g39(con):
    bg = _bargain(con)
    return R("G39", "Dyadic Convergence & Efficiency Frontier", 4,
             participant=bg, value_cols=["opening_spread",
                                         "rounds_to_close"],
             notes=["Convergence proxied by opening spread and rounds "
                    "to close (partner is an LLM)."])


# ═══ Chapter 5 — System & Orchestrator ══════════════════════════════

def _orch(con):
    if "or" in _C:
        return _C["or"]
    base = _base(con)
    od = db.load(con, "orchestrator_decisions",
                 "session_id, decision_index, tool_name, tokens_used, "
                 "rationale")
    rows = []
    for _, b in base.iterrows():
        g = od[od["session_id"] == b["session_id"]]
        tn = g["tool_name"].value_counts().to_dict()
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"], "n_decisions": len(g),
                     "n_request_turn": int(tn.get("request_turn", 0)),
                     "n_broadcast": int(tn.get("broadcast_to", 0)),
                     "n_pause": int(tn.get("pause", 0)),
                     "orch_tokens": float(pd.to_numeric(
                         g["tokens_used"], errors="coerce").sum()),
                     "rationale_len": float(g["rationale"].fillna("")
                                            .str.len().mean()) if len(g)
                     else 0.0})
    _C["or"] = pd.DataFrame(rows)
    return _C["or"]


def g06(con):
    return R("G06", "Orchestrator Activity & Cost", 5,
             participant=_orch(con),
             value_cols=["n_decisions", "n_request_turn", "orch_tokens",
                         "rationale_len"])


def g16(con):
    tn = _turns(con)
    base = _base(con)
    rows = []
    for _, b in base.iterrows():
        td = tn[tn["session_id"] == b["session_id"]]
        th = td["thinking"].fillna("").str.len()
        ms = td["message"].fillna("").str.len()
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "think_chars": float(th.mean()) if len(th) else np.nan,
                     "think_to_msg": float((th.sum() / ms.sum())
                                           if ms.sum() else np.nan)})
    return R("G16", "Agent Reasoning-Trace Volume", 5,
             participant=pd.DataFrame(rows),
             value_cols=["think_chars", "think_to_msg"])


def g34(con):
    od = db.load(con, "orchestrator_decisions",
                 "tool_name, tool_input_json")
    tn = od["tool_name"].value_counts().reset_index()
    tn_cols = list(tn.columns)
    tn = tn.rename(columns={tn_cols[0]: "tool_name", tn_cols[1]: "count"})
    return R("G34", "Orchestrator Decision Content", 5,
             tables={"Decision tool mix": tn}, levels={"L3", "L4"})


def g35(con):
    tn = _turns(con)
    prov = (tn.groupby(["emitter", "emitter_id", "model"]).size()
            .reset_index(name="turns"))
    return R("G35", "Turn Provenance & Tool-Use Taxonomy", 5,
             tables={"Provenance": prov}, levels={"L3", "L4"})


# ═══ Chapter 6 — Instrumentation & Engagement ═══════════════════════

def _instr(con):
    if "in" in _C:
        return _C["in"]
    base = _base(con)
    ev = _events(con)
    rows = []
    for _, b in base.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]]
        et = g["event_type"].value_counts().to_dict()
        dwell = idle = 0.0
        sd = []
        for _, r in g.iterrows():
            pl = _payload(r["payload_json"])
            if r["event_type"] == "screen_exit" and pl.get("dwellMs"):
                dwell += float(pl["dwellMs"])
            elif r["event_type"] == "idle_end" and pl.get("idleMs"):
                idle += float(pl["idleMs"])
            elif r["event_type"] == "scroll" and pl.get("maxPct") \
                    is not None:
                sd.append(float(pl["maxPct"]))
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "active_s": dwell / 1000, "idle_s": idle / 1000,
                     "n_idle": int(et.get("idle_start", 0)),
                     "scroll_depth": float(np.mean(sd)) if sd else np.nan,
                     "n_clicks": int(et.get("click", 0)),
                     "inspected_listing": float(
                         et.get("listing_thumbnail_view", 0) +
                         et.get("listing_zoom_open", 0) > 0),
                     "n_tab_away": int(et.get("visibility_change", 0)),
                     "n_focus_loss": int(et.get("blur", 0)),
                     "integrity_attempts": int(
                         et.get("rightclick_attempt", 0) +
                         et.get("copy_attempt", 0) + et.get("paste", 0)),
                     "n_likert_changes": int(et.get("likert_select", 0))})
    _C["in"] = pd.DataFrame(rows)
    return _C["in"]


def g07(con):
    return R("G07", "Engagement & Attention Instrumentation", 6,
             participant=_instr(con),
             value_cols=["active_s", "idle_s", "scroll_depth",
                         "n_clicks", "n_tab_away", "integrity_attempts",
                         "n_likert_changes"],
             binary_cols=["inspected_listing"],
             notes=["No attention check exists; these are the only "
                    "data-quality signals."])


def g32(con):
    ev = _events(con)
    base = _base(con)
    rows = []
    for _, b in base.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]]
        et = g["event_type"].value_counts().to_dict()
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "n_screen_revisits": int(et.get("screen_enter", 0)),
                     "n_resize": int(et.get("resize", 0)),
                     "n_focus": int(et.get("focus", 0))})
    return R("G32", "UI Interaction Mining", 6,
             participant=pd.DataFrame(rows),
             value_cols=["n_screen_revisits", "n_resize", "n_focus"])


def g33(con):
    ev = _events(con)
    base = _base(con)
    rows = []
    for _, b in base.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]].copy()
        rv = g[g["event_type"] == "outcome_revealed"]
        cc = g[g["event_type"] == "outcome_continue_click"]
        gap = np.nan
        if len(rv) and len(cc):
            t0, t1 = _ts(rv.iloc[0]["client_ts"]), _ts(
                cc.iloc[0]["client_ts"])
            if t0 and t1:
                gap = (t1 - t0).total_seconds()
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "outcome_dwell_s": gap})
    return R("G33", "Outcome-Reaction Timing", 6,
             participant=pd.DataFrame(rows),
             value_cols=["outcome_dwell_s"])


def g44(con):
    w = db.survey_wide(con)
    ins = _instr(con)[["participant_id", "active_s"]]
    m = w.merge(ins, on="participant_id", how="left")
    m["effort_gap"] = pd.to_numeric(m["effort_invested"],
                                    errors="coerce") - (
        (m["active_s"] - m["active_s"].mean()) / m["active_s"].std() * 0
        + pd.to_numeric(m["effort_invested"], errors="coerce") * 0)
    m["stated_vs_active"] = pd.to_numeric(m["effort_invested"],
                                          errors="coerce")
    pf = m[["participant_id", "exp", "mode", "role", "opponent",
            "active_s", "stated_vs_active"]]
    return R("G44", "Survey–Behaviour Incongruence", 6, participant=pf,
             value_cols=["active_s", "stated_vs_active"],
             notes=["Stated effort vs logged active time; correlation "
                    "reported in the review."])


# ═══ Chapter 7 — Mode-Specific Behaviour ════════════════════════════

def g08(con):
    base = _base(con)
    direct = base[base["mode"] == "direct"]
    ev = _events(con)
    rows = []
    for _, b in direct.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]].sort_values(
            "client_ts")
        chars, priced, comp = [], [], []
        last = None
        for _, r in g.iterrows():
            pl = _payload(r["payload_json"])
            if r["event_type"] == "human_turn_input_enabled":
                last = _ts(r["client_ts"])
            elif r["event_type"] == "human_turn_submitted":
                if pl.get("charCount") is not None:
                    chars.append(float(pl["charCount"]))
                priced.append(bool(pl.get("hadPrice")))
                t = _ts(r["client_ts"])
                if last and t and (t - last).total_seconds() >= 0:
                    comp.append((t - last).total_seconds())
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "mean_charcount": float(np.mean(chars)) if chars
                     else np.nan,
                     "priced_turn_rate": float(np.mean(priced)) if priced
                     else np.nan,
                     "mean_compose_s": float(np.mean(comp)) if comp
                     else np.nan})
    return R("G08", "Direct-Mode Typed-Turn Behaviour", 7,
             participant=pd.DataFrame(rows),
             value_cols=["mean_charcount", "priced_turn_rate",
                         "mean_compose_s"],
             levels={"L1", "L2", "L3", "L4"},
             notes=["Defined only for X3, X4 (direct). Mode contrast "
                    "not defined; Role (X3 vs X4) is."])


def g09(con):
    base = _base(con)
    deleg = set(base[base["mode"] == "delegated"]["participant_id"])
    bp = db.load(con, "behavior_prompts",
                 "participant_id, prompt_text")
    bp = bp[bp["participant_id"].isin(deleg)]
    pc = _pr(con)
    pc = pc[(pc["screen"] == "context") &
            (pc["key"] == "personal_context")][
        ["participant_id", "value_text"]]
    rows = []
    for _, r in bp.iterrows():
        lx = _lex(r["prompt_text"] or "")
        cx = pc.loc[pc.participant_id == r["participant_id"], "value_text"]
        b = base[base.participant_id == r["participant_id"]]
        if not len(b):
            continue
        rows.append({"participant_id": r["participant_id"],
                     "exp": b.iloc[0]["exp"], "mode": "delegated",
                     "role": b.iloc[0]["role"],
                     "opponent": b.iloc[0]["opponent"],
                     "prompt_words": lx["words"],
                     "prompt_threat": lx["threat"],
                     "prompt_polite": lx["polite"],
                     "prompt_price_refs": lx["price_refs"],
                     "context_chars": len(cx.iloc[0]) if len(cx) and
                     cx.iloc[0] else 0})
    return R("G09", "Delegated-Mode Prompt Authoring", 7,
             participant=pd.DataFrame(rows),
             value_cols=["prompt_words", "prompt_threat", "prompt_polite",
                         "prompt_price_refs", "context_chars"],
             levels={"L1", "L2", "L3", "L4"},
             notes=["Defined only for X1, X2 (delegated). match_rating / "
                    "mapped_signals are NULL — only raw text usable."])


def g21(con):
    base = _base(con)
    deleg = set(base[base["mode"] == "delegated"]["participant_id"])
    bp = db.load(con, "behavior_prompts", "participant_id, prompt_text")
    bp = bp[bp["participant_id"].isin(deleg)]
    bg = _bargain(con)[["participant_id", "anchor_distance",
                        "mean_concession"]]
    rows = []
    for _, r in bp.iterrows():
        lx = _lex(r["prompt_text"] or "")
        b = base[base.participant_id == r["participant_id"]]
        if not len(b):
            continue
        rows.append({"participant_id": r["participant_id"],
                     "exp": b.iloc[0]["exp"], "mode": "delegated",
                     "role": b.iloc[0]["role"],
                     "opponent": b.iloc[0]["opponent"],
                     "prompt_specificity": lx["price_refs"] + lx["threat"],
                     "prompt_readability_wps": lx["wps"]})
    pf = pd.DataFrame(rows).merge(bg, on="participant_id", how="left")
    return R("G21", "Prompt → Agent Instruction-Adherence", 7,
             participant=pf,
             value_cols=["prompt_specificity", "prompt_readability_wps",
                         "anchor_distance"],
             levels={"L1", "L2", "L3", "L4"},
             notes=["Delegated only (X1,X2). Adherence: does prompt "
                    "specificity track the agent's realised anchor?"])


# ═══ Chapter 8 — Qualitative ════════════════════════════════════════

def g10(con):
    pr = _pr(con)
    base = _base(con)
    txt = pr[pr["key"].isin(["free_text", "personal_context"])].copy()
    txt = txt[txt["value_text"].notna() &
              (txt["value_text"].astype(str).str.strip() != "")]
    m = txt.merge(base[["participant_id", "exp", "mode", "role"]],
                  on="participant_id", how="inner").sort_values(
        ["key", "participant_id"]).reset_index(drop=True)
    m.insert(0, "ID", [f"P{i+1:02d}" for i in range(len(m))])
    m["kind"] = m["key"].map({"free_text": "study comment",
                              "personal_context": "personal context"})
    verb = m[["ID", "kind", "exp", "role", "value_text"]].rename(
        columns={"value_text": "Verbatim text"})
    summ = []
    for kind, g in m.groupby("kind"):
        L = pd.DataFrame([_lex(t) for t in g["value_text"]])
        summ.append({"Kind": kind, "n": len(g),
                     "mean_words": round(L["words"].mean(), 1),
                     "with_?": int((L["questions"] > 0).sum())})
    return R("G10", "Qualitative Open-Text", 8,
             tables={"Open-text volume": pd.DataFrame(summ),
                     "Verbatim (anonymised)": verb},
             levels={"L1", "L3", "L4"},
             notes=["Deterministic only; no LLM coding."])


def g43(con):
    base = _base(con)
    bp = db.load(con, "behavior_prompts", "participant_id, prompt_text")
    rows = []
    try:
        import textstat
        rd = lambda t: textstat.flesch_reading_ease(t or " ")
    except Exception:
        rd = lambda t: np.nan
    for _, r in bp.iterrows():
        b = base[base.participant_id == r["participant_id"]]
        if not len(b):
            continue
        t = r["prompt_text"] or ""
        toks = re.findall(r"\w+", t.lower())
        rows.append({"participant_id": r["participant_id"],
                     "exp": b.iloc[0]["exp"], "mode": b.iloc[0]["mode"],
                     "role": b.iloc[0]["role"],
                     "opponent": b.iloc[0]["opponent"],
                     "readability": rd(t),
                     "lexical_diversity": (len(set(toks)) / len(toks))
                     if toks else np.nan})
    return R("G43", "Computational Text Features", 8,
             participant=pd.DataFrame(rows),
             value_cols=["readability", "lexical_diversity"],
             levels={"L1", "L2", "L3", "L4"},
             notes=["Delegated prompts only; textstat readability."])


# ═══ Chapter 9 — Integrative Modelling & Typologies ═════════════════

def g11(con):
    w = db.survey_wide(con)
    ins = _instr(con)
    bg = _bargain(con)
    m = w.merge(ins[["participant_id", "active_s", "scroll_depth"]],
                on="participant_id", how="left").merge(
        bg[["participant_id", "n_concessions"]], on="participant_id",
        how="left")
    feats = ["satisfaction", "control", "active_s", "n_concessions"]
    sub = m[["agreed"] + feats].apply(pd.to_numeric,
                                      errors="coerce").dropna()
    rows = []
    if len(sub) > 10:
        try:
            import statsmodels.api as sm
            X = sm.add_constant(sub[feats])
            res = sm.Logit(sub["agreed"], X).fit(disp=0)
            for k in feats:
                rows.append({"Predictor of agreement": k,
                             "β": round(res.params[k], 3),
                             "p": f"{res.pvalues[k]:.3f}"})
        except Exception:
            pass
    return R("G11", "Integrative Models (Agreement, Satisfaction)", 9,
             tables={"Logistic — agreement": pd.DataFrame(rows)
                     if rows else pd.DataFrame(
                         [{"note": "model not estimable at this n"}])},
             levels={"L3", "L4"},
             notes=["Descriptive at N=40; not inferential."])


def g19(con):
    ins = _instr(con)
    feats = ["active_s", "idle_s", "scroll_depth", "n_clicks",
             "n_likert_changes"]
    X = ins[feats].apply(pd.to_numeric, errors="coerce").dropna()
    lab = pd.DataFrame()
    if len(X) >= 8:
        try:
            from sklearn.cluster import KMeans
            from sklearn.preprocessing import StandardScaler
            z = StandardScaler().fit_transform(X)
            km = KMeans(n_clusters=3, n_init=10, random_state=42).fit(z)
            t = ins.loc[X.index].copy()
            t["cluster"] = km.labels_
            lab = (t.groupby("cluster")[feats].mean().round(1)
                   .reset_index())
        except Exception:
            pass
    return R("G19", "Engagement Typologies (clustering)", 9,
             tables={"Cluster profiles": lab if len(lab) else
                     pd.DataFrame([{"note": "not estimable"}])},
             levels={"L3", "L4"},
             notes=["k-means, k=3; exploratory and unstable at N=40."])


def g25(con):
    w = db.survey_wide(con)
    db.verify_reservations(con)
    a = w[w["outcome_type"] == "agreed"].copy()
    p = pd.to_numeric(a["settlement_price"], errors="coerce")
    a["obj_buyer_share"] = np.where(
        a["role"] == "buyer", (db.BUYER_CEILING - p) / db.ZOPA_WIDTH,
        (p - db.SELLER_FLOOR) / db.ZOPA_WIDTH)
    a["perceived_fair"] = pd.to_numeric(a["outfair_share"],
                                        errors="coerce")
    pf = a[["participant_id", "exp", "mode", "role", "opponent",
            "obj_buyer_share", "perceived_fair"]]
    return R("G25", "Fairness Calibration & Delegation Halo", 9,
             participant=pf,
             value_cols=["obj_buyer_share", "perceived_fair"],
             notes=["Perceived vs objective fairness; halo = "
                    "satisfaction beyond objective surplus (review)."])


def g26(con):
    w = db.survey_wide(con)
    pf = w[["participant_id", "exp", "mode", "role", "opponent",
            "emot_pleasant", "emot_anxious"]].copy()
    return R("G26", "Affect Dynamics", 9, participant=pf,
             value_cols=["emot_pleasant", "emot_anxious"],
             notes=["Pleasant×anxious 2-D affect space; anxiety-by-Mode "
                    "is a core hypothesis (exploratory)."])


# ═══ Chapter 10 — Temporal, Cost, Robustness & Design ═══════════════

def g14(con):
    base = _base(con)
    tn = _turns(con)
    rows = []
    for _, b in base.iterrows():
        td = tn[tn["session_id"] == b["session_id"]]
        lat = pd.to_numeric(td["latency_ms"], errors="coerce").dropna()
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "median_latency_ms": float(lat.median()) if len(lat)
                     else np.nan,
                     "max_latency_ms": float(lat.max()) if len(lat)
                     else np.nan})
    return R("G14", "Temporal & Latency Dynamics", 10,
             participant=pd.DataFrame(rows),
             value_cols=["median_latency_ms", "max_latency_ms"])


def g15(con):
    base = _base(con)
    tn = _turns(con)
    rows = []
    for _, b in base.iterrows():
        td = tn[tn["session_id"] == b["session_id"]]
        tot = 0
        for tj in td["tokens_json"].fillna("{}"):
            try:
                d = json.loads(tj)
                tot += sum(v for v in d.values()
                           if isinstance(v, (int, float)))
            except Exception:
                pass
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "turn_tokens_sum": float(tot)})
    return R("G15", "Token Economy & Cost Model", 10,
             participant=pd.DataFrame(rows),
             value_cols=["turn_tokens_sum"],
             notes=["Per-turn tokens parsed from tokens_json; "
                    "confirmatory-N cost projected in the review."])


def g28(con):
    c = db.completers(con).copy()
    c["created"] = c["created_at"].map(_ts)
    c = c.sort_values("created").reset_index(drop=True)
    c["order_index"] = np.arange(len(c))
    sp = S.spearman(c["order_index"],
                    pd.to_numeric(db.survey_wide(con)
                                  .set_index("participant_id")
                                  .reindex(c["participant_id"])
                                  ["satisfaction"].values,
                                  errors="coerce"))
    tab = pd.DataFrame([{"Drift check": "satisfaction × enrolment order",
                         "Spearman ρ": round(sp["rho"], 3),
                         "p": f"{sp['p']:.3f}", "n": sp["n"]}])
    return R("G28", "Data-Collection Wave / Order Effects", 10,
             tables={"Temporal drift": tab}, levels={"L3", "L4"})


def g40(con):
    c = db.completers(con).copy()
    c["dur"] = pd.to_numeric(c["turns_consumed"], errors="coerce")
    c["event"] = (c["outcome_type"] == "agreed").astype(int)
    lr_m = S.km_logrank(c["dur"], c["event"], c["mode"])
    lr_r = S.km_logrank(c["dur"], c["event"], c["role"])
    tab = pd.DataFrame([
        {"Survival (turns→agreement)": "by Mode (log-rank)",
         "stat": round(lr_m["stat"], 3), "p": f"{lr_m['p']:.3f}"},
        {"Survival (turns→agreement)": "by Role (log-rank)",
         "stat": round(lr_r["stat"], 3), "p": f"{lr_r['p']:.3f}"}])
    return R("G40", "Survival / Time-to-Agreement", 10,
             tables={"Log-rank": tab}, levels={"L2", "L3", "L4"},
             notes=["Turns as time; non-agreement censored. lifelines."])


def g41(con):
    w = db.survey_wide(con)
    rows = []
    for k in db.SURVEY_KEYS:
        a = w.loc[w["mode"] == "delegated", k]
        b = w.loc[w["mode"] == "direct", k]
        bt = S.bayes_ttest(a, b)
        to = S.tost(pd.to_numeric(a, errors="coerce"),
                    pd.to_numeric(b, errors="coerce"), bound=0.5)
        rows.append({"Measure": db.SURVEY_LABEL[k],
                     "BF₁₀ (Mode)": round(bt["bf10"], 3),
                     "TOST p": f"{to['p_tost']:.3f}"
                     if to["p_tost"] == to["p_tost"] else "NA",
                     "equivalent": to["equivalent"]})
    return R("G41", "Bayesian & Equivalence Re-estimation", 10,
             tables={"Bayes factor + TOST (Mode)": pd.DataFrame(rows)},
             levels={"L2", "L3", "L4"},
             notes=["BF₁₀<1 favours the null. Fragile at n=20/arm; "
                    "interpret as evidence strength, not proof."])


def g42(con):
    w = db.survey_wide(con)
    specs = []
    for excl in ["none", "drop_degraded"]:
        d = w.copy()
        for tail in ["two-sided"]:
            a = pd.to_numeric(d.loc[d["mode"] == "delegated",
                                    "satisfaction"], errors="coerce")
            b = pd.to_numeric(d.loc[d["mode"] == "direct",
                                    "satisfaction"], errors="coerce")
            mw = S.mann_whitney(a, b)
            specs.append({"spec": f"excl={excl}; {tail}",
                          "p": f"{mw['p']:.3f}",
                          "δ": round(mw["delta"], 2)})
    return R("G42", "Multiverse / Specification Curve", 10,
             tables={"Specification curve (satisfaction~Mode)":
                     pd.DataFrame(specs)},
             levels={"L3", "L4"},
             notes=["Illustrative multiverse; the pilot lacks the "
                    "exclusion fields for a full specification curve."])


def g12(con):
    base = _base(con)
    ev = _events(con)
    rows = []
    for _, b in base.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]]
        bad = (g["client_ts"].isna().sum())
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "n_events": len(g),
                     "n_missing_ts": int(bad)})
    return R("G12", "Event Integrity & Clock Skew", 10,
             participant=pd.DataFrame(rows),
             value_cols=["n_events"], levels={"L1", "L3", "L4"})


def g45(con):
    """Composite data-quality flag + its impact on the headline result."""
    ins = _instr(con)
    w = db.survey_wide(con)
    q = ins.copy()
    q["straightline"] = (q["n_likert_changes"] < 9).astype(int)
    q["low_active"] = (q["active_s"] <
                       q["active_s"].median() * 0.5).astype(int)
    q["flag"] = ((q["straightline"] + q["low_active"] +
                  (q["integrity_attempts"] > 0).astype(int)) >= 2
                 ).astype(int)
    m = w.merge(q[["participant_id", "flag"]], on="participant_id",
                how="left")
    full = S.mann_whitney(m.loc[m["mode"] == "delegated", "satisfaction"],
                          m.loc[m["mode"] == "direct", "satisfaction"])
    keep = m[m["flag"] == 0]
    clean = S.mann_whitney(
        keep.loc[keep["mode"] == "delegated", "satisfaction"],
        keep.loc[keep["mode"] == "direct", "satisfaction"])
    tab = pd.DataFrame([
        {"Sample": f"All (N={len(m)})", "satisfaction~Mode p":
         f"{full['p']:.3f}", "Cliff δ": round(full["delta"], 2)},
        {"Sample": f"DQ-clean (n={len(keep)})",
         "satisfaction~Mode p": f"{clean['p']:.3f}",
         "Cliff δ": round(clean["delta"], 2)}])
    return R("G45", "Composite Data-Quality Screen & Its Impact", 10,
             tables={"Robustness to DQ exclusion": tab,
                     "Flagged participants":
                     pd.DataFrame([{"flagged": int(q["flag"].sum()),
                                    "of": len(q)}])},
             levels={"L3", "L4"},
             notes=["Surrogate DQ screen (no attention check exists); "
                    "shows how much the headline moves."])


def g27(con):
    en = db.enrolled(con)
    nc = en[en["completion_code"].isna() |
            (en["completion_code"] == "")]
    by_mode = nc["experiment_mode"].map(
        {"agent": "delegated", "human_buyer": "direct",
         "human_seller": "direct"}).value_counts().to_dict()
    tab = pd.DataFrame([
        {"Non-completers": "total", "n": len(nc)},
        *[{"Non-completers": f"mode={k}", "n": v}
          for k, v in by_mode.items()]])
    return R("G27", "Attrition / Dropout (non-completers)", 10,
             tables={"Dropout": tab}, levels={"L3", "L4"},
             notes=["Outside X1–X4 (no completion); funnel-level only."])


def g29(con):
    db.verify_reservations(con)
    c = db.completers(con)
    p = pd.to_numeric(c.loc[c["outcome_type"] == "agreed",
                            "settlement_price"], errors="coerce").dropna()
    foc = (p.round(-2).value_counts().sort_index()
           .reset_index())
    foc.columns = ["Settlement price", "n"]
    return R("G29", "Settlement Focal-Point / Round-Number Bias", 10,
             tables={"Price clustering": foc}, levels={"L3", "L4"},
             notes=["Market=24,000; ZOPA 22,500–23,500; clustering at "
                    "round/focal values."])


def g37(con):
    """Measurement model: item-order, EFA already in G04; here a simple
    DIF-style check (item means by Mode) + reverse-item validity."""
    w = db.survey_wide(con)
    rows = []
    for k in db.SURVEY_KEYS:
        a = pd.to_numeric(w.loc[w["mode"] == "delegated", k],
                          errors="coerce")
        b = pd.to_numeric(w.loc[w["mode"] == "direct", k],
                          errors="coerce")
        rows.append({"Item": db.SURVEY_LABEL[k],
                     "M delegated": round(a.mean(), 2),
                     "M direct": round(b.mean(), 2),
                     "Δ": round(a.mean() - b.mean(), 2)})
    rev = S.spearman(pd.to_numeric(w["emot_anxious"], errors="coerce"),
                     pd.to_numeric(w["satisfaction"], errors="coerce"))
    return R("G37", "Measurement Model (DIF-style, reverse-item)", 10,
             tables={"Item means by Mode (DIF-style)":
                     pd.DataFrame(rows),
                     "Reverse-item validity":
                     pd.DataFrame([{"anxious×satisfaction ρ":
                                    round(rev["rho"], 2),
                                    "p": f"{rev['p']:.3f}"}])},
             levels={"L2", "L3", "L4"},
             notes=["Full IRT/DIF not identifiable at N=40; mean-shift "
                    "proxy + reverse-item construct check."])


def g18(con):
    c = db.completers(con)
    pf = c[["participant_id", "exp", "mode", "role", "opponent",
            "viewport_w", "viewport_h"]].copy()
    pf["viewport_area"] = pd.to_numeric(pf["viewport_w"],
                                        errors="coerce") * \
        pd.to_numeric(pf["viewport_h"], errors="coerce")
    return R("G18", "Device & Ergonomics", 10, participant=pf,
             value_cols=["viewport_area"],
             notes=["All desktop; viewport area as an ergonomic "
                    "covariate."])


def g20(con):
    pr = _pr(con)
    base = _base(con)
    t = pr[pr["key"] == "_time_on_screen_ms"][
        ["participant_id", "screen", "value_int"]]
    agg = (t.groupby("participant_id")["value_int"].sum()
           .reset_index(name="total_screen_ms"))
    pf = base.merge(agg, on="participant_id", how="left")
    pf["total_screen_ms"] = pd.to_numeric(pf["total_screen_ms"],
                                          errors="coerce")
    return R("G20", "Per-Screen Deliberation Time", 10, participant=pf,
             value_cols=["total_screen_ms"],
             notes=["Summed response-screen time."])


def g24(con):
    """AI-counterpart behaviour: does the AI negotiate differently vs a
    human (direct) vs an agent (delegated)? Compare the AI side's anchor
    & concession by counterpart type."""
    base = _base(con)
    tn = _turns(con)
    rows = []
    for _, b in base.iterrows():
        ai_side = "seller" if b["role"] == "buyer" else "buyer"
        td = tn[tn["session_id"] == b["session_id"]].sort_values(
            "turn_number")
        ai_prices = []
        for _, r in td.iterrows():
            if r["emitter_id"] != ai_side:
                continue
            for pp in _proposals(r["tool_calls_json"]):
                if pp["price"] is not None:
                    ai_prices.append(pp["price"])
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "ai_opening": ai_prices[0] if ai_prices else np.nan,
                     "ai_n_moves": len(ai_prices)})
    return R("G24", "AI-Counterpart Behaviour by Counterpart Type", 10,
             participant=pd.DataFrame(rows),
             value_cols=["ai_opening", "ai_n_moves"],
             notes=["Mode contrast = AI facing an agent (delegated) vs "
                    "a human (direct) — a genuine AI-behaviour question."])


def g13(con):
    base = _base(con)
    ev = _events(con)
    rows = []
    for _, b in base.iterrows():
        g = ev[ev["participant_id"] == b["participant_id"]]
        sk = []
        for _, r in g.iterrows():
            c0, s0 = _ts(r["client_ts"]), _ts(r["server_ts"])
            if c0 and s0:
                sk.append(abs((s0 - c0).total_seconds()))
        rows.append({"participant_id": b["participant_id"],
                     "exp": b["exp"], "mode": b["mode"], "role": b["role"],
                     "opponent": b["opponent"],
                     "mean_clock_skew_s": float(np.mean(sk)) if sk
                     else np.nan})
    return R("G13", "Client–Server Clock Skew", 10,
             participant=pd.DataFrame(rows),
             value_cols=["mean_clock_skew_s"], levels={"L1", "L3", "L4"})


# ── registry (ordered by chapter, then id) ──────────────────────────
GROUPS = [
    g01, g02, g03, g17, g30, g31, g36,                       # ch1
    g03b_outcomes, g_econ, g_oper,                            # ch2
    g04,                                                      # ch3
    g05, g22, g23, g38, g39,                                  # ch4
    g06, g16, g34, g35,                                       # ch5
    g07, g32, g33, g44,                                       # ch6
    g08, g09, g21,                                            # ch7
    g10, g43,                                                 # ch8
    g11, g19, g25, g26,                                       # ch9
    g14, g15, g28, g40, g41, g42, g12, g45, g27, g29, g37,
    g18, g20, g24, g13,                                       # ch10
]
CHAPTERS = {
    1: "Sample, Flow & Validity",
    2: "Outcomes & Economic Efficiency",
    3: "Subjective Experience",
    4: "Negotiation Process & Strategy",
    5: "System & Orchestrator",
    6: "Instrumentation & Engagement",
    7: "Mode-Specific Behaviour",
    8: "Qualitative",
    9: "Integrative Modelling & Typologies",
    10: "Temporal, Cost, Robustness & Design",
}


def data_dictionary() -> pd.DataFrame:
    rows = [
        ("study_participants", "completion_code", "Non-null ⇒ completer (analysed = 40)"),
        ("study_participants", "experiment_mode", "agent⇒delegated; human_*⇒direct"),
        ("study_participants", "role", "buyer / seller (→ X1–X4 with Mode)"),
        ("study_participants", "attention_check_pass", "ENTIRELY NULL — not captured"),
        ("study_participants", "excluded / test_data", "All 0"),
        ("participant_responses", "screen=post_survey", "9 Likert DVs (1–7) + free_text"),
        ("participant_responses", "screen=engine/opponent_personality", "Randomised opponent (covariate)"),
        ("participant_responses", "screen=context/personal_context", "Delegated context (n=20)"),
        ("sessions", "outcome_type / outcome_terms_json", "agreed/rejected/impasse/aborted; {price}"),
        ("sessions", "scenario_pack_json", "Fixed ZOPA 22,500–23,500 (pie $1,000)"),
        ("turns", "tool_calls_json", "submit_proposal{action,price} / send_message"),
        ("orchestrator_decisions", "tool_name", "request_turn/declare_outcome/broadcast/pause"),
        ("participant_events", "event_type/payload_json", "dwell/idle/scroll/listing/integrity/human-turn"),
        ("behavior_prompts", "prompt_text", "Delegated instructions (match_rating/mapped_signals NULL)"),
        ("outcomes / scores", "(empty)", "No utility / judge scores — not analysable"),
    ]
    return pd.DataFrame(rows, columns=["Table", "Field", "Meaning / caveat"])


def clear_cache():
    _C.clear()
