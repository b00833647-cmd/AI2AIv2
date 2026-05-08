// Conversation memory + transcript views.
//
// The orchestrator decides what each participant sees. By default each
// participant gets a chronological transcript of public messages and tool
// calls (their own private thinking is excluded — that's never serialized
// across the wire). MemoryPolicy lets a scenario tighten this further:
//
//   - verbatim:    full chronological transcript
//   - summarized:  keep recent N turns verbatim, the rest get summarized
//                  (summary supplied by the orchestrator's compress_context)
//   - external:    placeholder; not implemented in v0
//   - none:        only the very last turn

import type {
  MemoryPolicy,
  Participant,
  ParticipantId,
  Turn,
  ScenarioPack,
} from "./types.ts";
import { formatTurnForOrchestrator } from "./orchestrator.ts";

export interface ParticipantContextOpts {
  /** Replaces the default transcript view. Set by orchestrator's request_turn.context_override. */
  contextOverride?: string;
  /** Compressed history previously declared by orchestrator's compress_context. */
  compressedSummary?: string;
}

export function buildParticipantContext(
  participant: Participant,
  transcript: Turn[],
  pack: ScenarioPack,
  opts: ParticipantContextOpts = {},
): string {
  if (opts.contextOverride) return opts.contextOverride;

  const policy: MemoryPolicy = participant.memoryPolicy ?? { type: "verbatim" };
  const visibleTurns = filterTurnsForParticipant(transcript, participant.id);

  switch (policy.type) {
    case "verbatim":
      return renderTranscript(visibleTurns, participant, pack, opts.compressedSummary);
    case "summarized":
      return renderSummarized(visibleTurns, policy.keepRecent, participant, pack, opts.compressedSummary);
    case "external":
      // External memory not implemented in v0 — fall through to verbatim.
      return renderTranscript(visibleTurns, participant, pack, opts.compressedSummary);
    case "none":
      return renderTranscript(visibleTurns.slice(-1), participant, pack, opts.compressedSummary);
  }
}

function filterTurnsForParticipant(transcript: Turn[], _participantId: ParticipantId): Turn[] {
  // v0: every participant sees the public transcript. Per-participant
  // contextFilters are loaded by id but not yet executed (would require
  // dynamic module loading from the scenario directory).
  //
  // IMPORTANT: include both "participant" (LLM-driven) and "human" emitters.
  // In the human-vs-AI experiments (/bhx, /shx) the participant on one side is
  // a real person and their turns are stored with emitter="human". If we
  // filter those out, the AI counterpart sees an empty transcript and will
  // open as if it were the first to speak — which is why the seller used to
  // jump straight to a sales pitch even after the human had already greeted.
  return transcript.filter((t) => t.emitter === "participant" || t.emitter === "human");
}

function renderTranscript(
  turns: Turn[],
  participant: Participant,
  pack: ScenarioPack,
  compressedSummary: string | undefined,
): string {
  const header = renderRosterHeader(participant, pack);
  if (turns.length === 0 && !compressedSummary) {
    return `${header}\n\nNo turns have been taken yet. You are first to speak.`;
  }
  const lines: string[] = [header];
  if (compressedSummary) lines.push(compressedSummary);
  if (turns.length > 0) {
    lines.push("## Conversation so far");
    for (const t of turns) {
      lines.push(renderTurnPublicly(t, participant.id));
    }
  }
  return lines.join("\n\n");
}

function renderSummarized(
  turns: Turn[],
  keepRecent: number,
  participant: Participant,
  pack: ScenarioPack,
  compressedSummary: string | undefined,
): string {
  if (turns.length <= keepRecent) {
    return renderTranscript(turns, participant, pack, compressedSummary);
  }
  // Keep the last N verbatim. If the orchestrator has not supplied a
  // compressed summary for the older slice, render those older turns as a
  // bulleted overview (light auto-summary).
  const recent = turns.slice(-keepRecent);
  const older = turns.slice(0, -keepRecent);

  const summary =
    compressedSummary ??
    `## Earlier in this session (auto-summary)\n${older
      .map(
        (t) =>
          `- Turn #${t.turnNumber} ${t.emitterId}: ${shorten(extractPublicMessage(t), 200)}`,
      )
      .join("\n")}`;

  return renderTranscript(recent, participant, pack, summary);
}

function renderRosterHeader(participant: Participant, pack: ScenarioPack): string {
  const others = pack.participants
    .filter((p) => p.id !== participant.id)
    .map((p) => {
      const profile = p.publicProfile ? ` — ${JSON.stringify(p.publicProfile)}` : "";
      return `- ${p.id} (${p.role})${profile}`;
    })
    .join("\n");
  return `## Other participants in this session\n${others || "(none — you are alone)"}`;
}

function renderTurnPublicly(t: Turn, viewerId: ParticipantId): string {
  // Reuse the orchestrator-formatter shape, except: omit the private
  // 'tool_call' details for OTHER participants. The viewer always sees its
  // own structured calls (continuity); for others, only the public message
  // crosses the wire.
  if (t.emitterId === viewerId) {
    return formatTurnForOrchestrator(t);
  }
  const lines = [`Turn #${t.turnNumber} [${t.emitterId}]`];
  const msg = extractPublicMessage(t);
  if (msg) lines.push(msg);
  return lines.join("\n");
}

function extractPublicMessage(t: Turn): string {
  if (t.message && t.message.trim().length > 0) return t.message;
  for (const call of t.toolCalls) {
    if (call.input && typeof call.input === "object") {
      const m = (call.input as Record<string, unknown>)["message"];
      if (typeof m === "string") return m;
    }
  }
  return "(no public message)";
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
