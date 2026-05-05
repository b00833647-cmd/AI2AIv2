// Behavior-mapper — translates a free-text user-supplied prompt into a fixed
// 7-dimensional signal vector via a single Claude call (with structured
// output). Anything in the prompt that doesn't map cleanly to one of the seven
// axes is captured as a short residual `notes` string.
//
// The opponent's signals are randomized (not LLM-derived). Both sides' signals
// are baked into the scenario pack at setup time so replays use the same
// opponent (reproducibility).

import Anthropic from "@anthropic-ai/sdk";

export type Signal = -1 | 0 | 1;

export interface BehaviorSignals {
  assertiveness: Signal;
  flexibility: Signal;
  riskTolerance: Signal;
  communicationStyle: Signal;
  timeOrientation: Signal;
  trustLevel: Signal;
  emotionalExpressiveness: Signal;
}

export interface MappedPersona {
  signals: BehaviorSignals;
  notes: string;
}

interface DimensionSpec {
  key: keyof BehaviorSignals;
  neg: string;
  neu: string;
  pos: string;
}

export const BEHAVIOR_DIMENSIONS: readonly DimensionSpec[] = [
  {
    key: "assertiveness",
    neg: "passive, accommodating, soft on demands",
    neu: "balanced — neither dominant nor submissive",
    pos: "aggressive, demanding, holds ground firmly",
  },
  {
    key: "flexibility",
    neg: "rigid, anchors strongly to initial positions",
    neu: "moderate flexibility — concedes when warranted",
    pos: "highly flexible, willing to adjust positions",
  },
  {
    key: "riskTolerance",
    neg: "risk-averse, conservative, prefers safe outcomes",
    neu: "neutral risk tolerance",
    pos: "risk-seeking, bold, willing to gamble for upside",
  },
  {
    key: "communicationStyle",
    neg: "formal, professional, terse",
    neu: "balanced — neither stiff nor overly casual",
    pos: "informal, warm, casual, conversational",
  },
  {
    key: "timeOrientation",
    neg: "unhurried, patient, long-horizon thinker",
    neu: "neutral pace",
    pos: "urgent, time-pressured, wants to close fast",
  },
  {
    key: "trustLevel",
    neg: "suspicious, guarded, verifies before believing",
    neu: "default trust until given reason otherwise",
    pos: "trusting, open, gives benefit of the doubt",
  },
  {
    key: "emotionalExpressiveness",
    neg: "reserved, stoic, sticks to facts",
    neu: "expresses emotion when relevant, otherwise restrained",
    pos: "expressive, emotive, brings personality to the dialogue",
  },
] as const;

// JSON Schema for structured output.
const MAPPER_SCHEMA = {
  type: "object",
  properties: {
    signals: {
      type: "object",
      properties: Object.fromEntries(
        BEHAVIOR_DIMENSIONS.map((d) => [
          d.key,
          { type: "integer", enum: [-1, 0, 1] },
        ]),
      ),
      required: BEHAVIOR_DIMENSIONS.map((d) => d.key),
      additionalProperties: false,
    },
    notes: {
      type: "string",
      description:
        "Residual persona content from the user's prompt that doesn't fit cleanly into the seven signals. Under 80 words. Empty string if nothing residual.",
    },
  },
  required: ["signals", "notes"],
  additionalProperties: false,
} as const;

export interface MapUserBehaviorArgs {
  role: "buyer" | "seller";
  behaviorPrompt: string;
  personalContext?: string;
  apiKeyEnv?: string;
}

/**
 * Map a free-text behavior prompt into the seven-dimensional signal vector.
 * Uses the orchestrator's API key by default — conceptually this is "the
 * orchestrator setting up the user's agent" before the session starts.
 */
export async function mapUserBehavior(args: MapUserBehaviorArgs): Promise<MappedPersona> {
  const apiKey =
    process.env[args.apiKeyEnv ?? "ORCHESTRATOR_ANTHROPIC_API_KEY"] ??
    process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "behavior-mapper: set ORCHESTRATOR_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) to enable behavior mapping.",
    );
  }
  const client = new Anthropic({ apiKey });

  const dimText = BEHAVIOR_DIMENSIONS.map(
    (d) => `- ${d.key}: -1 = ${d.neg}; 0 = ${d.neu}; +1 = ${d.pos}`,
  ).join("\n");

  const userMessage = `You are translating a free-form user description of an AI agent's negotiation behavior into a fixed 7-dimensional signal vector.

The user is playing the **${args.role}** side in a one-on-one price negotiation. They have written the prompt below to describe how they want their agent to behave.

# User's behavior prompt
${args.behaviorPrompt.trim() || "(empty — infer all signals as 0)"}
${args.personalContext && args.personalContext.trim().length > 0 ? `\n# User's personal context (additional flavor)\n${args.personalContext.trim()}\n` : ""}
# The seven dimensions
${dimText}

For each dimension, output -1, 0, or +1. If the user's prompt doesn't directly address a dimension, infer a reasonable value from surrounding context, or default to 0. Be calibrated and conservative — don't over-interpret.

Capture anything in the user's prompt that does NOT fit cleanly into these seven dimensions in the \`notes\` field — short prose, under 80 words. This is the residual persona content (e.g. domain-specific tactics, hard constraints, voice/tone tics) that the seven axes can't represent. If nothing residual, return an empty string.

Return JSON only, matching the schema.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    output_config: { format: { type: "json_schema", schema: MAPPER_SCHEMA } },
    system:
      "You translate free-form behavior descriptions into a fixed seven-dimensional signal vector. Be calibrated and conservative — don't over-interpret. Capture only what the prompt actually says or strongly implies.",
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("behavior-mapper: response had no text block");
  return JSON.parse(text.text) as MappedPersona;
}

/**
 * Random 7-signal vector for the opponent. Uniform over {-1, 0, +1} per axis.
 * Stored in the pack file at setup time, so replays reuse the same opponent.
 */
export function randomizeSignals(rng: () => number = Math.random): BehaviorSignals {
  const pick = (): Signal => {
    const r = rng();
    if (r < 1 / 3) return -1;
    if (r < 2 / 3) return 0;
    return 1;
  };
  return {
    assertiveness: pick(),
    flexibility: pick(),
    riskTolerance: pick(),
    communicationStyle: pick(),
    timeOrientation: pick(),
    trustLevel: pick(),
    emotionalExpressiveness: pick(),
  };
}

/** Render the signals (and optional residual notes) as a system-prompt section. */
export function renderBehaviorSection(signals: BehaviorSignals, notes?: string): string {
  const lines: string[] = ["## Behavioral profile"];
  for (const d of BEHAVIOR_DIMENSIONS) {
    const v = signals[d.key];
    const desc = v === -1 ? d.neg : v === 1 ? d.pos : d.neu;
    const sign = v > 0 ? "+1" : v < 0 ? "-1" : "0";
    lines.push(`- ${d.key} = ${sign} (${desc})`);
  }
  if (notes && notes.trim().length > 0) {
    lines.push("");
    lines.push(`Additional persona notes from the user:`);
    lines.push(notes.trim());
  }
  return lines.join("\n");
}
