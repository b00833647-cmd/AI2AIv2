// Participant runtime — one programmable shell per scenario participant.
//
// Receives a curated context string, calls its LLM with its own tools,
// returns a structured Turn. Holds no inter-participant state.

import { nanoid } from "nanoid";
import type {
  LLMConfig,
  Participant,
  ParticipantId,
  Turn,
  TurnId,
  ToolCall,
  SessionId,
} from "./types.ts";
import { createLLMClient, type LLMClient } from "./llm.ts";
import { renderTemplate } from "./prompt.ts";

export interface ParticipantTurnInput {
  sessionId: SessionId;
  turnNumber: number;
  context: string;
  /** Single-sentence orchestrator instruction, prepended to the user message. */
  instruction?: string;
  /** Moderator broadcasts queued for this participant on this turn. */
  broadcasts?: string[];
  /** Compressed-context summary that replaces older transcript history. */
  compressedSummary?: string;
}

export class ParticipantRuntime {
  readonly id: ParticipantId;
  readonly role: string;
  readonly model: string;
  private readonly participant: Participant;
  private readonly llm: LLMClient;
  private readonly systemPrompt: string;
  /**
   * Image content blocks (e.g. listing photos) attached to every turn's user
   * message. Cached via Anthropic prompt caching — see llm.ts. Empty array
   * if the participant doesn't have images, in which case the LLM call is
   * text-only.
   */
  private readonly images: Array<{ mediaType: string; data: string }>;

  constructor(participant: Participant) {
    if (!participant.llm) {
      throw new Error(
        `ParticipantRuntime created for '${participant.id}' but llm is undefined. ` +
        `Human participants must not be wrapped in ParticipantRuntime.`,
      );
    }
    this.participant = participant;
    this.id = participant.id;
    this.role = participant.role;
    this.model = participant.llm.model;
    this.llm = createLLMClient(participant.llm);
    this.systemPrompt = renderParticipantSystem(participant);
    this.images = (participant.images ?? []).map((img) => ({ mediaType: img.mediaType, data: img.data }));
  }

  async takeTurn(input: ParticipantTurnInput): Promise<Turn> {
    const userMessage = buildUserMessage(input);
    const response = await this.llm.call({
      systemStatic: this.systemPrompt,
      userMessage,
      userImages: this.images.length > 0 ? this.images : undefined,
      tools: this.participant.tools,
      toolChoice: "auto",
    });

    const id: TurnId = nanoid();
    const turn: Turn = {
      id,
      sessionId: input.sessionId,
      turnNumber: input.turnNumber,
      emitter: "participant",
      emitterId: this.id,
      toolCalls: response.toolCalls,
      message: extractParticipantMessage(response.toolCalls, response.message),
      thinking: response.thinking,
      tokens: response.tokens,
      latencyMs: response.latencyMs,
      model: response.model,
      timestamp: new Date().toISOString(),
    };
    return turn;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function renderParticipantSystem(p: Participant): string {
  return renderTemplate(p.systemPromptTemplate, { brief: p.brief, role: p.role });
}

function buildUserMessage(input: ParticipantTurnInput): string {
  const sections: string[] = [];

  if (input.compressedSummary) {
    sections.push(input.compressedSummary);
  }

  sections.push(input.context);

  if (input.broadcasts && input.broadcasts.length > 0) {
    for (const note of input.broadcasts) {
      sections.push(`[Moderator]: ${note}`);
    }
  }

  if (input.instruction) {
    sections.push(`[Orchestrator instruction]: ${input.instruction}`);
  }

  sections.push("It is your turn. Respond with a tool call.");
  return sections.join("\n\n");
}

/**
 * Some scenario tools (e.g. submit_proposal) carry the public message inside
 * the tool input. If a participant emitted no top-level text but its tool call
 * carries a `message` field, surface that as the public message so it shows in
 * the transcript and reaches the next participant.
 */
function extractParticipantMessage(
  toolCalls: ToolCall[],
  topLevelMessage: string | undefined,
): string | undefined {
  if (topLevelMessage && topLevelMessage.trim().length > 0) return topLevelMessage;
  for (const call of toolCalls) {
    if (call.input && typeof call.input === "object") {
      const input = call.input as Record<string, unknown>;
      if (typeof input["message"] === "string") return input["message"];
    }
  }
  return undefined;
}

export type { LLMConfig };
