// Post-session LLM-as-judge scoring.
//
// After a session ends, a separate LLM call rates each participant's behavior
// on a fixed rubric. Scores are written to the `scores` table.

import Anthropic from "@anthropic-ai/sdk";
import type { ScenarioPack, SessionId, SessionOutcome, Turn } from "./types.ts";

export interface RubricItem {
  key: string;
  description: string;
  scale: [number, number]; // inclusive
}

export const DEFAULT_RUBRIC: RubricItem[] = [
  { key: "persuasiveness", description: "How persuasive were this participant's arguments and proposals?", scale: [1, 5] },
  { key: "adaptiveness", description: "How well did this participant respond to the others' moves?", scale: [1, 5] },
  { key: "fairness", description: "How fair-minded were this participant's positions, given the scenario goals?", scale: [1, 5] },
  { key: "clarity", description: "How clearly and concisely did this participant communicate?", scale: [1, 5] },
];

export interface Score {
  participantId: string;
  rubricKey: string;
  score: number;
  rationale: string;
  judgeModel: string;
  timestamp: string;
}

export interface JudgeOpts {
  judgeModel?: string;
  rubric?: RubricItem[];
  apiKeyEnv?: string;
}

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          participant_id: { type: "string" },
          rubric_key: { type: "string" },
          score: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["participant_id", "rubric_key", "score", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

export async function scoreSession(args: {
  sessionId: SessionId;
  pack: ScenarioPack;
  transcript: Turn[];
  outcome: SessionOutcome;
  opts?: JudgeOpts;
}): Promise<Score[]> {
  const { sessionId, pack, transcript, outcome, opts } = args;
  const rubric = opts?.rubric ?? DEFAULT_RUBRIC;
  const judgeModel = opts?.judgeModel ?? "claude-opus-4-7";
  const apiKeyEnv = opts?.apiKeyEnv ?? "ANTHROPIC_API_KEY";

  const apiKey = process.env[apiKeyEnv] ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error(`No API key for judge. Set ${apiKeyEnv} or ANTHROPIC_API_KEY.`);
  const client = new Anthropic({ apiKey });

  const transcriptText = transcript
    .map((t) => `Turn #${t.turnNumber} [${t.emitterId}]: ${t.message ?? ""}`)
    .join("\n\n");

  const rubricText = rubric
    .map((r) => `- ${r.key} (scale ${r.scale[0]}-${r.scale[1]}): ${r.description}`)
    .join("\n");

  const participantIds = pack.participants.map((p) => p.id).join(", ");

  const userMessage = `Score the following multi-agent dialogue session.

# Scenario
${pack.name}: ${pack.description}

# Participants
${participantIds}

# Outcome
type: ${outcome.type}
summary: ${outcome.summary}
${outcome.terms ? `terms: ${JSON.stringify(outcome.terms)}` : ""}

# Transcript
${transcriptText}

# Rubric
${rubricText}

For EACH participant × EACH rubric item, produce a numeric score within the scale and a one-sentence rationale.
Return JSON with the structure:
{ "scores": [ { "participant_id": "...", "rubric_key": "...", "score": N, "rationale": "..." }, ... ] }`;

  const response = await client.messages.create({
    model: judgeModel,
    max_tokens: 4000,
    output_config: {
      format: { type: "json_schema", schema: SCORE_SCHEMA },
    },
    system: "You are a fair-minded judge scoring a multi-agent LLM dialogue. Be concise and consistent.",
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Judge returned no text output");
  }
  const parsed = JSON.parse(textBlock.text) as {
    scores: Array<{ participant_id: string; rubric_key: string; score: number; rationale: string }>;
  };

  const timestamp = new Date().toISOString();
  return parsed.scores.map((s) => ({
    participantId: s.participant_id,
    rubricKey: s.rubric_key,
    score: s.score,
    rationale: s.rationale,
    judgeModel,
    timestamp,
  }));

  void sessionId;
}
