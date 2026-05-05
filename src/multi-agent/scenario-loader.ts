// Scenario Pack loader + validator.
//
// Validates at load time, not run time. A bad pack fails fast with a clear
// error before the engine spins up any LLM calls.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ScenarioPack } from "./types.ts";

const ToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});

const LLMConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().optional(),
  thinkingBudget: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  apiKeyEnv: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
});

const MemoryPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("verbatim") }),
  z.object({
    type: z.literal("summarized"),
    keepRecent: z.number().int().nonnegative(),
    maxContextTokens: z.number().int().positive(),
  }),
  z.object({ type: z.literal("external"), storeKey: z.string() }),
  z.object({ type: z.literal("none") }),
]);

const ParticipantSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  llm: LLMConfigSchema,
  systemPromptTemplate: z.string().min(1),
  brief: z.record(z.unknown()),
  publicProfile: z.record(z.unknown()).optional(),
  tools: z.array(ToolDefSchema),
  outputSchema: z.record(z.unknown()).optional(),
  memoryPolicy: MemoryPolicySchema.optional(),
  contextFilterModule: z.string().optional(),
});

const DecisionSlotSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    type: z.literal("number"),
    range: z.tuple([z.number(), z.number()]),
    unit: z.string().optional(),
  }),
  z.object({ name: z.string(), type: z.literal("enum"), options: z.array(z.string()).min(1) }),
  z.object({ name: z.string(), type: z.literal("boolean") }),
  z.object({ name: z.string(), type: z.literal("text"), maxLength: z.number().int().positive().optional() }),
  z.object({ name: z.string(), type: z.literal("json"), schema: z.record(z.unknown()) }),
]);

const DecisionSpaceSchema = z.object({
  freeText: z.boolean(),
  slots: z.array(DecisionSlotSchema).optional(),
});

const ProtocolHintsSchema = z.object({
  maxTurns: z.number().int().nonnegative().optional(),
  maxRounds: z.number().int().positive().optional(),
  deadlineMs: z.number().int().positive().optional(),
  speakingOrder: z.enum(["round-robin", "alternating", "free"]).optional(),
  orchestratorMode: z.enum(["default", "lazy", "eager", "decimated"]).optional(),
  decimationK: z.number().int().positive().optional(),
  permittedOutcomes: z.array(z.string()).min(1),
  maxOrchestratorTokens: z.number().int().positive().optional(),
  maxParticipantTokensPerTurn: z.number().int().positive().optional(),
  firstSpeaker: z.string().optional(),
});

const ScenarioPackSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  participants: z.array(ParticipantSchema).min(2),
  decisionSpace: DecisionSpaceSchema,
  protocolHints: ProtocolHintsSchema,
  agreementCriteria: z.string().min(1),
  agreementDetectorModule: z.string().optional(),
  utilityModule: z.string().optional(),
  customMetricsModule: z.string().optional(),
  ui: z.object({ observer: z.string().optional(), setup: z.string().optional() }).optional(),
  orchestrator: LLMConfigSchema.optional(),
});

export class ScenarioValidationError extends Error {
  issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

export async function loadScenarioPack(pathOrId: string): Promise<ScenarioPack> {
  const resolved = await resolveScenarioPath(pathOrId);
  const raw = await readFile(resolved, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return validateScenarioPack(parsed);
}

export function validateScenarioPack(raw: unknown): ScenarioPack {
  const result = ScenarioPackSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ScenarioValidationError(`Scenario pack invalid:\n  ${issues.join("\n  ")}`, issues);
  }
  const pack = result.data as ScenarioPack;

  // Cross-field invariants the schema can't express:
  const ids = new Set<string>();
  for (const p of pack.participants) {
    if (ids.has(p.id)) throw new ScenarioValidationError(`Duplicate participant id: ${p.id}`, [p.id]);
    ids.add(p.id);
  }
  if (!pack.decisionSpace.freeText && (!pack.decisionSpace.slots || pack.decisionSpace.slots.length === 0)) {
    throw new ScenarioValidationError(
      `decisionSpace.freeText is false but no slots are defined`,
      [],
    );
  }
  const firstSpeaker = pack.protocolHints.firstSpeaker;
  if (firstSpeaker !== undefined && !ids.has(firstSpeaker)) {
    throw new ScenarioValidationError(
      `protocolHints.firstSpeaker '${firstSpeaker}' is not a known participant id`,
      [firstSpeaker],
    );
  }
  return pack;
}

async function resolveScenarioPath(idOrPath: string): Promise<string> {
  // Absolute / relative path with extension — use directly.
  if (idOrPath.endsWith(".json") || idOrPath.includes(path.sep)) {
    return path.resolve(idOrPath);
  }
  // Treat as a scenario id under ./scenarios/<id>/pack.json or
  // ./multi-agent-core/examples/<id>.json (spec examples).
  const candidates = [
    path.resolve(`scenarios/${idOrPath}/pack.json`),
    path.resolve(`multi-agent-core/examples/${idOrPath}.json`),
  ];
  for (const c of candidates) {
    try {
      await readFile(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`Could not find scenario '${idOrPath}'. Tried:\n  ${candidates.join("\n  ")}`);
}
