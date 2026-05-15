# scripts/analysis/human_pilot/code_qualitative.py
"""One-shot LLM-assisted qualitative coder. NOT called by the report
build — run this once; it writes a cached coding sheet the build reads.

Usage:
  ANTHROPIC_API_KEY=... python -m scripts.analysis.human_pilot.code_qualitative
  (add --force to recode even if the cache exists)

Outputs:
  data/qual-codes-2026-05-15.json                       (gitignored cache)
  docs/reports/tables-human-pilot/qual_coding_sheet.csv (committed, checkable)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd

from scripts.analysis.human_pilot.data import (
    load_db, completers_frame, behavior_prompts_frame, survey_long, SNAPSHOT,
)
from scripts.analysis.human_pilot.qual_codebook import (
    THEME_FLAGS, TAXONOMY, COMMENT_VALENCE, COMMENT_TOPIC, MODEL, CODER_RUN_DATE,
)

CACHE = Path(f"data/qual-codes-{CODER_RUN_DATE}.json")
SHEET = Path("docs/reports/tables-human-pilot/qual_coding_sheet.csv")

_PROMPT_SCHEMA = {
    "type": "object",
    "properties": {
        **{f: {"type": "boolean"} for f in THEME_FLAGS},
        **{k: {"type": "string", "enum": v} for k, v in TAXONOMY.items()},
    },
    "required": THEME_FLAGS + list(TAXONOMY.keys()),
}
_COMMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "valence": {"type": "string", "enum": COMMENT_VALENCE},
        "topic": {"type": "string", "enum": COMMENT_TOPIC},
    },
    "required": ["valence", "topic"],
}

_PROMPT_SYS = (
    "You are a negotiation-research coder. You read ONE participant's "
    "free-text instruction to their delegated AI car-negotiation agent "
    "(or their personal-context note) and assign codes. THEME flags are "
    "independent booleans (set true only if clearly present). TAXONOMY "
    "fields each take exactly one value. Be conservative: absence of "
    "evidence → false / 'none' / 'no' / 'neutral'. Call the report tool."
)
_COMMENT_SYS = (
    "You are a survey-comment coder. You read ONE short open-ended study "
    "comment and assign a valence and a single best topic. Call the "
    "report tool."
)


def _client():
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get(
        "ORCHESTRATOR_ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit(
            "ANTHROPIC_API_KEY not set. Export it and re-run "
            "(this is a one-shot; the report build does not need it)."
        )
    import anthropic
    return anthropic.Anthropic(api_key=key)


def _code_one(client, text, schema, system):
    msg = client.messages.create(
        model=MODEL, max_tokens=400, system=system,
        tools=[{"name": "report", "description": "Return the codes.",
                "input_schema": schema}],
        tool_choice={"type": "tool", "name": "report"},
        messages=[{"role": "user",
                   "content": f'Text to code:\n"""\n{text}\n"""'}],
    )
    for block in msg.content:
        if block.type == "tool_use":
            return dict(block.input)
    return {}


def main(force: bool = False) -> None:
    if CACHE.exists() and not force:
        print(f"cache exists ({CACHE}); use --force to recode. Nothing to do.")
        return
    con = load_db(SNAPSHOT)
    comp = completers_frame(con)[["participant_id", "experiment_mode", "role"]]
    bp = behavior_prompts_frame(con)
    sv = survey_long(con)
    comments = sv[(sv["key"] == "free_text") & sv["value_text"].notna()]

    client = _client()
    rows = []

    # 8A/8B — one row per agent-mode behaviour prompt.
    for _, r in bp.iterrows():
        txt = (r["prompt_text"] or "").strip()
        if not txt:
            continue
        codes = _code_one(client, txt, _PROMPT_SCHEMA, _PROMPT_SYS)
        rows.append({"participant_id": r["participant_id"], "kind": "prompt",
                     "role": r["role"], "text": txt, **codes})

    # 8C — one row per study comment.
    for _, r in comments.iterrows():
        txt = (r["value_text"] or "").strip()
        if not txt:
            continue
        codes = _code_one(client, txt, _COMMENT_SCHEMA, _COMMENT_SYS)
        rows.append({"participant_id": r["participant_id"], "kind": "comment",
                     "text": txt, **codes})

    payload = {
        "_coded_at": CODER_RUN_DATE, "_model": MODEL,
        "_n_prompts": int((bp["prompt_text"].fillna("").str.len() > 0).sum()),
        "_n_comments": int(len(comments)),
        "rows": rows,
    }
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(payload, indent=2))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(SHEET, index=False)
    print(f"wrote {CACHE} ({len(rows)} rows) + {SHEET}")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
