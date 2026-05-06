// Interactive setup for the Toyota Camry negotiation scenario.
//
// Flow:
//   1. Operator picks the role they're playing — buyer or seller.
//   2. Shared car-fact intake (mileage, customizations, market price).
//   3. Both sides' price intake (seller listing/min, buyer target/max).
//   4. The user's personal context (free text, only for their role).
//   5. The user's BEHAVIOR PROMPT (free text, only for their role) — embedded
//      verbatim in their agent's system prompt at session start.
//   6. The OPPONENT side gets one of three pre-written negotiating
//      personalities (easygoing | moderate | tough), drawn at random.
//   7. Pack written to scenarios/toyota-camry-negotiation/pack.json with the
//      participant text and chosen opponent personality baked in.
//
// Usage:
//   npm run setup
//   npm run setup -- --run            # also run the negotiation right after
//   npm run setup -- --from <path>    # non-interactive: read answers from JSON
//
// Reproducibility: the chosen opponent personality is baked into the pack at
// setup time, so replays / batch runs against the same pack.json reuse the
// same opponent. Re-run setup to reroll the opponent.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildPack,
  pickOpponentPersonality,
  type IntakeAnswers,
  type OpponentPersonality,
  type Role,
} from "../multi-agent/pack-builder.ts";

const SCENARIO_ID = "toyota-camry-negotiation";

interface SetupAnswers extends IntakeAnswers {
  /** Optional: pin the opponent's personality (for fixture replays). */
  opponentPersonalityOverride?: OpponentPersonality;
}

interface CliArgs {
  run: boolean;
  fromFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let run = false;
  let fromFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--run") run = true;
    else if (a === "--from") {
      fromFile = argv[++i];
      if (!fromFile) throw new Error("--from requires a path");
    } else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else throw new Error(`unexpected argument: ${a}`);
  }
  return { run, fromFile };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const answers = args.fromFile ? await readAnswers(args.fromFile) : await interactiveIntake();
  validate(answers);

  const opponentPersonality =
    answers.opponentPersonalityOverride ?? pickOpponentPersonality();

  const pack = buildPack({ answers, opponentPersonality, scenarioId: SCENARIO_ID });

  const outPath = path.resolve(`scenarios/${SCENARIO_ID}/pack.json`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(pack, null, 2));
  console.log(`\nWrote ${outPath}`);

  console.log(`\nUser side (${answers.userRole}) — behavior prompt:`);
  console.log(`  ${answers.userBehaviorPrompt.trim().slice(0, 200)}${answers.userBehaviorPrompt.length > 200 ? "…" : ""}`);

  const opponentRole: Role = answers.userRole === "buyer" ? "seller" : "buyer";
  console.log(`\nOpponent side (${opponentRole}) — personality: ${opponentPersonality}`);

  if (args.run) {
    console.log(`\nRunning the negotiation…\n`);
    const res = spawnSync(
      "npx",
      ["tsx", "src/cli/run.ts", SCENARIO_ID, "--orch-model", "claude-sonnet-4-6"],
      { stdio: "inherit", env: process.env },
    );
    process.exit(res.status ?? 0);
  } else {
    console.log(`\nRun with:  npm run run -- ${SCENARIO_ID}`);
  }
}

async function readAnswers(filePath: string): Promise<SetupAnswers> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as SetupAnswers;
}

function validate(a: SetupAnswers): void {
  const errs: string[] = [];
  if (a.userRole !== "buyer" && a.userRole !== "seller") {
    errs.push(`userRole must be 'buyer' or 'seller'; got '${String(a.userRole)}'`);
  }
  if (a.sellerMinimum > a.sellerListing) {
    errs.push(`seller minimum ($${a.sellerMinimum}) must be <= listing ($${a.sellerListing})`);
  }
  if (a.buyerMax < a.buyerTarget) {
    errs.push(`buyer max ($${a.buyerMax}) must be >= target ($${a.buyerTarget})`);
  }
  for (const v of [a.marketPrice, a.sellerListing, a.sellerMinimum, a.buyerTarget, a.buyerMax]) {
    if (!Number.isFinite(v) || v <= 0) errs.push(`prices must be positive numbers; got ${v}`);
  }
  if (errs.length > 0) {
    console.error("Setup answers invalid:");
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(1);
  }
}

// ─── Interactive intake ────────────────────────────────────────────────────

async function interactiveIntake(): Promise<SetupAnswers> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("\nAI2AI — Toyota Camry Negotiation Setup");
    console.log("======================================\n");
    console.log("This sets up a single-issue (price-only) negotiation between two AI agents.\n");

    // ─── Role selection ────────────────────────────────────────────────────
    rule("STEP 0 — Which role are you playing?");
    console.log("\nOnly your side's behavior is operator-controlled. Your opponent gets one of");
    console.log("three pre-written personalities (easygoing | moderate | tough), drawn at random.\n");
    const userRole = await pickRole(rl);

    // ─── Shared car facts ──────────────────────────────────────────────────
    rule("STEP 1 — Shared car facts");
    console.log(
      "\nThe car is a black Toyota Camry 2023 with [enter mileage] and no prior\n" +
        "accidents. It has had only one owner. [Add a couple of sentences about\n" +
        "the customizations or recent repairs of the car.] The average market\n" +
        "price for this is $[market price].\n",
    );
    const mileage = (await rl.question("Mileage (e.g. '32,000 mi' or '52000 km'): ")).trim();
    const customizations = (
      await rl.question("Customizations / recent repairs (one or two sentences): ")
    ).trim();
    const marketPrice = await numberQ(rl, "Average market price ($): ");

    // ─── Both sides' price intake ─────────────────────────────────────────
    rule("STEP 2 — Both sides' price targets");
    console.log(
      "\nYou enter both sides' price targets so the negotiation has well-defined\n" +
        "endpoints. Only your side's behavior prompt comes next.\n",
    );
    console.log("SELLER side:");
    const sellerListing = await numberQ(rl, "  listing price ($): ");
    const sellerMinimum = await numberQ(rl, "  minimum acceptable / walk-away ($): ");
    console.log("\nBUYER side:");
    const buyerTarget = await numberQ(rl, "  target purchase price ($): ");
    const buyerMax = await numberQ(rl, "  maximum / walk-away ($): ");

    // ─── User's personal context ──────────────────────────────────────────
    rule(`STEP 3 — Your (${userRole}) personal context`);
    console.log(
      "\nIn the box below, please add as many details as you wish about yourself,\n" +
        `your ${userRole === "buyer" ? "search for the car" : "reasons for selling"}.\n` +
        "These will help your AI agent.\n" +
        "(End input with a single '.' on its own line.)\n",
    );
    const userPersonalContext = await multilineQ(rl);

    // ─── User's behavior prompt ───────────────────────────────────────────
    rule(`STEP 4 — Your (${userRole}) behavior prompt`);
    console.log(
      "\nDescribe how you want your AI agent to behave during the negotiation.\n" +
        "Be specific about tactics, tone, risk appetite, time pressure, trust posture,\n" +
        "or any other behavioral preferences. Your prose is embedded verbatim in\n" +
        "your agent's system prompt — no translation step.\n" +
        "(End input with a single '.' on its own line.)\n",
    );
    const userBehaviorPrompt = await multilineQ(rl);

    return {
      userRole,
      mileage,
      customizations,
      marketPrice,
      sellerListing,
      sellerMinimum,
      buyerTarget,
      buyerMax,
      userPersonalContext,
      userBehaviorPrompt,
    };
  } finally {
    rl.close();
  }
}

function rule(title: string): void {
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n${title}\n${bar}`);
}

async function pickRole(rl: readline.Interface): Promise<Role> {
  while (true) {
    const a = (await rl.question("buyer or seller? ")).trim().toLowerCase();
    if (a === "buyer" || a === "seller") return a;
    console.log("  please answer 'buyer' or 'seller'.");
  }
}

async function numberQ(rl: readline.Interface, prompt: string): Promise<number> {
  while (true) {
    const raw = (await rl.question(prompt)).trim().replace(/[$,\s]/g, "");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    console.log("  please enter a positive number.");
  }
}

async function multilineQ(rl: readline.Interface): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const line = await rl.question("> ");
    if (line.trim() === ".") break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
