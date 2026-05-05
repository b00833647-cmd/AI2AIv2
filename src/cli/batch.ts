// Batch runner — N sessions in parallel, optionally varying participant
// configurations across a matrix.
//
// Usage:
//   npm run batch -- <scenario-id> --runs 5 [--concurrency 2]
//   npm run batch -- <scenario-id> --matrix matrix.json
//
// matrix.json shape (optional):
//   {
//     "runs_per_cell": 3,
//     "concurrency": 2,
//     "axes": {
//       "buyer.brief.strategy": ["aggressive", "balanced", "passive"],
//       "seller.brief.strategy": ["aggressive", "balanced"]
//     }
//   }

import { readFile } from "node:fs/promises";
import { loadScenarioPack } from "../multi-agent/scenario-loader.ts";
import { runSession } from "../multi-agent/session-runner.ts";
import { openPersistence, type SqlitePersistence } from "../multi-agent/persistence.ts";
import type { ScenarioPack, SessionOutcome } from "../multi-agent/types.ts";

interface MatrixSpec {
  runs_per_cell?: number;
  concurrency?: number;
  /** Axis paths look like "<participant_id>.brief.<key>" or "orchestrator.model". */
  axes?: Record<string, unknown[]>;
}

interface CliArgs {
  scenario: string;
  runs: number;
  concurrency: number;
  matrixPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let runs = 1;
  let concurrency = 1;
  let matrixPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--runs") {
      runs = Number(argv[++i]);
      continue;
    }
    if (a === "--concurrency") {
      concurrency = Number(argv[++i]);
      continue;
    }
    if (a === "--matrix") {
      matrixPath = argv[++i];
      continue;
    }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error("usage: batch <scenario-id> [--runs N] [--concurrency N] [--matrix matrix.json]");
  }
  return { scenario: positional[0]!, runs, concurrency, matrixPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const basePack = await loadScenarioPack(args.scenario);

  let cells: Array<{ pack: ScenarioPack; label: string }>;
  let runsPerCell = args.runs;
  let concurrency = args.concurrency;

  if (args.matrixPath) {
    const matrix = JSON.parse(await readFile(args.matrixPath, "utf-8")) as MatrixSpec;
    if (matrix.runs_per_cell) runsPerCell = matrix.runs_per_cell;
    if (matrix.concurrency) concurrency = matrix.concurrency;
    cells = expandMatrix(basePack, matrix.axes ?? {});
  } else {
    cells = [{ pack: basePack, label: "base" }];
  }

  // Flatten into individual runs.
  const tasks: Array<{ pack: ScenarioPack; label: string; replicate: number }> = [];
  for (const cell of cells) {
    for (let r = 0; r < runsPerCell; r++) {
      tasks.push({ pack: cell.pack, label: cell.label, replicate: r });
    }
  }

  console.log(`Batch: ${cells.length} cells × ${runsPerCell} runs = ${tasks.length} sessions, concurrency=${concurrency}`);

  const persistence = openPersistence();
  const results: BatchRunResult[] = [];
  try {
    const queue = tasks.slice();
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
      workers.push(workerLoop(queue, persistence, results));
    }
    await Promise.all(workers);

    printSummary(results);
  } finally {
    persistence.close();
  }
}

interface BatchRunResult {
  label: string;
  replicate: number;
  sessionId: string;
  outcome: SessionOutcome;
  turns: number;
  tokens: number;
  degraded: boolean;
  error?: string;
}

async function workerLoop(
  queue: Array<{ pack: ScenarioPack; label: string; replicate: number }>,
  persistence: SqlitePersistence,
  results: BatchRunResult[],
): Promise<void> {
  while (true) {
    const task = queue.shift();
    if (!task) return;
    try {
      const r = await runSession({ pack: task.pack, persistence, verbose: false });
      results.push({
        label: task.label,
        replicate: task.replicate,
        sessionId: r.sessionId,
        outcome: r.outcome,
        turns: r.consumed.turns,
        tokens: r.consumed.tokensTotal,
        degraded: r.degraded,
      });
      console.log(
        `[done] ${task.label}#${task.replicate} → ${r.outcome.type} (${r.consumed.turns} turns, ${r.consumed.tokensTotal} tokens${r.degraded ? ", degraded" : ""})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        label: task.label,
        replicate: task.replicate,
        sessionId: "(failed)",
        outcome: { type: "errored", summary: msg, rationale: msg, endedAt: new Date().toISOString() },
        turns: 0,
        tokens: 0,
        degraded: false,
        error: msg,
      });
      console.error(`[fail] ${task.label}#${task.replicate}: ${msg}`);
    }
  }
}

function printSummary(results: BatchRunResult[]): void {
  console.log("\n=== Batch summary ===");
  const byLabel = new Map<string, BatchRunResult[]>();
  for (const r of results) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label)!.push(r);
  }
  for (const [label, group] of byLabel) {
    const outcomeCounts = new Map<string, number>();
    let degradedCount = 0;
    let totalTokens = 0;
    let totalTurns = 0;
    for (const r of group) {
      outcomeCounts.set(r.outcome.type, (outcomeCounts.get(r.outcome.type) ?? 0) + 1);
      if (r.degraded) degradedCount += 1;
      totalTokens += r.tokens;
      totalTurns += r.turns;
    }
    const outcomes = [...outcomeCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(
      `${label}: n=${group.length}, outcomes=[${outcomes}], avg_turns=${(totalTurns / group.length).toFixed(1)}, avg_tokens=${Math.round(
        totalTokens / group.length,
      )}, degraded=${degradedCount}`,
    );
  }
}

// ─── Matrix expansion ──────────────────────────────────────────────────────

function expandMatrix(basePack: ScenarioPack, axes: Record<string, unknown[]>): Array<{ pack: ScenarioPack; label: string }> {
  const axisEntries = Object.entries(axes);
  if (axisEntries.length === 0) return [{ pack: basePack, label: "base" }];

  // Cartesian product of all axes.
  const cells: Array<{ pack: ScenarioPack; label: string }> = [];
  const indices = new Array(axisEntries.length).fill(0);

  const isDone = (): boolean => {
    for (let i = 0; i < axisEntries.length; i++) {
      const entry = axisEntries[i];
      if (entry === undefined) return true;
      if (indices[i] >= entry[1].length) return true;
    }
    return false;
  };

  while (!isDone()) {
    const pack = JSON.parse(JSON.stringify(basePack)) as ScenarioPack;
    const labelParts: string[] = [];
    for (let i = 0; i < axisEntries.length; i++) {
      const entry = axisEntries[i];
      if (entry === undefined) continue;
      const [path, values] = entry;
      const valIdx = indices[i] ?? 0;
      const value = values[valIdx];
      assignByPath(pack, path, value);
      labelParts.push(`${path}=${shortRepr(value)}`);
    }
    cells.push({ pack, label: labelParts.join(",") });

    // Increment last index, carry over.
    for (let i = axisEntries.length - 1; i >= 0; i--) {
      indices[i] = (indices[i] ?? 0) + 1;
      const entry = axisEntries[i];
      if (entry === undefined) break;
      if (indices[i] < entry[1].length) break;
      if (i === 0) {
        indices[i] = entry[1].length; // sentinel for done
        break;
      }
      indices[i] = 0;
    }
  }
  return cells;
}

function assignByPath(pack: ScenarioPack, path: string, value: unknown): void {
  // Path like "buyer.brief.strategy" or "orchestrator.model".
  const parts = path.split(".");
  if (parts[0] === "orchestrator") {
    if (!pack.orchestrator) pack.orchestrator = { provider: "anthropic", model: "" };
    setNested(pack.orchestrator as unknown as Record<string, unknown>, parts.slice(1), value);
    return;
  }
  // First part is a participant id.
  const pid = parts[0];
  const target = pack.participants.find((p) => p.id === pid);
  if (!target) throw new Error(`matrix axis: participant '${pid}' not found in pack`);
  setNested(target as unknown as Record<string, unknown>, parts.slice(1), value);
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (k === undefined) return;
    const next = cur[k];
    if (typeof next !== "object" || next === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  cur[last] = value;
}

function shortRepr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
