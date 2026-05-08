// The five orchestrator tools, JSON Schema definitions.

import type { ToolDefinition } from "./types.ts";

export const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  {
    name: "request_turn",
    description:
      "Ask a specific participant to take the next turn. Use this by default to keep the dialogue moving. Optionally provide a brief instruction (1 sentence) appended to their user message, or a context_override that replaces the default transcript view they see.",
    inputSchema: {
      type: "object",
      properties: {
        participant_id: {
          type: "string",
          description: "The id of the participant to invoke. Must match a participant in the scenario roster.",
        },
        instruction: {
          type: "string",
          description:
            "Optional. A single sentence appended to the participant's user message. Examples: 'Be specific about your offer.' / 'Address Bob's last point directly.' / 'Respond in under 100 words.'",
        },
        context_override: {
          type: "string",
          description:
            "Optional. Replaces the default transcript view this participant sees. Use for asymmetric-information scenarios or context compression. Markdown formatting permitted.",
        },
      },
      required: ["participant_id"],
    },
  },
  {
    name: "broadcast_to",
    description:
      "Inject a moderator note visible to one or more participants on their next turn. Format: '[Moderator]: <message>'. Use sparingly — only when a redirect, clarification request, or confirmation is genuinely needed. Never put words in a participant's mouth.",
    inputSchema: {
      type: "object",
      properties: {
        audience: {
          oneOf: [
            { type: "array", items: { type: "string" }, description: "Array of participant ids — use this even for a single recipient (wrap in []). Examples: [\"buyer\"], [\"seller\"], [\"buyer\",\"seller\"]." },
            { type: "string", enum: ["all"] },
          ],
          description: "Either the literal string 'all' OR an array of participant ids. Never a bare string id — wrap single recipients in [\"id\"].",
        },
        message: {
          type: "string",
          description:
            "The moderator note. Keep under 200 characters. Examples: 'Please confirm your acceptance explicitly.' / 'Could each of you state your minimum acceptable outcome?' / 'You have 2 turns remaining.'",
        },
      },
      required: ["audience", "message"],
    },
  },
  {
    name: "declare_outcome",
    description:
      "End the session. The type must be one of the scenario's permittedOutcomes. If the decision space defines slots, terms must match. Rationale must cite specific turn numbers from the transcript.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Outcome type. Must be one of scenarioPack.protocolHints.permittedOutcomes.",
        },
        summary: {
          type: "string",
          description: "1-2 sentence human-readable summary of what happened.",
        },
        terms: {
          type: "object",
          description:
            "Optional. Structured final outcome conforming to scenarioPack.decisionSpace. Required for outcome types that imply agreed terms (e.g. 'agreed', 'consensus').",
        },
        rationale: {
          type: "string",
          description:
            "Why this outcome was declared. Must cite specific turn numbers, e.g. 'See turn #4 (Alice offered $14k) and #5 (Bob accepted).'",
        },
      },
      required: ["type", "summary", "rationale"],
    },
  },
  {
    name: "compress_context",
    description:
      "Replace older turns in a participant's transcript view with a summary on their next request_turn. Use proactively when a participant's context is nearing token budget. Summarize neutrally; do not editorialize or favor any participant.",
    inputSchema: {
      type: "object",
      properties: {
        participant_id: {
          type: "string",
          description: "The participant whose context will be compressed.",
        },
        summary: {
          type: "string",
          description:
            "Neutral summary of the older turns. Should preserve all positions taken, offers made, and constraints stated. Format: '## Earlier in this session\\n- Round 1: ...\\n- Round 2: ...'",
        },
      },
      required: ["participant_id", "summary"],
    },
  },
  {
    name: "pause",
    description:
      "Stop and wait for human resume. Use when you detect deadlock (3+ rounds with no progress), suspect agreement but want human confirmation, or when an operator pause command is pending.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the pause is needed. Will be displayed to the human observer.",
        },
      },
      required: ["reason"],
    },
  },
];
