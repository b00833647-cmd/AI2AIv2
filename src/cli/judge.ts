// LLM-as-judge scoring for a recorded session.
//
// Usage:
//   npm run judge -- <session-id>
//   npm run judge -- <session-id> --model claude-sonnet-4-6

import Database from "better-sqlite3";
import { openPersistence } from "../multi-agent/persistence.ts";
import { scoreSession, type Score } from "../multi-agent/judge.ts";

interface CliArgs {
  sessionId: string;
  model?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--model") {
      model = argv[++i];
      continue;
    }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1) throw new Error("usage: judge <session-id> [--model M]");
  return { sessionId: positional[0]!, model };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const persistence = openPersistence();
  try {
    const transcript = await persistence.loadTurns(args.sessionId);
    const pack = await persistence.loadPack(args.sessionId);

    // Pull outcome from sessions table.
    const dbPath = process.env["AI2AI_DB_PATH"] ?? "./data/sessions.db";
    const db = new Database(dbPath);
    const row = db
      .prepare(
        `SELECT outcome_type, outcome_summary, outcome_terms_json, outcome_rationale, ended_at, degraded
         FROM sessions WHERE id = ?`,
      )
      .get(args.sessionId) as
      | {
          outcome_type: string | null;
          outcome_summary: string | null;
          outcome_terms_json: string | null;
          outcome_rationale: string | null;
          ended_at: string | null;
          degraded: number;
        }
      | undefined;
    db.close();
    if (!row) throw new Error(`session ${args.sessionId} not found`);
    if (!row.outcome_type) throw new Error(`session ${args.sessionId} has no recorded outcome (still running?)`);

    const outcome = {
      type: row.outcome_type,
      summary: row.outcome_summary ?? "",
      terms: row.outcome_terms_json ? (JSON.parse(row.outcome_terms_json) as Record<string, unknown>) : undefined,
      rationale: row.outcome_rationale ?? "",
      endedAt: row.ended_at ?? new Date().toISOString(),
      degraded: row.degraded === 1,
    };

    console.log(`Scoring session ${args.sessionId} (${transcript.length} turns)…`);

    const scores = await scoreSession({
      sessionId: args.sessionId,
      pack,
      transcript,
      outcome,
      opts: { judgeModel: args.model },
    });

    writeScores(args.sessionId, scores);

    console.log("\nScores:");
    for (const s of scores) {
      console.log(`  ${s.participantId} / ${s.rubricKey}: ${s.score} — ${s.rationale}`);
    }
  } finally {
    persistence.close();
  }
}

function writeScores(sessionId: string, scores: Score[]): void {
  const dbPath = process.env["AI2AI_DB_PATH"] ?? "./data/sessions.db";
  const db = new Database(dbPath);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO scores
       (session_id, participant_id, rubric_key, score, rationale, judge_model, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const s of scores) {
      stmt.run(sessionId, s.participantId, s.rubricKey, s.score, s.rationale, s.judgeModel, s.timestamp);
    }
  });
  tx();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
