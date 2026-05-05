// Replay a prior session's orchestrator decisions against fresh participants.
//
// Reads the orchestrator decision log from a recorded session and feeds it
// back into runSession instead of calling the orchestrator LLM. The
// participants run live (so their LLM calls are real). Useful for
// counterfactuals: "what would Bob have done if Alice had a different brief?".
//
// Usage:
//   npm run replay -- <prior-session-id>
//   npm run replay -- <prior-session-id> --pack scenarios/foo/pack.json   (override pack)

import { openPersistence } from "../multi-agent/persistence.ts";
import { runSession } from "../multi-agent/session-runner.ts";
import { loadScenarioPack } from "../multi-agent/scenario-loader.ts";

interface CliArgs {
  sessionId: string;
  packOverride?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let packOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--pack") {
      packOverride = argv[++i];
      continue;
    }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error("usage: replay <prior-session-id> [--pack <path>]");
  }
  return { sessionId: positional[0]!, packOverride };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const persistence = openPersistence();
  try {
    const decisions = await persistence.loadDecisions(args.sessionId);
    if (decisions.length === 0) {
      console.error(`No decisions found for session ${args.sessionId}.`);
      process.exit(1);
    }
    const pack = args.packOverride
      ? await loadScenarioPack(args.packOverride)
      : await persistence.loadPack(args.sessionId);

    console.log(`Replaying ${decisions.length} decisions from session ${args.sessionId}`);
    if (args.packOverride) console.log(`Using pack override: ${args.packOverride}`);

    const result = await runSession({
      pack,
      persistence,
      replayDecisions: decisions,
      verbose: true,
    });
    console.log(`\nReplay session: ${result.sessionId}`);
  } finally {
    persistence.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
