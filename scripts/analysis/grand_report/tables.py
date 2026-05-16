"""Uniform table preparation so every table in the document is
formatted identically (consistent decimals, NA blanks, column order).
The drawing happens in apa.py; this only normalises the DataFrame.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def prep(df: pd.DataFrame, *, nd: int = 2, max_rows: int = 60,
         max_text: int = 220) -> pd.DataFrame:
    if df is None or len(df) == 0:
        return pd.DataFrame([{"(no rows)": ""}])
    out = df.copy()
    for c in out.columns:
        if pd.api.types.is_float_dtype(out[c]):
            out[c] = out[c].map(
                lambda v: "" if pd.isna(v) else f"{v:,.{nd}f}")
        else:
            out[c] = out[c].map(
                lambda v: "" if (isinstance(v, float) and np.isnan(v))
                or v is None else
                (str(v)[:max_text] + "…" if isinstance(v, str)
                 and len(str(v)) > max_text else str(v)))
    if len(out) > max_rows:
        head = out.head(max_rows - 1)
        tail = pd.DataFrame([{out.columns[0]:
                              f"… (+{len(out) - max_rows + 1} more rows; "
                              f"full table in Appendix CSV)"}
                             | {c: "" for c in out.columns[1:]}])
        out = pd.concat([head, tail], ignore_index=True)
    return out


def kv(d: dict, kcol="Item", vcol="Value") -> pd.DataFrame:
    return pd.DataFrame([{kcol: k, vcol: v} for k, v in d.items()])
