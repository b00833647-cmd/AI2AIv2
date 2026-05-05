# Orchestrator tool schemas

The five tools the LLM Orchestrator can call. Format follows Anthropic's tool-use spec; trivially adaptable to OpenAI / others.

```json
[
  {
    "name": "request_turn",
    "description": "Ask a specific participant to take the next turn. Use this by default to keep the dialogue moving. Optionally provide a brief instruction (1 sentence) appended to their user message, or a context_override that replaces the default transcript view they see.",
    "input_schema": {
      "type": "object",
      "properties": {
        "participant_id": {
          "type": "string",
          "description": "The id of the participant to invoke. Must match a participant in the scenario roster."
        },
        "instruction": {
          "type": "string",
          "description": "Optional. A single sentence appended to the participant's user message. Examples: 'Be specific about your offer.' / 'Address Bob's last point directly.' / 'Respond in under 100 words.'"
        },
        "context_override": {
          "type": "string",
          "description": "Optional. Replaces the default transcript view this participant sees. Use for asymmetric-information scenarios or context compression. Markdown formatting permitted."
        }
      },
      "required": ["participant_id"]
    }
  },
  {
    "name": "broadcast_to",
    "description": "Inject a moderator note visible to one or more participants on their next turn. Format: '[Moderator]: <message>'. Use sparingly — only when a redirect, clarification request, or confirmation is genuinely needed. Never put words in a participant's mouth.",
    "input_schema": {
      "type": "object",
      "properties": {
        "audience": {
          "oneOf": [
            { "type": "array", "items": { "type": "string" }, "description": "Array of participant ids" },
            { "type": "string", "enum": ["all"] }
          ],
          "description": "Either an array of participant ids, or the literal string 'all'."
        },
        "message": {
          "type": "string",
          "description": "The moderator note. Keep under 200 characters. Examples: 'Please confirm your acceptance explicitly.' / 'Could each of you state your minimum acceptable outcome?' / 'You have 2 turns remaining.'"
        }
      },
      "required": ["audience", "message"]
    }
  },
  {
    "name": "declare_outcome",
    "description": "End the session. The type must be one of the scenario's permittedOutcomes. If the decision space defines slots, terms must match. Rationale must cite specific turn numbers from the transcript.",
    "input_schema": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Outcome type. Must be one of scenarioPack.protocolHints.permittedOutcomes."
        },
        "summary": {
          "type": "string",
          "description": "1-2 sentence human-readable summary of what happened."
        },
        "terms": {
          "type": "object",
          "description": "Optional. Structured final outcome conforming to scenarioPack.decisionSpace. Required for outcome types that imply agreed terms (e.g. 'agreed', 'consensus')."
        },
        "rationale": {
          "type": "string",
          "description": "Why this outcome was declared. Must cite specific turn numbers, e.g. 'See turn #4 (Alice offered $14k) and #5 (Bob accepted).'"
        }
      },
      "required": ["type", "summary", "rationale"]
    }
  },
  {
    "name": "compress_context",
    "description": "Replace older turns in a participant's transcript view with a summary on their next request_turn. Use proactively when a participant's context is nearing token budget. Summarize neutrally; do not editorialize or favor any participant.",
    "input_schema": {
      "type": "object",
      "properties": {
        "participant_id": {
          "type": "string",
          "description": "The participant whose context will be compressed."
        },
        "summary": {
          "type": "string",
          "description": "Neutral summary of the older turns. Should preserve all positions taken, offers made, and constraints stated. Format: '## Earlier in this session\\n- Round 1: ...\\n- Round 2: ...'"
        }
      },
      "required": ["participant_id", "summary"]
    }
  },
  {
    "name": "pause",
    "description": "Stop and wait for human resume. Use when you detect deadlock (3+ rounds with no progress), suspect agreement but want human confirmation, or when an operator pause command is pending.",
    "input_schema": {
      "type": "object",
      "properties": {
        "reason": {
          "type": "string",
          "description": "Why the pause is needed. Will be displayed to the human observer."
        }
      },
      "required": ["reason"]
    }
  }
]
```

## Validation rules (engine-side)

The engine validates each orchestrator tool call before applying it:

| Tool | Validation |
|---|---|
| `request_turn` | `participant_id` exists in roster; `instruction` ≤ 200 chars |
| `broadcast_to` | All ids in `audience` exist (or `audience === "all"`); `message` ≤ 500 chars |
| `declare_outcome` | `type` ∈ `permittedOutcomes`; if `terms` present, validates against `decisionSpace.slots` schema; `rationale` non-empty |
| `compress_context` | `participant_id` exists; `summary` non-empty; only allowed once per ~5 participant turns to prevent loops |
| `pause` | Always valid |

If a call fails validation, the engine re-prompts the orchestrator with the validation error inline. After 3 failed attempts on the same turn, the engine falls back to deterministic round-robin and flags the session as `degraded`.
