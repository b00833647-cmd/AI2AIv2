// Preview the agent system prompts produced by the new free-text pipeline.
// No API key needed — just builds a pack with sample participant inputs and
// prints what each agent will see. Use this to sanity-check the pack-builder
// changes before running a live session.
//
// Usage:
//   npx tsx src/cli/preview-prompts.ts                # default sample
//   npx tsx src/cli/preview-prompts.ts seller         # participant plays seller
//   npx tsx src/cli/preview-prompts.ts buyer tough    # force opponent personality

import {
  buildPack,
  OPPONENT_PERSONALITIES,
  type IntakeAnswers,
  type OpponentPersonality,
  type Role,
} from "../multi-agent/pack-builder.ts";

// Sample participant inputs — what they'd type on screens 5 and 6.
const SAMPLE_PERSONAL_CONTEXT = `I just relocated to Paris from Lyon for a new
position at a consulting firm. I sold my old car before the move and need a
reliable daily driver for the commute and occasional weekend trips back home
to see my parents. I've been pre-approved for financing but I'd actually
prefer to pay cash to avoid the paperwork — I have the funds available now.
Ideally I want to close this week so I can stop relying on rentals.`.replace(
  /\n/g,
  " ",
);

const SAMPLE_BEHAVIOR_PROMPT_BUYER = `Be respectful but firm. Don't go above
$22,500 — we have other options if this doesn't work out. Mention I'm a cash
buyer ready to wire funds tomorrow if it helps move the price down.
Don't waste time on small talk; get to a number quickly. If they refuse to
move from their listing price after two rounds, walk away politely.`.replace(
  /\n/g,
  " ",
);

const SAMPLE_BEHAVIOR_PROMPT_SELLER = `Hold the line on price. The car is in
excellent condition with full service history and I'm not in a rush to sell.
Lead with the new tires and the dealer service record. If they insist on going
below $24,000, politely end the conversation. I'd rather wait another week than
underprice this.`.replace(/\n/g, " ");

const STIMULUS = {
  mileage: "32,000 mi",
  customizations:
    "All-weather floor mats added; new Michelin tires installed 2 months ago; dealer-serviced.",
  marketPrice: 24000,
  sellerListing: 25500,
  sellerMinimum: 22500,
  buyerTarget: 21500,
  buyerMax: 23500,
} as const;

function bar(title: string): void {
  const line = "═".repeat(80);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function sub(title: string): void {
  const line = "─".repeat(80);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function preview(role: Role, opponentPersonality: OpponentPersonality): void {
  const intake: IntakeAnswers = {
    ...STIMULUS,
    userRole: role,
    userPersonalContext: SAMPLE_PERSONAL_CONTEXT,
    userBehaviorPrompt:
      role === "buyer" ? SAMPLE_BEHAVIOR_PROMPT_BUYER : SAMPLE_BEHAVIOR_PROMPT_SELLER,
  };

  const pack = buildPack({ answers: intake, opponentPersonality });

  bar(`PARTICIPANT ROLE: ${role.toUpperCase()}   |   OPPONENT PERSONALITY: ${opponentPersonality}`);

  for (const p of pack.participants) {
    const isParticipant =
      (p.id === "buyer" && role === "buyer") || (p.id === "seller" && role === "seller");
    const label = isParticipant ? "PARTICIPANT'S AGENT" : "OPPONENT'S AGENT";
    sub(`[${label}]   ${p.id.toUpperCase()}   (model: ${p.human ? "human" : p.llm?.model ?? "?"})`);
    console.log(p.systemPromptTemplate);
  }
}

const args = process.argv.slice(2);
const role: Role = args[0] === "seller" ? "seller" : "buyer";
const personalityArg = args[1] as OpponentPersonality | undefined;
const personality: OpponentPersonality =
  personalityArg && OPPONENT_PERSONALITIES.includes(personalityArg)
    ? personalityArg
    : "moderate";

preview(role, personality);

console.log(`\n(Try other combinations:`);
console.log(`  npx tsx src/cli/preview-prompts.ts buyer easygoing`);
console.log(`  npx tsx src/cli/preview-prompts.ts buyer tough`);
console.log(`  npx tsx src/cli/preview-prompts.ts seller easygoing`);
console.log(`  npx tsx src/cli/preview-prompts.ts seller tough)`);
