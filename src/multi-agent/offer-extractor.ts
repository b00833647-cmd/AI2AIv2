// Offer extractor — a focused LLM call that reads ONE participant turn and
// decides whether the speaker put a price on the table as their own offer.
//
// Architecturally this is a "second brain" alongside the main orchestrator:
//   - The main orchestrator decides who speaks next + when to terminate.
//   - The extractor decides what was said, specifically: did this turn
//     contain a binding offer, and what number?
//
// Why we need it: the strict offer-board policy in extractTurnPrice() only
// counts formal `submit_proposal` toolCalls. When an agent (or human typing
// freely) puts a number in `send_message` text instead — "How about 23K?",
// "I'd do $22,500", "25500 is out of my budget, can we say 23?" — the
// regex fallback we used to ship was unreliable: it couldn't distinguish
// quoted numbers from offered ones, didn't handle K-notation, and flat-out
// got the wrong price on messages with mixed quote + offer.
//
// An LLM with a short prompt nails this in one shot. We use Sonnet for
// reliability (extraction quality matters more than cost — the alternative
// is a wrong price on the participant's offer board, which Amir flagged).
// Cost is small: ~150–300 input tokens + ~60 output per call,
// ≈ $0.0008 per extraction. Only runs when the turn lacks submit_proposal.
//
// Returns null on any failure (network, parse, missing API key, etc.) —
// the caller treats null as "no offer detected" and the board stays put.

import Anthropic from "@anthropic-ai/sdk";

export interface OfferExtraction {
  /** True only if the speaker put a SPECIFIC price on the table as their OWN move. */
  has_offer: boolean;
  /** USD amount, present when has_offer is true. */
  price: number | null;
  /** Kind of move, present when has_offer is true. */
  action: "propose" | "counter" | "accept" | "reject" | null;
  /** Confidence in the extraction. "low" = treat as no offer. */
  confidence: "high" | "medium" | "low";
  /** 1-2 sentence justification (logged for audit, not shown to user). */
  reasoning: string;
}

const EXTRACTOR_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    has_offer: {
      type: "boolean" as const,
      description:
        "True only if the speaker put a SPECIFIC numeric price forward as their OWN offer/counter/accept. " +
        "False if there's no price at all, or if the only number(s) they mention belong to the OTHER side " +
        "(quoted, referenced, but not their own move).",
    },
    price: {
      type: "number" as const,
      description:
        "The numeric price in USD. Required when has_offer is true. " +
        "Treat 'K' / 'k' as thousands (e.g. '23K' = 23000, '22.5k' = 22500). Use 0 when has_offer is false.",
    },
    action: {
      type: "string" as const,
      enum: ["propose", "counter", "accept", "reject"] as const,
      description:
        "Required when has_offer is true. propose = opening offer, counter = changing their own price " +
        "(most common), accept = taking the other side's exact offer, reject = walking away with no price.",
    },
    confidence: {
      type: "string" as const,
      enum: ["high", "medium", "low"] as const,
      description:
        "high = unambiguous; medium = likely but slightly ambiguous; low = very uncertain (caller should " +
        "treat as no offer).",
    },
    reasoning: {
      type: "string" as const,
      description: "1-2 sentence justification for the extraction. Logged for audit.",
    },
  },
  required: ["has_offer", "price", "confidence", "reasoning"] as const,
};

const SYSTEM_PROMPT = `You are an offer-extraction analyst for a private-party used-car negotiation. \
You read ONE message from one party and decide:

1. Did they put a SPECIFIC PRICE on the table as their own offer/counter/accept?
2. If yes, what's the price (in USD), and what kind of move (propose / counter / accept / reject)?

CRITICAL DISTINCTION
- An OFFER is the speaker putting a number forward as their own position.
- A QUOTE is the speaker mentioning a number that the OTHER side proposed (or that exists in the listing) — \
they're referencing it, not making it their own move.

The same message can contain BOTH a quote (the other side's number) AND an offer (the speaker's own number). \
Pick the SPEAKER'S OWN OFFER — never the quote.

NORMALIZATION RULES
- "K" / "k" suffix means thousands. "23K" = 23000. "22.5K" = 22500. "$23k" = 23000.
- Comma format ($21,500) and bare format (21500) both mean the same thing.
- Plausible price range for this car: $5,000 – $100,000. Numbers outside this range are not prices.

EXAMPLES
- "I can do $22,500" → has_offer=true, price=22500, action=counter, confidence=high
- "How about $23K?" → has_offer=true, price=23000, action=counter, confidence=high
- "But 25500 is out of my budget. How about 23K?" → has_offer=true, price=23000, action=counter, confidence=high
  (25500 is the listing the speaker is REJECTING; 23K is what they actually offer)
- "Your $25,500 is too high — I'll have to think." → has_offer=false, confidence=high
  (only quoting the other side; no own offer)
- "Sounds good, deal at $24,000." → has_offer=true, price=24000, action=accept, confidence=high
- "I'll have to walk away." → has_offer=false, confidence=high
  (rejecting, no specific number mentioned — no offer to record)
- "What's the lowest you'd go?" → has_offer=false, confidence=high
- "Maybe around 22K?" → has_offer=true, price=22000, action=counter, confidence=medium
- "Hi! How are you doing?" → has_offer=false, confidence=high

BE CONSERVATIVE
If you're uncertain whether a number is the speaker's own offer or a quote, set has_offer=false with low confidence. \
A missed offer is recoverable on the next turn; a wrong offer on the participant's live board is not.

Always call the report tool with your decision.`;

let __cachedClient: Anthropic | null = null;
let __cachedKey: string | null = null;
function getClient(): Anthropic | null {
  // Use the orchestrator's key when available (extraction is orchestrator-side
  // analysis, fits the orchestrator workspace's spend cap). Falls back to the
  // shared key, then null when nothing's configured.
  const key = process.env["ORCHESTRATOR_ANTHROPIC_API_KEY"]
           || process.env["ANTHROPIC_API_KEY"]
           || "";
  if (!key) return null;
  if (__cachedClient && __cachedKey === key) return __cachedClient;
  __cachedClient = new Anthropic({ apiKey: key });
  __cachedKey = key;
  return __cachedClient;
}

/**
 * Extract an offer from a single message. Returns null on any failure or
 * when no client is configured. Otherwise returns the structured decision.
 */
export async function extractOffer(
  message: string,
  speakerRole: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<OfferExtraction | null> {
  if (!message || message.trim().length === 0) return null;
  const client = getClient();
  if (!client) return null;

  const model = opts?.model ?? "claude-sonnet-4-6";
  const timeoutMs = opts?.timeoutMs ?? 8000;

  try {
    const respPromise = client.messages.create({
      model,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      tools: [{
        name: "report",
        description: "Report the offer-extraction result for this single message.",
        input_schema: EXTRACTOR_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      }],
      tool_choice: { type: "tool", name: "report" },
      messages: [{
        role: "user",
        content: `Speaker role: ${speakerRole}\n\nMessage to analyze:\n"""\n${message}\n"""\n\nCall the report tool with your extraction.`,
      }],
    });

    // Add a soft timeout so extraction never blocks the SSE stream forever.
    const result = await Promise.race([
      respPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("offer-extractor timeout")), timeoutMs),
      ),
    ]);

    const toolUse = result.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return null;
    const input = toolUse.input as Partial<OfferExtraction>;
    if (typeof input.has_offer !== "boolean") return null;

    return {
      has_offer: input.has_offer,
      price: typeof input.price === "number" && Number.isFinite(input.price) ? input.price : null,
      action: (input.action ?? null) as OfferExtraction["action"],
      confidence: (input.confidence ?? "low") as OfferExtraction["confidence"],
      reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
    };
  } catch (err) {
    // Quiet failure — never crash the session over an extraction error.
    // Caller treats null as "no offer detected" → board stays put.
    console.warn(`[offer-extractor] ${(err as Error).message}`);
    return null;
  }
}
