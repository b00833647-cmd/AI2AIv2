# §4/§5 DV-centric 2×2 Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the item-by-item survey forest / Cliff's δ comparisons with a DV-centric 2×2 analysis: per-DV 4-cell rainclouds, a 9×4 mean heatmap, priority-DV interaction plots, and a per-DV Scheirer–Ray–Hare omnibus. Relocate the agreement-rate Fisher + price interaction to §3.

**Architecture:** Pure Python analysis pipeline under `scripts/analysis/human_pilot/`. Reads a frozen SQLite snapshot, builds a `.docx`. Offline/deterministic; no new dependency. Spec: `docs/superpowers/specs/2026-05-15-dv-centric-2x2-redesign-design.md`.

**Tech Stack:** pandas, numpy, scipy, matplotlib, seaborn, plotnine, python-docx, pytest. venv at `.venv` (`source .venv/bin/activate`). Run tests `python -m pytest scripts/analysis/tests -q`.

**Fixed facts:** `survey_long(con)` cols = `participant_id, experiment_mode, role, key, value_int, value_text, mode2`. `mode2 ∈ {AI-to-AI, Human-to-AI}`, `role ∈ {buyer, seller}`, `value_int` 1–7, 40 non-null/item. `V2_SURVEY_KEYS` (data.py) order: `satisfaction, would_use_again, agent_represented, control, emot_pleasant, emot_anxious, effort_invested, engage_engaged, outfair_share`. Priority = `V2_SURVEY_KEYS[:4]`. 4 balanced cells n=10.

---

## Task 1: Scheirer–Ray–Hare in stats_ext.py (TDD)

**Files:**
- Test: `scripts/analysis/tests/test_human_pilot_stats_ext.py` (append)
- Modify: `scripts/analysis/human_pilot/stats_ext.py`

- [ ] **Step 1: Append failing tests**

Append to `scripts/analysis/tests/test_human_pilot_stats_ext.py`:

```python


def test_srh_factor_a_dominates():
    import pandas as pd
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    rows = []
    for a in ["lo", "hi"]:
        for b in ["x", "y"]:
            base = 1.0 if a == "lo" else 6.0
            for _ in range(10):
                rows.append({"dv": base, "A": a, "B": b})
    df = pd.DataFrame(rows)
    r = scheirer_ray_hare(df, "dv", "A", "B")
    assert r["N"] == 40
    assert r["A"]["df"] == 1 and r["B"]["df"] == 1 and r["AB"]["df"] == 1
    assert r["A"]["p"] < 0.01
    assert r["B"]["p"] > 0.2 and r["AB"]["p"] > 0.2
    assert 0.0 <= r["A"]["eta2"] <= 1.0


def test_srh_valid_ranges_on_noise():
    import numpy as np
    import pandas as pd
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    rng = np.random.default_rng(0)
    rows = [{"dv": float(rng.normal(3, 1)), "A": a, "B": b}
            for a in ["lo", "hi"] for b in ["x", "y"] for _ in range(10)]
    r = scheirer_ray_hare(pd.DataFrame(rows), "dv", "A", "B")
    for k in ("A", "B", "AB"):
        assert 0.0 <= r[k]["p"] <= 1.0
        assert 0.0 <= r[k]["eta2"] <= 1.0
```

- [ ] **Step 2: Run — verify fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_stats_ext.py -q
```
Expected: FAIL — `ImportError: cannot import name 'scheirer_ray_hare'`.

- [ ] **Step 3: Implement**

Append to `scripts/analysis/human_pilot/stats_ext.py` (it already imports `from scipy import stats as _sc`; add `import numpy as _np` at the top with the existing imports):

Add this near the top imports (after `from scipy import stats as _sc`):
```python
import numpy as _np
import pandas as _pd  # noqa: F401  (type clarity; df is a DataFrame)
```

Append at end of the file:
```python
def scheirer_ray_hare(df, dv: str, a: str, b: str) -> dict:
    """Scheirer–Ray–Hare: rank-based nonparametric two-way (A, B, A×B).

    Balanced or unbalanced 2-level factors. Returns per-term H (= SS/MS_total),
    chi-square p (df=1 for 2-level factors), and eta2 (= SS/SS_total).
    Deterministic; scipy/numpy only.
    """
    d = df[[dv, a, b]].dropna().copy()
    R = _sc.rankdata(d[dv].to_numpy(dtype=float))
    N = int(R.size)
    d["_R"] = R
    grand = float(R.mean())
    SS_total = float(((R - grand) ** 2).sum())

    def _ss_main(col: str) -> float:
        s = 0.0
        for _, g in d.groupby(col, observed=True):
            s += len(g) * (float(g["_R"].mean()) - grand) ** 2
        return float(s)

    SS_A = _ss_main(a)
    SS_B = _ss_main(b)
    mean_a = d.groupby(a, observed=True)["_R"].mean()
    mean_b = d.groupby(b, observed=True)["_R"].mean()
    SS_AB = 0.0
    for (la, lb), g in d.groupby([a, b], observed=True):
        eff = float(g["_R"].mean()) - float(mean_a[la]) - float(mean_b[lb]) + grand
        SS_AB += len(g) * eff ** 2
    SS_AB = float(SS_AB)

    MS_total = SS_total / (N - 1) if N > 1 else float("nan")

    def _term(ss: float, dfree: int) -> dict:
        H = ss / MS_total if MS_total and MS_total == MS_total else float("nan")
        ok = H == H and _np.isfinite(H)
        p = float(_sc.chi2.sf(H, dfree)) if ok else float("nan")
        eta2 = ss / SS_total if SS_total else float("nan")
        return {"H": float(H), "p": p, "eta2": float(eta2), "df": int(dfree)}

    return {"A": _term(SS_A, 1), "B": _term(SS_B, 1),
            "AB": _term(SS_AB, 1), "N": N}
```

- [ ] **Step 4: Run — verify passes**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_stats_ext.py -q
```
Expected: all pass (existing stats_ext tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/stats_ext.py scripts/analysis/tests/test_human_pilot_stats_ext.py
git commit -m "analysis: Scheirer–Ray–Hare nonparametric 2x2 (stats_ext)

Co-Authored-By: RuFlo <ruv@ruv.net>"
```

---

## Task 2: tables.py — new DV builders, retire item-by-item (TDD)

**Files:**
- Modify: `scripts/analysis/human_pilot/tables.py`
- Modify: `scripts/analysis/human_pilot/figures.py` (import line + remove 2 retired builders + their ALL_FIGURES entries — required so the suite stays importable after the table fns are removed)
- Modify: `scripts/analysis/tests/test_human_pilot_tables.py`

- [ ] **Step 1: Rewrite the 3 invalid table tests + add new ones**

In `scripts/analysis/tests/test_human_pilot_tables.py`, REMOVE the three tests `test_survey_descriptives_nine_items`, `test_comparison_mode_has_fisher_attr`, `test_comparison_role_has_fisher_attr` (read the file first; delete exactly those three functions, nothing else). Append:

```python


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
```

(`m_con()` and `import ... as T` already exist in this test file — reuse them; do not redefine.)

- [ ] **Step 2: Run — verify fails**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests/test_human_pilot_tables.py -q
```
Expected: FAIL — `AttributeError: module ... has no attribute 'dv_group_descriptives'` (and the deleted tests are gone).

- [ ] **Step 3: Edit tables.py — add new builders, remove retired ones**

In `scripts/analysis/human_pilot/tables.py`:

(a) DELETE these in full: `def survey_descriptives(`, `def _two_group_survey(`, `def _delta_ci(`, `def comparison_mode(`, `def comparison_role(` (read the file; remove each entire function body). If `_delta_ci`/`bootstrap_ci`/`cliff_delta`/`mann_whitney`/`fdr_bh` imports become unused after deletion, leave the imports (they are thin re-exports; an unused import is acceptable and avoids touching shared modules) — do not chase imports beyond tables.py.

(b) ADD these three functions (place after `outcome_descriptives`, before the Section 8 block). `pd`, `np`, `survey_long`, `completers_frame`, `V2_SURVEY_KEYS`, `fisher_2x2` are already imported at the top of tables.py:

```python
def dv_group_descriptives(con) -> pd.DataFrame:
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    prio = set(V2_SURVEY_KEYS[:4])
    order = {k: i for i, k in enumerate(V2_SURVEY_KEYS)}
    rows = []
    for dv in V2_SURVEY_KEYS:
        sub = s[s["key"] == dv]
        for (m2, role), g in sub.groupby(["mode2", "role"]):
            v = g["value_int"]
            rows.append({
                "dv": dv, "priority": dv in prio, "mode2": m2, "role": role,
                "n": int(len(v)), "M": round(float(v.mean()), 2),
                "SD": round(float(v.std()), 2), "Mdn": float(v.median()),
                "IQR": f"{v.quantile(.25):.0f}-{v.quantile(.75):.0f}",
            })
    df = pd.DataFrame(rows)
    df["_o"] = df["dv"].map(order)
    return (df.sort_values(["_o", "mode2", "role"])
              .drop(columns="_o").reset_index(drop=True))


def srh_results(con) -> pd.DataFrame:
    from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    prio = set(V2_SURVEY_KEYS[:4])
    out = []
    for dv in V2_SURVEY_KEYS:
        r = scheirer_ray_hare(s[s["key"] == dv], "value_int", "mode2", "role")
        out.append({
            "dv": dv, "priority": dv in prio,
            "mode_H": round(r["A"]["H"], 3), "mode_p": round(r["A"]["p"], 4),
            "mode_eta2": round(r["A"]["eta2"], 3),
            "role_H": round(r["B"]["H"], 3), "role_p": round(r["B"]["p"], 4),
            "role_eta2": round(r["B"]["eta2"], 3),
            "inter_H": round(r["AB"]["H"], 3), "inter_p": round(r["AB"]["p"], 4),
            "inter_eta2": round(r["AB"]["eta2"], 3), "N": r["N"],
        })
    return pd.DataFrame(out)


def agreement_2x2(con) -> dict:
    df = completers_frame(con)

    def _f(col, la, lb):
        ga = df[df[col] == la]
        gb = df[df[col] == lb]
        return fisher_2x2(
            success_a=int((ga["outcome_type"] == "agreed").sum()), n_a=len(ga),
            success_b=int((gb["outcome_type"] == "agreed").sum()), n_b=len(gb))

    return {"by_mode": _f("mode2", "AI-to-AI", "Human-to-AI"),
            "by_role": _f("role", "buyer", "seller")}
```

- [ ] **Step 4: Edit figures.py so the suite stays importable**

In `scripts/analysis/human_pilot/figures.py`:

(a) Change the import line (currently `from scripts.analysis.human_pilot.tables import comparison_mode, comparison_role`) — DELETE that line entirely (the builders that used it are being removed).

(b) DELETE the entire `def fig_survey_forest(` function and the entire `def fig_comparison_delta(` function.

(c) In `ALL_FIGURES`, REMOVE these three entries exactly:
```python
    ("fig4_survey_forest", fig_survey_forest),
    ("fig5_delta_mode", lambda c: fig_comparison_delta(c, "mode")),
    ("fig5_delta_role", lambda c: fig_comparison_delta(c, "role")),
```
Leave `fig_interaction`, `fig_prompt_len`, the Section-8 block, and everything else untouched. (New figures are added in Task 3.)

- [ ] **Step 5: Run — verify passes**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests -q
```
Expected: all green. (`test_human_pilot_tables.py` new tests pass; figures import cleanly; report.py still imports — it still references the now-removed `fig_survey_forest`/`comparison_*`? It does. So this step's full-suite run will FAIL on report import only if a test imports report. It does not — no test imports report.py. The suite is green; report.py is fixed in Task 4.) If any non-report test fails, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add scripts/analysis/human_pilot/tables.py scripts/analysis/human_pilot/figures.py scripts/analysis/tests/test_human_pilot_tables.py
git commit -m "analysis: retire item-by-item; add dv_group_descriptives/srh_results/agreement_2x2

Co-Authored-By: RuFlo <ruv@ruv.net>"
```

---

## Task 3: figures.py — heatmap, rainclouds, panel, interaction

**Files:**
- Modify: `scripts/analysis/human_pilot/figures.py`

- [ ] **Step 1: Add the new figure builders**

Append to `scripts/analysis/human_pilot/figures.py` immediately BEFORE the `ALL_FIGURES = [` list (so they are defined when the list references them). `plt`, `np`, `p9`, `survey_long`, `V2_SURVEY_KEYS`, `MODE2_COLORS`, `ROLE_COLORS`, `CELL_COLORS`, `apply_theme`, `save`, `save_plotnine` are already imported at the top:

```python
def fig_dv_heatmap(con) -> Path:
    apply_theme()
    from matplotlib.colors import LinearSegmentedColormap
    from scripts.analysis.human_pilot.palette import LIKERT_DIVERGING
    s = survey_long(con)
    s = s[s["key"].isin(V2_SURVEY_KEYS) & s["value_int"].notna()].copy()
    s["value_int"] = s["value_int"].astype(float)
    s["cell"] = s["mode2"] + "\n" + s["role"]
    piv = (s.pivot_table(index="key", columns="cell", values="value_int",
                         aggfunc="mean").reindex(V2_SURVEY_KEYS))
    cmap = LinearSegmentedColormap.from_list("likert", LIKERT_DIVERGING)
    fig, ax = plt.subplots()
    im = ax.imshow(piv.values, cmap=cmap, vmin=1, vmax=7, aspect="auto")
    ax.set_xticks(range(piv.shape[1]))
    ax.set_xticklabels(list(piv.columns), fontsize=8)
    ax.set_yticks(range(piv.shape[0]))
    ax.set_yticklabels(list(piv.index), fontsize=8)
    ax.axhline(3.5, color="black", lw=1.6)  # priority DVs (rows 0-3) above
    for r in range(piv.shape[0]):
        for c in range(piv.shape[1]):
            ax.text(c, r, f"{piv.values[r, c]:.1f}", ha="center",
                    va="center", fontsize=8, color="black")
    fig.colorbar(im, ax=ax, shrink=0.7, label="mean (1–7)")
    ax.set_title("DV means by group (priority DVs above the rule)")
    return save(fig, "fig4_dv_heatmap", aspect=0.7)


def fig_dv_raincloud(con, dv: str) -> Path:
    from scripts.analysis.human_pilot.tables import srh_results
    s = survey_long(con)
    d = s[(s["key"] == dv) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    row = srh_results(con).query("dv == @dv").iloc[0]
    sub = (f"SRH  Mode p={row['mode_p']:.3f} · Role p={row['role_p']:.3f} · "
           f"M×R p={row['inter_p']:.3f}  (exploratory, n=10/cell)")
    g = (p9.ggplot(d, p9.aes("role", "value_int", fill="role"))
         + p9.geom_violin(alpha=0.3, trim=True, color="none")
         + p9.geom_boxplot(width=0.15, outlier_alpha=0.0, alpha=0.7)
         + p9.geom_jitter(width=0.08, height=0.0, size=1.6, alpha=0.65)
         + p9.facet_wrap("~mode2")
         + p9.scale_fill_manual(values=ROLE_COLORS)
         + p9.coord_cartesian(ylim=(0.8, 7.2))
         + p9.labs(title=dv, subtitle=sub, x="", y="response (1–7)", fill="")
         + p9.theme_minimal()
         + p9.theme(figure_size=(6, 4.0), legend_position="none"))
    return save_plotnine(g, f"fig4_dv_{dv}", w=6.0, h=4.0)


def fig_dv_panel5(con) -> Path:
    s = survey_long(con)
    keys = V2_SURVEY_KEYS[4:]
    d = s[s["key"].isin(keys) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    d["cell"] = d["mode2"] + "·" + d["role"]
    d["key"] = pd.Categorical(d["key"], categories=keys, ordered=True)
    cmap = {
        "AI-to-AI·buyer": CELL_COLORS["agent/buyer"],
        "AI-to-AI·seller": CELL_COLORS["agent/seller"],
        "Human-to-AI·buyer": CELL_COLORS["human_buyer/buyer"],
        "Human-to-AI·seller": CELL_COLORS["human_seller/seller"],
    }
    g = (p9.ggplot(d, p9.aes("cell", "value_int", fill="cell"))
         + p9.geom_violin(alpha=0.3, trim=True, color="none")
         + p9.geom_boxplot(width=0.15, outlier_alpha=0.0, alpha=0.7)
         + p9.geom_jitter(width=0.08, height=0.0, size=1.2, alpha=0.55)
         + p9.facet_wrap("~key", ncol=2)
         + p9.scale_fill_manual(values=cmap)
         + p9.coord_cartesian(ylim=(0.8, 7.2))
         + p9.labs(title="Secondary DVs by the 4 groups", x="", y="response (1–7)")
         + p9.theme_minimal()
         + p9.theme(figure_size=(7, 7), legend_position="none",
                    axis_text_x=p9.element_text(rotation=30, ha="right")))
    return save_plotnine(g, "fig4_dv_panel5", w=7.0, h=7.0)


def fig_dv_interaction(con, dv: str) -> Path:
    apply_theme()
    s = survey_long(con)
    d = s[(s["key"] == dv) & s["value_int"].notna()].copy()
    d["value_int"] = d["value_int"].astype(float)
    modes = ["AI-to-AI", "Human-to-AI"]
    x = np.arange(2)
    fig, ax = plt.subplots()
    for role in ["buyer", "seller"]:
        means, errs = [], []
        for m2 in modes:
            v = d[(d["mode2"] == m2) & (d["role"] == role)]["value_int"]
            means.append(float(v.mean()))
            errs.append(1.96 * float(v.std()) / np.sqrt(len(v))
                        if len(v) > 1 else 0.0)
        ax.errorbar(x, means, yerr=errs, fmt="o-", capsize=3,
                    color=ROLE_COLORS[role], label=role)
    ax.set_xticks(x)
    ax.set_xticklabels(modes)
    ax.set_ylim(1, 7)
    ax.set_ylabel("mean (1–7) ± 95% CI")
    ax.set_title(f"{dv} — Mode × Role (descriptive, exploratory)")
    ax.legend(fontsize=8, title="role")
    return save(fig, f"fig5_int_{dv}", aspect=0.55)
```

- [ ] **Step 2: Extend ALL_FIGURES**

In the `ALL_FIGURES = [ ... ]` literal, after the existing remaining entries (e.g. after `("fig3_price", fig_price)` and before/after `("fig5_interaction", fig_interaction)` / `("fig6_prompt_len", fig_prompt_len)` — order is not load-bearing), add these entries inside the list:

```python
    ("fig4_dv_heatmap", fig_dv_heatmap),
    *[(f"fig4_dv_{k}", (lambda c, k=k: fig_dv_raincloud(c, k)))
      for k in V2_SURVEY_KEYS[:4]],
    ("fig4_dv_panel5", fig_dv_panel5),
    *[(f"fig5_int_{k}", (lambda c, k=k: fig_dv_interaction(c, k)))
      for k in V2_SURVEY_KEYS[:4]],
```

(The `*[...]` spread inside a list literal is valid Python ≥3.5; `k=k` binds the loop var per-lambda. `V2_SURVEY_KEYS` is already imported in figures.py.)

- [ ] **Step 3: Smoke-render every figure**

```bash
source .venv/bin/activate && python -c "
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
from scripts.analysis.human_pilot.figures import ALL_FIGURES
con = load_db(SNAPSHOT)
names = [n for n, _ in ALL_FIGURES]
assert 'fig4_dv_heatmap' in names and 'fig4_dv_panel5' in names
assert 'fig4_dv_satisfaction' in names and 'fig5_int_control' in names
assert 'fig4_survey_forest' not in names and 'fig5_delta_mode' not in names
for n, fn in ALL_FIGURES:
    p = fn(con); assert p.exists() and p.stat().st_size > 800, n
    print('OK', n)
print('TOTAL', len(ALL_FIGURES))
"
```
Expected: `OK` for every figure incl. `fig4_dv_heatmap`, `fig4_dv_satisfaction`, `fig4_dv_would_use_again`, `fig4_dv_agent_represented`, `fig4_dv_control`, `fig4_dv_panel5`, `fig5_int_satisfaction`…`fig5_int_control`; no `fig4_survey_forest`/`fig5_delta_*`. `TOTAL` = previous 10 − 3 + 10 = 17 (quantitative) plus the build still has the 3 QUAL_FIGURES separately.

- [ ] **Step 4: Run suite (no regressions)**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests -q
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/analysis/human_pilot/figures.py
git commit -m "analysis: DV heatmap + 2x2 rainclouds + interaction figures

Co-Authored-By: RuFlo <ruv@ruv.net>"
```

---

## Task 4: report.py — rewrite §3 tail, §4, §5; rebuild .docx

**Files:**
- Modify: `scripts/analysis/human_pilot/report.py`

- [ ] **Step 1: Update imports**

In `scripts/analysis/human_pilot/report.py`, change:
```python
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT
```
to:
```python
from scripts.analysis.human_pilot.data import load_db, SNAPSHOT, V2_SURVEY_KEYS
```

- [ ] **Step 2: Append agreement + price interaction to §3**

In `build()`, the §3 block currently ends with the `table(doc, t, "Table 3.1 — Outcome descriptives by cell.", ...)` call (right before `h1(doc, "4. ...")`). Immediately AFTER that `table(...)` call and BEFORE the `h1(doc, "4. ...)` line, insert:

```python
    ag = T.agreement_2x2(con)
    bm, br = ag["by_mode"], ag["by_role"]
    para(doc, f"Agreement rate — by mode: AI-to-AI {bm['rate_a']:.0%} vs "
              f"Human-to-AI {bm['rate_b']:.0%} (Fisher's exact p={bm['p']:.3f}, "
              f"OR={bm['odds_ratio']:.2f}); by role: buyer {br['rate_a']:.0%} "
              f"vs seller {br['rate_b']:.0%} (p={br['p']:.3f}, "
              f"OR={br['odds_ratio']:.2f}). Exploratory; 20 per side.")
    figure(doc, F.fig_interaction(con),
           "Figure 3.3 — Mode × Role on median agreed price (descriptive).",
           "Interaction pattern on the negotiation outcome; not tested "
           "(n≈7 agreed per cell).")
```

- [ ] **Step 3: Replace the entire §4 + §5 block**

DELETE everything from `h1(doc, "4. Post-experience survey (9 items)")` through the end of the old §5 (the last old §5 call is `figure(doc, F.fig_interaction(con), "Figure 5D.1 — Mode × Role on median agreed price.", ...)` — that whole `figure(...)` call is removed; `fig_interaction` now lives in §3 per Step 2). Stop deleting just before `h1(doc, "6. Data quality & operational")`. Replace the deleted region with exactly:

```python
    h1(doc, "4. Post-experience survey — the 9 DVs across the 4 groups")
    para(doc, "Each survey item is a dependent variable. The 2×2 design "
              "(Mode × Role) yields four cells of n=10. Figures show every "
              "data point; statistics are exploratory (Scheirer–Ray–Hare "
              "per DV, no multiplicity correction, no pairwise post-hoc).",
         italic=True)
    figure(doc, F.fig_dv_heatmap(con),
           "Figure 4.1 — Mean (1–7) per DV × group; priority DVs above the rule.",
           "All nine DV means across the four cells at a glance; diverging "
           "scale centered at the 1–7 midpoint.")
    for i, dv in enumerate(V2_SURVEY_KEYS[:4]):
        figure(doc, F.fig_dv_raincloud(con, dv),
               f"Figure 4.{i + 2} — {dv}: distribution by Mode × Role.",
               "Violin + box + all 10 raw points per cell; SRH in the "
               "subtitle. Exploratory.")
    figure(doc, F.fig_dv_panel5(con),
           "Figure 4.6 — Secondary DVs (5) across the four groups.",
           "Same raincloud-style; flat 4-group view.")
    t = T.dv_group_descriptives(con); _csv(t, "tbl4_dv_descriptives")
    table(doc, t,
          "Table 4.1 — Descriptives per DV × group (n, M, SD, Mdn, IQR).",
          "All nine DVs × four cells; priority DVs first.")

    h1(doc, "5. Mode × Role effects on the DVs (exploratory)")
    para(doc, "Per-DV nonparametric two-way (Scheirer–Ray–Hare): rank-based "
              "Mode, Role and Mode×Role tests. Strictly exploratory — "
              "n=10/cell, p uncorrected, no pairwise post-hoc.", italic=True)
    for i, dv in enumerate(V2_SURVEY_KEYS[:4]):
        figure(doc, F.fig_dv_interaction(con, dv),
               f"Figure 5.{i + 1} — {dv}: Mode × Role (mean ± 95% CI).",
               "Lines = Role; x = Mode. Descriptive; exploratory.")
    t = T.srh_results(con); _csv(t, "tbl5_srh")
    table(doc, t, "Table 5.1 — Scheirer–Ray–Hare per DV (H, p, η²).",
          "Mode / Role / Mode×Role rank-based omnibus per DV. p uncorrected, "
          "exploratory; η² = share of rank variance. Priority DVs first.")
```

- [ ] **Step 4: Rebuild**

```bash
source .venv/bin/activate && python -m scripts.analysis.human_pilot.report
```
Expected: `wrote docs/reports/2026-05-15-human-pilot-data-report.docx (… bytes)`, no traceback.

- [ ] **Step 5: Verify content**

```bash
source .venv/bin/activate && python -c "
from docx import Document
d = Document('docs/reports/2026-05-15-human-pilot-data-report.docx')
txt = '\n'.join(p.text for p in d.paragraphs)
assert 'the 9 DVs across the 4 groups' in txt
assert 'Scheirer–Ray–Hare' in txt
assert 'Cliff' not in txt and 'BH-FDR' not in txt and 'per-item' not in txt
assert 'Figure 3.3' in txt and 'Agreement rate — by mode' in txt
for s in ['8. Qualitative analysis','8A','8B','8C','8D','8E']:
    assert s in txt, s
imgs = sum(1 for r in d.part.rels.values() if 'image' in r.reltype)
print('OK images', imgs, 'tables', len(d.tables)); assert imgs >= 18
"
```
Expected: `OK images …` (≥18: §1–3 figs + heatmap + 4 rainclouds + panel5 + 4 interaction + §6 + §8×3), §8 intact, no Cliff/FDR/per-item text.

- [ ] **Step 6: Suite + LLM-free**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests -q && python -c "import sys, scripts.analysis.human_pilot.report; print('anthropic in build:', 'anthropic' in sys.modules)"
```
Expected: all green; `anthropic in build: False`.

- [ ] **Step 7: Commit (incl. rebuilt outputs)**

```bash
git add scripts/analysis/human_pilot/report.py docs/reports/2026-05-15-human-pilot-data-report.docx docs/reports/figures-human-pilot docs/reports/tables-human-pilot
git commit -m "report: §4/§5 rebuilt DV-centric (rainclouds, heatmap, SRH); Fisher→§3

Co-Authored-By: RuFlo <ruv@ruv.net>"
```

---

## Task 5: Full-suite verification + acceptance + final commit

- [ ] **Step 1: Whole suite**

```bash
source .venv/bin/activate && python -m pytest scripts/analysis/tests -q
```
Expected: all pass.

- [ ] **Step 2: Acceptance (spec §"Acceptance criteria")**

```bash
source .venv/bin/activate && python -c "
import inspect
from scripts.analysis.human_pilot import tables as T, figures as F
src_t = inspect.getsource(T); src_f = inspect.getsource(F)
for gone in ('def survey_descriptives', 'def _two_group_survey', 'def _delta_ci',
             'def comparison_mode', 'def comparison_role'):
    assert gone not in src_t, gone
for gone in ('def fig_survey_forest', 'def fig_comparison_delta'):
    assert gone not in src_f, gone
for need in ('def dv_group_descriptives', 'def srh_results', 'def agreement_2x2'):
    assert need in src_t, need
from scripts.analysis.human_pilot.stats_ext import scheirer_ray_hare  # exists
from docx import Document
d = Document('docs/reports/2026-05-15-human-pilot-data-report.docx')
txt = '\n'.join(p.text for p in d.paragraphs)
assert 'Abstract' not in txt and 'Introduction' not in txt
assert 'the 9 DVs across the 4 groups' in txt and 'Scheirer–Ray–Hare' in txt
sr = T.srh_results.__doc__ is None or True
import pandas as pd
srt = T.__dict__['srh_results']
print('acceptance OK')
"
```
Expected: `acceptance OK`.

- [ ] **Step 3: Final commit (if anything uncommitted)**

```bash
git status --porcelain
```
If only `.venv/`/`__pycache__`/unrelated dirs remain: nothing to commit (Task 4 already committed build outputs) — do NOT create an empty commit. Otherwise:
```bash
git add docs/reports/2026-05-15-human-pilot-data-report.docx docs/reports/figures-human-pilot docs/reports/tables-human-pilot
git commit -m "report: finalize DV-centric redesign build outputs

Co-Authored-By: RuFlo <ruv@ruv.net>"
```

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|---|---|
| SRH in stats_ext + tests, core untouched | Task 1 |
| `dv_group_descriptives`, `srh_results`, `agreement_2x2`; remove `_two_group_survey`/`_delta_ci`/`survey_descriptives`/`comparison_*` | Task 2 |
| Remove `fig_survey_forest`/`fig_comparison_delta` | Task 2 (4) |
| Add heatmap / 4 priority rainclouds / panel5 / 4 interaction; ALL_FIGURES net +10/−3 | Task 3 |
| §3 gets agreement Fisher + price interaction | Task 4 (2) |
| §4 = heatmap+4 rainclouds+panel5+desc table | Task 4 (3) |
| §5 = 4 interaction + SRH table + prose | Task 4 (3) |
| §1/2/6/7/8 untouched; offline/deterministic | Task 4 (5,6), Task 5 |
| Acceptance criteria | Task 4 (5), Task 5 (2) |

**2. Placeholder scan:** No TBD/TODO. Every code step is complete; every run step has an exact command + expected output. Deletions name exact `def` signatures. Graceful branches: none added (the qual cache branch is pre-existing, untouched).

**3. Type consistency:** `scheirer_ray_hare(df, dv, a, b) -> {"A":{"H","p","eta2","df"},"B":...,"AB":...,"N"}` consumed by `srh_results` (maps A→mode_*, B→role_*, AB→inter_*). `srh_results` cols match `fig_dv_raincloud` (`mode_p/role_p/inter_p`) and the Task 2 test (`mode_H…N`, 12 cols). `dv_group_descriptives` cols (`dv,priority,mode2,role,n,M,SD,Mdn,IQR`) match its test (36 rows, n=[10]*36). `agreement_2x2` returns `{"by_mode","by_role"}` of `fisher_2x2` dicts (`odds_ratio,p,rate_a,rate_b,n_a,n_b`) consumed by report §3 (`bm['rate_a']…`). `V2_SURVEY_KEYS[:4]` = priority everywhere (data.py single source; report imports it). PNG `Path` return type consistent across all `fig_*` and `ALL_FIGURES` lambdas (`k=k` capture). `fig_interaction` reused (kept in figures.py) by §3.

**4. Ordering safety:** Task 2 removes table fns AND the dependent figures.py import/builders/ALL_FIGURES entries in the same commit → suite stays green (no test imports report.py, so report.py's stale refs don't break the suite until they're fixed in Task 4, which is acceptable between tasks). Task 3 adds new figures before Task 4 wires them into report. Each task's commit is internally consistent for the test suite.
