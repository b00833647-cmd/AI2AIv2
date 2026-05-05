// Run a single scenario session.
//
// Usage:
//   npm run run -- <scenario-id-or-path> [--no-persist] [--quiet]
//   npm run run -- buyer-seller-negotiation
//   npm run run -- multi-agent-core/examples/buyer-seller-negotiation.json

import "node:process";
import { loadScenarioPack } from "../multi-agent/scenario-loader.ts";
import { runSession } from "../multi-agent/session-runner.ts";
import { openPersistence } from "../multi-agent/persistence.ts";
import { DEFAULT_ORCHESTRATOR_LLM } from "../multi-agent/orchestrator.ts";

interface CliArgs {
  scenario: string;
  persist: boolean;
  quiet: boolean;
  orchModel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let persist = true;
  let quiet = false;
  let orchModel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--no-persist") persist = false;
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a === "--orch-model") {
      orchModel = argv[++i];
      if (!orchModel) throw new Error("--orch-model requires a value");
    } else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error("usage: run <scenario-id-or-path> [--no-persist] [--quiet] [--orch-model M]");
  }
  return { scenario: positional[0]!, persist, quiet, orchModel };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pack = await loadScenarioPack(args.scenario);

  const persistence = args.persist ? openPersistence() : undefined;
  try {
    const orchestratorLLM = args.orchModel
      ? { ...(pack.orchestrator ?? DEFAULT_ORCHESTRATOR_LLM), model: args.orchModel }
      : undefined;
    const result = await runSession({
      pack,
      persistence,
      orchestratorLLM,
      verbose: !args.quiet,
    });
    if (args.quiet) {
      // In quiet mode we still print a final one-line summary.
      console.log(JSON.stringify({
        sessionId: result.sessionId,
        outcome: result.outcome.type,
        turns: result.consumed.turns,
        tokens: result.consumed.tokensTotal,
        degraded: result.degraded,
      }));
    }
    if (persistence) {
      console.log(`\nSession persisted as ${result.sessionId} in ${process.env["AI2AI_DB_PATH"] ?? "./data/sessions.db"}`);
    }
  } finally {
    persistence?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
