// Build a Toyota-Camry-negotiation ScenarioPack from operator intake answers
// and resolved behavior signals. Shared by the setup CLI and the demo server.
//
// Pack construction is mechanical given:
//   - the intake answers (car facts, both sides' price targets, the user's
//     role, the user's personal context),
//   - the user's resolved 7-dim behavior signals + residual notes,
//   - the opponent's randomized 7-dim behavior signals.

import type { ScenarioPack } from "./types.ts";
import { renderBehaviorSection, type BehaviorSignals } from "./behavior-mapper.ts";

export type Role = "buyer" | "seller";

export interface IntakeAnswers {
  mileage: string;
  customizations: string;
  marketPrice: number;
  sellerListing: number;
  sellerMinimum: number;
  buyerTarget: number;
  buyerMax: number;
  userRole: Role;
  userPersonalContext: string;
  userBehaviorPrompt: string;
}

export interface PackBuildArgs {
  answers: IntakeAnswers;
  userSignals: BehaviorSignals;
  userNotes: string;
  opponentSignals: BehaviorSignals;
  scenarioId?: string;
}

const DEFAULT_SCENARIO_ID = "toyota-camry-negotiation";

const PROPOSAL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["propose", "counter", "accept", "reject"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", const: "price" },
          value: { type: "number" },
          justification: { type: "string" },
        },
        required: ["name", "value"],
      },
      minItems: 1,
      maxItems: 1,
    },
    reasoning: { type: "string" },
    message: {
      type: "string",
      description: "Public prose visible to the other party. MUST verbalize the offer.",
    },
    is_final: { type: "boolean" },
  },
  required: ["action", "issues", "message"],
};

const MESSAGE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    intent: {
      type: "string",
      enum: ["greeting", "clarification", "rapport", "stall", "objection", "other"],
    },
  },
  required: ["message"],
};

export function buildPack(args: PackBuildArgs): ScenarioPack {
  const { answers: a, userSignals, userNotes, opponentSignals } = args;
  const scenarioId = args.scenarioId ?? DEFAULT_SCENARIO_ID;

  const slotMin = Math.max(1, Math.floor(Math.min(a.sellerMinimum, a.buyerTarget) * 0.5));
  const slotMax = Math.ceil(Math.max(a.sellerListing, a.buyerMax) * 1.5);

  const carBlurb =
    `a black Toyota Camry 2023 with ${a.mileage} and no prior accidents, ` +
    `with a single previous owner.`;

  const buyerSignals = a.userRole === "buyer" ? userSignals : opponentSignals;
  const sellerSignals = a.userRole === "seller" ? userSignals : opponentSignals;
  const buyerNotes = a.userRole === "buyer" ? userNotes : "";
  const sellerNotes = a.userRole === "seller" ? userNotes : "";
  const buyerPersonalContext = a.userRole === "buyer" ? a.userPersonalContext : "";
  const sellerPersonalContext = a.userRole === "seller" ? a.userPersonalContext : "";

  const buyerSystemPrompt = buildBuyerSystemPrompt({
    carBlurb,
    customizations: a.customizations,
    marketPrice: a.marketPrice,
    targetPrice: a.buyerTarget,
    maxBudget: a.buyerMax,
    personalContext: buyerPersonalContext,
    signals: buyerSignals,
    notes: buyerNotes,
  });

  const sellerSystemPrompt = buildSellerSystemPrompt({
    carBlurb,
    customizations: a.customizations,
    marketPrice: a.marketPrice,
    listingPrice: a.sellerListing,
    minimumAcceptablePrice: a.sellerMinimum,
    personalContext: sellerPersonalContext,
    signals: sellerSignals,
    notes: sellerNotes,
  });

  const sharedCar = {
    make: "Toyota",
    model: "Camry",
    year: 2023,
    color: "black",
    mileage: a.mileage,
    customizations: a.customizations,
    priorAccidents: false,
    previousOwners: 1,
  };

  return {
    id: scenarioId,
    version: "0.2.0",
    name: "Toyota Camry Negotiation (intake-driven, behavior-mapped)",
    description:
      "A two-party negotiation over a black 2023 Toyota Camry between a buyer and seller agent. " +
      "Single-issue: price only. Both agents are briefed from intake forms; the operator-controlled " +
      "side has its 7-dim behavioral profile mapped from a free-text prompt by an LLM, while the " +
      "opponent's profile is randomized at setup time and baked into the pack for replay reproducibility.",
    participants: [
      {
        id: "buyer",
        role: "Buyer",
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 4000,
          apiKeyEnv: "BUYER_ANTHROPIC_API_KEY",
        },
        systemPromptTemplate: buyerSystemPrompt,
        brief: {
          targetPrice: a.buyerTarget,
          maxBudget: a.buyerMax,
          marketPrice: a.marketPrice,
          personalContext: buyerPersonalContext,
          car: sharedCar,
          behavior: {
            signals: buyerSignals,
            notes: buyerNotes,
            origin: a.userRole === "buyer" ? "user-mapped" : "random",
          },
        },
        publicProfile: { type: "private buyer", shoppingFor: "a 2023 Toyota Camry" },
        tools: [
          {
            name: "submit_proposal",
            description: "Make a formal price offer with a public message conveying it in prose.",
            inputSchema: PROPOSAL_TOOL_SCHEMA,
          },
          {
            name: "send_message",
            description: "Send a conversational message without making a formal offer.",
            inputSchema: MESSAGE_TOOL_SCHEMA,
          },
        ],
        memoryPolicy: { type: "summarized", keepRecent: 5, maxContextTokens: 60000 },
      },
      {
        id: "seller",
        role: "Seller",
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 4000,
          apiKeyEnv: "SELLER_ANTHROPIC_API_KEY",
        },
        systemPromptTemplate: sellerSystemPrompt,
        brief: {
          listingPrice: a.sellerListing,
          minimumAcceptablePrice: a.sellerMinimum,
          marketPrice: a.marketPrice,
          personalContext: sellerPersonalContext,
          car: sharedCar,
          behavior: {
            signals: sellerSignals,
            notes: sellerNotes,
            origin: a.userRole === "seller" ? "user-mapped" : "random",
          },
        },
        publicProfile: { type: "private seller", listing: "a 2023 Toyota Camry" },
        tools: [
          {
            name: "submit_proposal",
            description: "Make a formal price offer with a public message conveying it in prose.",
            inputSchema: PROPOSAL_TOOL_SCHEMA,
          },
          {
            name: "send_message",
            description: "Send a conversational message without making a formal offer.",
            inputSchema: MESSAGE_TOOL_SCHEMA,
          },
        ],
        memoryPolicy: { type: "summarized", keepRecent: 5, maxContextTokens: 60000 },
      },
    ],
    decisionSpace: {
      freeText: false,
      slots: [{ name: "price", type: "number", range: [slotMin, slotMax], unit: "USD" }],
    },
    protocolHints: {
      // No engine-side caps on turns or orchestrator tokens. The orchestrator
      // decides when to terminate (agreed / impasse / pause). Stuck-state
      // safety nets (3-strikes orchestrator failure → round-robin fallback;
      // 5 non-terminal decisions in a row → abort) still apply.
      maxRounds: 10, // soft hint to the orchestrator
      speakingOrder: "alternating",
      orchestratorMode: "default",
      permittedOutcomes: ["agreed", "rejected", "impasse", "timeout", "aborted"],
      maxParticipantTokensPerTurn: 4000,
      // The buyer always opens with an inquiry/offer — orchestrator-enforced.
      firstSpeaker: "buyer",
    },
    agreementCriteria:
      "Agreement requires that one party calls submit_proposal with action='accept' confirming the other " +
      "party's most recent price proposal, OR that both parties propose the same price within the same round. " +
      "A 'reject' action by either party with is_final=true ends the session as 'rejected'. If neither happens " +
      "within maxRounds, declare 'impasse'.",
  };
}

interface BuildSystemArgs {
  carBlurb: string;
  customizations: string;
  marketPrice: number;
  personalContext: string;
  signals: BehaviorSignals;
  notes: string;
}

function buildBuyerSystemPrompt(
  args: BuildSystemArgs & { targetPrice: number; maxBudget: number },
): string {
  return `You are an AI agent negotiating to BUY a used car on behalf of a human buyer.

The car is ${args.carBlurb}
Customizations / recent repairs (per the seller): ${args.customizations}
Average market price: $${args.marketPrice.toLocaleString()}.

Your buyer's target purchase price: $${args.targetPrice.toLocaleString()}
Your buyer's WALK-AWAY maximum (do NOT exceed under any circumstances): $${args.maxBudget.toLocaleString()}

## Personal context provided by your buyer (REQUIRED — use it actively)
${args.personalContext.trim().length > 0 ? args.personalContext.trim() : "(none provided — negotiate professionally without inventing personal details.)"}

${renderBehaviorSection(args.signals, args.notes)}

You have two tools:
  - submit_proposal: make a formal offer (action: propose | counter | accept | reject) with a single \`price\` issue.
  - send_message: conversation, clarification, rapport, no formal offer.

Always verbalize your offer in the proposal's \`message\` field — the seller cannot see structured data, only your prose.

Negotiate consistently with your behavioral profile above: anchor reasonably given the market, concede in proportion to the seller's concessions, and never exceed your walk-away maximum. If pushed above your walk-away, decline politely and end the negotiation.

REQUIRED — your buyer's personal context is NOT background. It is the source of legitimate leverage and the reason you sound like a real human and not a script. Across this negotiation:
  - Reference SPECIFIC details from their context — their situation, constraints, reasons for wanting this car, timing, financial position.
  - Use those specifics as negotiating levers when relevant (e.g. mention you're cash-funded and can close this week if they said so; mention they just relocated for a new job and need something reliable if that's their situation).
  - Spread references across MULTIPLE TURNS, not just the opening message — the seller should keep hearing the buyer as a real, specific person throughout.
  - Do NOT invent details that aren't in the personal context. If they didn't mention being a cash buyer, don't claim it. If they didn't say they're in a hurry, don't fake urgency.
  - If the personal context is empty, fall back to professional negotiation — never fabricate.

IMPORTANT — keep your messages concise. 1–3 short sentences per turn is the target. No lengthy preambles, no repeating yourself, no restating the seller's position back to them. Get to the point: state your offer, give one reason (drawn from the personal context where possible), stop.`;
}

function buildSellerSystemPrompt(
  args: BuildSystemArgs & { listingPrice: number; minimumAcceptablePrice: number },
): string {
  return `You are an AI agent negotiating to SELL a used car on behalf of a human seller.

The car is ${args.carBlurb}
Customizations / recent repairs: ${args.customizations}
Average market price: $${args.marketPrice.toLocaleString()}.

Your seller's listing price: $${args.listingPrice.toLocaleString()}
Your seller's WALK-AWAY minimum (do NOT accept anything below this): $${args.minimumAcceptablePrice.toLocaleString()}

## Personal context provided by your seller (REQUIRED — use it actively)
${args.personalContext.trim().length > 0 ? args.personalContext.trim() : "(none provided — negotiate professionally without inventing personal details.)"}

${renderBehaviorSection(args.signals, args.notes)}

You have two tools:
  - submit_proposal: make a formal offer (action: propose | counter | accept | reject) with a single \`price\` issue.
  - send_message: conversation, clarification, rapport, no formal offer.

Always verbalize your offer in the proposal's \`message\` field — the buyer cannot see structured data, only your prose.

Negotiate consistently with your behavioral profile above: defend the listing price firmly at first, then concede in response to the buyer's concessions, anchored on the car's condition, mileage, and recent repairs. Never accept anything below your walk-away minimum.

REQUIRED — your seller's personal context is NOT background. It is the source of legitimate framing and the reason you sound like a real human and not a script. Across this negotiation:
  - Reference SPECIFIC details from their context — their situation, why they're selling, timing, constraints, what's at stake for them personally.
  - Use those specifics naturally as part of your reasoning (e.g. mention you're moving in 4 weeks and need a clean sale if they said so; mention this is the family car they've maintained meticulously if that's their situation).
  - Spread references across MULTIPLE TURNS, not just the opening message — the buyer should keep hearing the seller as a real, specific person throughout.
  - Do NOT invent details that aren't in the personal context. If they didn't mention urgency, don't fabricate a deadline. If they didn't say it was a family car, don't claim it.
  - If the personal context is empty, fall back to professional negotiation — never fabricate.

IMPORTANT — keep your messages concise. 1–3 short sentences per turn is the target. No lengthy preambles, no repeating yourself, no restating the buyer's position back to them. Get to the point: state your counter, give one reason (drawn from the personal context where possible), stop.`;
}
