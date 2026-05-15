// SQLite persistence — every participant turn and orchestrator decision gets
// a row. The orchestrator's reasoning is auditable and replayable.

import Database from "better-sqlite3";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type {
  OrchestratorDecision,
  OrchestratorState,
  ScenarioPack,
  SessionId,
  SessionOutcome,
  Turn,
} from "./types.ts";

export interface Persistence {
  startSession(state: OrchestratorState): Promise<void>;
  recordTurn(state: OrchestratorState, turn: Turn): Promise<void>;
  recordOrchestratorDecision(
    state: OrchestratorState,
    decision: OrchestratorDecision,
    tokensUsed: number,
  ): Promise<void>;
  endSession(state: OrchestratorState, outcome: SessionOutcome): Promise<void>;
  /** Read the orchestrator decision log for a prior session (for replay). */
  loadDecisions(sessionId: SessionId): Promise<OrchestratorDecision[]>;
  /** Read a session's full transcript. */
  loadTurns(sessionId: SessionId): Promise<Turn[]>;
  /** Read a session's pack JSON (frozen at start time). */
  loadPack(sessionId: SessionId): Promise<ScenarioPack>;
  /** List recent sessions (for CLI tooling). */
  listSessions(limit?: number): Promise<Array<{ id: string; scenarioId: string; status: string; startedAt: string }>>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  scenario_pack_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome_type TEXT,
  outcome_summary TEXT,
  outcome_terms_json TEXT,
  outcome_rationale TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  tokens_orchestrator INTEGER NOT NULL DEFAULT 0,
  turns_consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  PRIMARY KEY (session_id, participant_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  emitter TEXT NOT NULL,
  emitter_id TEXT NOT NULL,
  tool_calls_json TEXT NOT NULL,
  message TEXT,
  thinking TEXT,
  tokens_json TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  rationale TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, turn_number);

CREATE TABLE IF NOT EXISTS orchestrator_decisions (
  session_id TEXT NOT NULL,
  decision_index INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  rationale TEXT,
  thinking TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (session_id, decision_index),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outcomes (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  utility REAL,
  custom_metrics_json TEXT,
  PRIMARY KEY (session_id, participant_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scores (
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  rubric_key TEXT NOT NULL,
  score REAL NOT NULL,
  rationale TEXT,
  judge_model TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (session_id, participant_id, rubric_key)
);

-- ─── Participant-study tables (added 2026-05-02) ───────────────────────────
-- One human participant, one walkthrough of the 5-screen study. Each table
-- is independent of the engine's session/turn tables but linked via
-- study_participants.session_id when the participant reaches the negotiation.

CREATE TABLE IF NOT EXISTS study_participants (
  id                    TEXT PRIMARY KEY,
  external_id           TEXT,
  created_at            TEXT NOT NULL,
  finished_at           TEXT,
  role                  TEXT,
  consent               INTEGER NOT NULL DEFAULT 0,
  age                   INTEGER,
  gender                TEXT,
  experience            TEXT,
  ai_familiarity        TEXT,
  attention_check_pass  INTEGER,
  session_id            TEXT,
  completion_code       TEXT,
  excluded              INTEGER NOT NULL DEFAULT 0,
  excluded_reason       TEXT,
  user_agent            TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS behavior_prompts (
  participant_id        TEXT NOT NULL,
  revision              INTEGER NOT NULL,
  prompt_text           TEXT NOT NULL,
  mapped_signals_json   TEXT NOT NULL,
  mapped_notes          TEXT,
  match_rating          INTEGER,
  correction_note       TEXT,
  submitted_at          TEXT NOT NULL,
  PRIMARY KEY (participant_id, revision),
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participant_responses (
  participant_id        TEXT NOT NULL,
  screen                TEXT NOT NULL,
  key                   TEXT NOT NULL,
  value_int             INTEGER,
  value_text            TEXT,
  time_on_screen_ms     INTEGER,
  submitted_at          TEXT NOT NULL,
  PRIMARY KEY (participant_id, screen, key),
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
);

-- Behavioral telemetry — every click / focus / scroll / visibility event etc.
-- Append-only event log. The schema is intentionally generic (event_type +
-- payload_json) so we don't have to migrate when we add new event types.
CREATE TABLE IF NOT EXISTS participant_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id    TEXT NOT NULL,
  client_ts         TEXT NOT NULL,        -- ISO 8601 from the browser
  server_ts         TEXT NOT NULL,        -- when the server received it
  screen            INTEGER,              -- step number 1..10 (nullable for global events)
  event_type        TEXT NOT NULL,        -- 'click' | 'focus' | 'blur' | 'scroll' | etc.
  payload_json      TEXT,                 -- event-specific data
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS events_by_participant ON participant_events(participant_id, client_ts);
CREATE INDEX IF NOT EXISTS events_by_type ON participant_events(participant_id, event_type);

CREATE TABLE IF NOT EXISTS assignment_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id         TEXT NOT NULL,
  event_type             TEXT NOT NULL,
  condition_mode         TEXT,
  condition_role         TEXT,
  opponent_block         TEXT,
  assignment_seed        TEXT,
  assignment_block_index INTEGER,
  replicate_id           INTEGER,
  void_reason            TEXT,
  assigned_at            TEXT NOT NULL,
  server_ts              TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES study_participants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assignment_log_by_participant ON assignment_log(participant_id);
CREATE INDEX IF NOT EXISTS assignment_log_by_cell ON assignment_log(condition_mode, condition_role, opponent_block);
`;

// Idempotent migration — adds columns to existing tables when the SCHEMA's
// CREATE-IF-NOT-EXISTS would otherwise skip them. Each ALTER is wrapped in
// try/catch because SQLite raises if the column already exists.
const MIGRATIONS: string[] = [
  // Browser / device metadata captured at /api/p/start
  "ALTER TABLE study_participants ADD COLUMN viewport_w INTEGER",
  "ALTER TABLE study_participants ADD COLUMN viewport_h INTEGER",
  "ALTER TABLE study_participants ADD COLUMN screen_w INTEGER",
  "ALTER TABLE study_participants ADD COLUMN screen_h INTEGER",
  "ALTER TABLE study_participants ADD COLUMN timezone TEXT",
  "ALTER TABLE study_participants ADD COLUMN language TEXT",
  "ALTER TABLE study_participants ADD COLUMN referrer TEXT",
  "ALTER TABLE study_participants ADD COLUMN browser TEXT",
  "ALTER TABLE study_participants ADD COLUMN os TEXT",
  "ALTER TABLE study_participants ADD COLUMN device_type TEXT",
  "ALTER TABLE study_participants ADD COLUMN connection_type TEXT",
  // Test-data marker — researcher-set "this run was QA, exclude from analysis"
  "ALTER TABLE study_participants ADD COLUMN test_data INTEGER NOT NULL DEFAULT 0",
  // Experiment mode: 'agent' (delegated, default) | 'human_buyer' | 'human_seller'.
  "ALTER TABLE study_participants ADD COLUMN experiment_mode TEXT NOT NULL DEFAULT 'agent'",
  // Prolific tokens — captured from URL params at /api/p/start when the
  // participant arrives via a Prolific listing. nullable so participants
  // arriving via direct links / lab walkthroughs continue to work.
  "ALTER TABLE study_participants ADD COLUMN prolific_pid TEXT",
  "ALTER TABLE study_participants ADD COLUMN prolific_study_id TEXT",
  "ALTER TABLE study_participants ADD COLUMN prolific_session_id TEXT",
  // Clean experimental design (spec 2/4) — first-class condition,
  // assignment provenance, and pre-registered checks. All NULLABLE with
  // no DEFAULT: pre-existing/pilot rows stay NULL, which is the legacy
  // discriminator (NULL condition_mode ⇒ analysis uses experiment_mode).
  "ALTER TABLE study_participants ADD COLUMN condition_mode TEXT",
  "ALTER TABLE study_participants ADD COLUMN condition_role TEXT",
  "ALTER TABLE study_participants ADD COLUMN opponent_block TEXT",
  "ALTER TABLE study_participants ADD COLUMN assignment_seed TEXT",
  "ALTER TABLE study_participants ADD COLUMN assignment_block_index INTEGER",
  "ALTER TABLE study_participants ADD COLUMN replicate_id INTEGER",
  "ALTER TABLE study_participants ADD COLUMN manipulation_check_pass INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_attention INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_manipulation INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_speeding INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_comprehension INTEGER",
  "ALTER TABLE study_participants ADD COLUMN excl_noncompletion INTEGER",
];

export class SqlitePersistence implements Persistence {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    // NOTE: orphan purge is NOT called from the constructor — withDb opens
    // a fresh persistence per request, so doing it here would purge on
    // every API call. The server calls purgeOrphanedRows() once at startup
    // (see server.ts boot section).
  }

  async startSession(state: OrchestratorState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, scenario_id, scenario_pack_json, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(state.sessionId, state.scenarioPack.id, JSON.stringify(state.scenarioPack), new Date().toISOString());

    const insertPart = this.db.prepare(
      `INSERT INTO participants (session_id, participant_id, role, model, brief_json, system_prompt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const p of state.scenarioPack.participants) {
        insertPart.run(
          state.sessionId,
          p.id,
          p.role,
          p.human ? "human" : p.llm?.model ?? "?",
          JSON.stringify(p.brief),
          p.systemPromptTemplate,
        );
      }
    });
    tx();
  }

  async recordTurn(state: OrchestratorState, turn: Turn): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, turn_number, emitter, emitter_id, tool_calls_json,
            message, thinking, tokens_json, latency_ms, model, timestamp, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.turnNumber,
        turn.emitter,
        String(turn.emitterId),
        JSON.stringify(turn.toolCalls),
        turn.message ?? null,
        turn.thinking ?? null,
        JSON.stringify(turn.tokens),
        turn.latencyMs,
        turn.model,
        turn.timestamp,
      );

    this.db
      .prepare(
        `UPDATE sessions
           SET tokens_total = tokens_total + ?, turns_consumed = turns_consumed + 1
         WHERE id = ?`,
      )
      .run(turn.tokens.input + turn.tokens.output, state.sessionId);
  }

  async recordOrchestratorDecision(
    state: OrchestratorState,
    decision: OrchestratorDecision,
    tokensUsed: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO orchestrator_decisions
           (session_id, decision_index, turn_number, tool_name,
            tool_input_json, rationale, thinking, tokens_used, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.sessionId,
        state.decisions.length - 1, // index in the array
        decision.turnNumber,
        decision.toolCall.name,
        JSON.stringify(decision.toolCall.input),
        decision.rationale ?? null,
        decision.thinking ?? null,
        tokensUsed,
        decision.timestamp,
      );

    this.db
      .prepare(
        `UPDATE sessions
           SET tokens_total = tokens_total + ?, tokens_orchestrator = tokens_orchestrator + ?
         WHERE id = ?`,
      )
      .run(tokensUsed, tokensUsed, state.sessionId);
  }

  async endSession(state: OrchestratorState, outcome: SessionOutcome): Promise<void> {
    this.db
      .prepare(
        `UPDATE sessions
           SET status = ?, ended_at = ?, outcome_type = ?, outcome_summary = ?,
               outcome_terms_json = ?, outcome_rationale = ?, degraded = ?
         WHERE id = ?`,
      )
      .run(
        state.degraded ? "ended_degraded" : "ended",
        outcome.endedAt,
        outcome.type,
        outcome.summary,
        outcome.terms ? JSON.stringify(outcome.terms) : null,
        outcome.rationale,
        state.degraded ? 1 : 0,
        state.sessionId,
      );

    if (outcome.participantUtilities) {
      const ins = this.db.prepare(
        `INSERT OR REPLACE INTO outcomes (session_id, participant_id, utility, custom_metrics_json)
         VALUES (?, ?, ?, ?)`,
      );
      const customJson = outcome.customMetrics ? JSON.stringify(outcome.customMetrics) : null;
      const tx = this.db.transaction(() => {
        for (const [pid, utility] of Object.entries(outcome.participantUtilities!)) {
          ins.run(state.sessionId, pid, utility, customJson);
        }
      });
      tx();
    }
  }

  async loadDecisions(sessionId: SessionId): Promise<OrchestratorDecision[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_index, turn_number, tool_name, tool_input_json,
                rationale, thinking, timestamp
           FROM orchestrator_decisions
           WHERE session_id = ?
           ORDER BY decision_index ASC`,
      )
      .all(sessionId) as Array<{
      decision_index: number;
      turn_number: number;
      tool_name: string;
      tool_input_json: string;
      rationale: string | null;
      thinking: string | null;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      turnNumber: r.turn_number,
      toolCall: { name: r.tool_name, input: JSON.parse(r.tool_input_json) },
      rationale: r.rationale ?? undefined,
      thinking: r.thinking ?? undefined,
      timestamp: r.timestamp,
    }));
  }

  async loadTurns(sessionId: SessionId): Promise<Turn[]> {
    const rows = this.db
      .prepare(
        `SELECT id, turn_number, emitter, emitter_id, tool_calls_json, message,
                thinking, tokens_json, latency_ms, model, timestamp
           FROM turns
           WHERE session_id = ?
           ORDER BY turn_number ASC`,
      )
      .all(sessionId) as Array<{
      id: string;
      turn_number: number;
      emitter: string;
      emitter_id: string;
      tool_calls_json: string;
      message: string | null;
      thinking: string | null;
      tokens_json: string;
      latency_ms: number;
      model: string;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId,
      turnNumber: r.turn_number,
      emitter: r.emitter as Turn["emitter"],
      emitterId: r.emitter_id,
      toolCalls: JSON.parse(r.tool_calls_json),
      message: r.message ?? undefined,
      thinking: r.thinking ?? undefined,
      tokens: JSON.parse(r.tokens_json),
      latencyMs: r.latency_ms,
      model: r.model,
      timestamp: r.timestamp,
    }));
  }

  async loadPack(sessionId: SessionId): Promise<ScenarioPack> {
    const row = this.db
      .prepare(`SELECT scenario_pack_json FROM sessions WHERE id = ?`)
      .get(sessionId) as { scenario_pack_json: string } | undefined;
    if (!row) throw new Error(`session ${sessionId} not found`);
    return JSON.parse(row.scenario_pack_json) as ScenarioPack;
  }

  async listSessions(limit = 50): Promise<Array<{ id: string; scenarioId: string; status: string; startedAt: string }>> {
    const rows = this.db
      .prepare(
        `SELECT id, scenario_id, status, started_at
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; scenario_id: string; status: string; started_at: string }>;
    return rows.map((r) => ({ id: r.id, scenarioId: r.scenario_id, status: r.status, startedAt: r.started_at }));
  }

  // ─── Participant-study helpers ───────────────────────────────────────────

  createStudyParticipant(args: { id: string; userAgent?: string }): void {
    this.db
      .prepare(
        `INSERT INTO study_participants (id, created_at, user_agent)
         VALUES (?, ?, ?)`,
      )
      .run(args.id, new Date().toISOString(), args.userAgent ?? null);
  }

  updateStudyParticipant(
    id: string,
    fields: Partial<{
      role: string;
      consent: boolean;
      age: number | null;
      gender: string | null;
      experience: string | null;
      ai_familiarity: string | null;
      attention_check_pass: boolean;
      session_id: string;
      finished_at: string;
      completion_code: string;
      excluded: boolean;
      excluded_reason: string;
      test_data: boolean;
      experiment_mode: string;
      prolific_pid: string | null;
      prolific_study_id: string | null;
      prolific_session_id: string | null;
    }>,
  ): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      cols.push(`${k} = ?`);
      if (typeof v === "boolean") vals.push(v ? 1 : 0);
      else vals.push(v);
    }
    if (cols.length === 0) return;
    vals.push(id);
    this.db
      .prepare(`UPDATE study_participants SET ${cols.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  getStudyParticipant(id: string): {
    id: string;
    created_at: string;
    finished_at: string | null;
    role: string | null;
    consent: number;
    age: number | null;
    gender: string | null;
    experience: string | null;
    ai_familiarity: string | null;
    attention_check_pass: number | null;
    session_id: string | null;
    completion_code: string | null;
    device_type: string | null;
    browser: string | null;
    os: string | null;
    user_agent: string | null;
    experiment_mode: string;
    excluded: number;
    excluded_reason: string | null;
    test_data: number;
    prolific_pid: string | null;
    prolific_study_id: string | null;
    prolific_session_id: string | null;
    condition_mode: string | null;
    condition_role: string | null;
    opponent_block: string | null;
    assignment_seed: string | null;
    assignment_block_index: number | null;
    replicate_id: number | null;
    manipulation_check_pass: number | null;
    excl_attention: number | null;
    excl_manipulation: number | null;
    excl_speeding: number | null;
    excl_comprehension: number | null;
    excl_noncompletion: number | null;
  } | undefined {
    return this.db
      .prepare(
        `SELECT id, created_at, finished_at, role, consent, age, gender,
                experience, ai_familiarity, attention_check_pass, session_id,
                completion_code, device_type, browser, os, user_agent,
                experiment_mode, excluded, excluded_reason, test_data,
                prolific_pid, prolific_study_id, prolific_session_id,
                condition_mode, condition_role, opponent_block,
                assignment_seed, assignment_block_index, replicate_id,
                manipulation_check_pass,
                excl_attention, excl_manipulation, excl_speeding,
                excl_comprehension, excl_noncompletion
           FROM study_participants WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          created_at: string;
          finished_at: string | null;
          role: string | null;
          consent: number;
          age: number | null;
          gender: string | null;
          experience: string | null;
          ai_familiarity: string | null;
          attention_check_pass: number | null;
          session_id: string | null;
          completion_code: string | null;
          device_type: string | null;
          browser: string | null;
          os: string | null;
          user_agent: string | null;
          experiment_mode: string;
          excluded: number;
          excluded_reason: string | null;
          test_data: number;
          prolific_pid: string | null;
          prolific_study_id: string | null;
          prolific_session_id: string | null;
          condition_mode: string | null;
          condition_role: string | null;
          opponent_block: string | null;
          assignment_seed: string | null;
          assignment_block_index: number | null;
          replicate_id: number | null;
          manipulation_check_pass: number | null;
          excl_attention: number | null;
          excl_manipulation: number | null;
          excl_speeding: number | null;
          excl_comprehension: number | null;
          excl_noncompletion: number | null;
        }
      | undefined;
  }

  insertBehaviorPrompt(args: {
    participantId: string;
    promptText: string;
    /** Optional — only set under the legacy 7-axis mapping path. New flow passes null. */
    mappedSignals?: unknown | null;
    /** Optional — paired with mappedSignals on the legacy path. */
    mappedNotes?: string | null;
  }): { revision: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) AS max FROM behavior_prompts WHERE participant_id = ?`,
      )
      .get(args.participantId) as { max: number };
    const revision = row.max + 1;
    // The schema declares mapped_signals_json NOT NULL; we satisfy that by
    // writing the JSON literal "null" when no signals were computed. Consumers
    // that read this column should `JSON.parse()` and check for null.
    const signalsJson =
      args.mappedSignals === undefined || args.mappedSignals === null
        ? "null"
        : JSON.stringify(args.mappedSignals);
    this.db
      .prepare(
        `INSERT INTO behavior_prompts
           (participant_id, revision, prompt_text, mapped_signals_json,
            mapped_notes, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.participantId,
        revision,
        args.promptText,
        signalsJson,
        args.mappedNotes ?? null,
        new Date().toISOString(),
      );
    return { revision };
  }

  updateBehaviorPromptCheck(args: {
    participantId: string;
    revision: number;
    matchRating: number;
    correctionNote?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE behavior_prompts
           SET match_rating = ?, correction_note = ?
         WHERE participant_id = ? AND revision = ?`,
      )
      .run(
        args.matchRating,
        args.correctionNote ?? null,
        args.participantId,
        args.revision,
      );
  }

  getLatestBehaviorPrompt(participantId: string): {
    revision: number;
    prompt_text: string;
    mapped_signals_json: string;
    mapped_notes: string | null;
    match_rating: number | null;
  } | undefined {
    return this.db
      .prepare(
        `SELECT revision, prompt_text, mapped_signals_json, mapped_notes, match_rating
           FROM behavior_prompts
           WHERE participant_id = ?
           ORDER BY revision DESC LIMIT 1`,
      )
      .get(participantId) as
      | {
          revision: number;
          prompt_text: string;
          mapped_signals_json: string;
          mapped_notes: string | null;
          match_rating: number | null;
        }
      | undefined;
  }

  insertParticipantResponses(
    participantId: string,
    screen: string,
    items: Array<{ key: string; valueInt?: number; valueText?: string; timeOnScreenMs?: number }>,
  ): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO participant_responses
         (participant_id, screen, key, value_int, value_text, time_on_screen_ms, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const it of items) {
        ins.run(
          participantId,
          screen,
          it.key,
          it.valueInt ?? null,
          it.valueText ?? null,
          it.timeOnScreenMs ?? null,
          now,
        );
      }
    });
    tx();
  }

  /** Latest saved personal-context text for a participant, or "" if none. */
  getParticipantContextText(participantId: string): string {
    const row = this.db
      .prepare(
        `SELECT value_text FROM participant_responses
         WHERE participant_id = ? AND screen = 'context' AND key = 'personal_context'
         ORDER BY submitted_at DESC LIMIT 1`,
      )
      .get(participantId) as { value_text: string | null } | undefined;
    return row?.value_text ?? "";
  }

  // ─── Telemetry: participant_events ───────────────────────────────────────

  insertParticipantEvents(
    participantId: string,
    events: Array<{ ts: string; screen?: number; type: string; payload?: unknown }>,
  ): number {
    if (events.length === 0) return 0;
    const ins = this.db.prepare(
      `INSERT INTO participant_events
         (participant_id, client_ts, server_ts, screen, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const serverTs = new Date().toISOString();
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const ev of events) {
        if (typeof ev.ts !== "string" || typeof ev.type !== "string") continue;
        ins.run(
          participantId,
          ev.ts,
          serverTs,
          typeof ev.screen === "number" ? ev.screen : null,
          ev.type,
          ev.payload === undefined ? null : JSON.stringify(ev.payload),
        );
        count += 1;
      }
    });
    tx();
    return count;
  }

  // ─── GDPR: full per-participant export + cascading erase ─────────────────

  /**
   * Returns a hierarchical JSON of EVERYTHING tied to a participantId:
   * the participant row, all behavior_prompts revisions, all participant_responses,
   * all participant_events, and the linked engine session (if any) with its
   * participants, turns, orchestrator_decisions, outcomes, scores.
   */
  exportParticipant(id: string): Record<string, unknown> | null {
    const p = this.getStudyParticipant(id);
    if (!p) return null;

    const prompts = this.db
      .prepare(`SELECT * FROM behavior_prompts WHERE participant_id = ? ORDER BY revision`)
      .all(id);
    const responses = this.db
      .prepare(`SELECT * FROM participant_responses WHERE participant_id = ? ORDER BY submitted_at`)
      .all(id);
    const events = this.db
      .prepare(`SELECT * FROM participant_events WHERE participant_id = ? ORDER BY id`)
      .all(id);

    let session: unknown = null;
    if (p.session_id) {
      const sessionRow = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(p.session_id);
      if (sessionRow) {
        const sessParticipants = this.db.prepare(`SELECT * FROM participants WHERE session_id = ?`).all(p.session_id);
        const turns = this.db.prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number`).all(p.session_id);
        const decisions = this.db.prepare(`SELECT * FROM orchestrator_decisions WHERE session_id = ? ORDER BY decision_index`).all(p.session_id);
        const outcomes = this.db.prepare(`SELECT * FROM outcomes WHERE session_id = ?`).all(p.session_id);
        const scores = this.db.prepare(`SELECT * FROM scores WHERE session_id = ?`).all(p.session_id);
        session = { ...sessionRow, participants: sessParticipants, turns, decisions, outcomes, scores };
      }
    }

    return {
      participant: p,
      behavior_prompts: prompts,
      participant_responses: responses,
      participant_events: events,
      session,
      _exported_at: new Date().toISOString(),
    };
  }

  /**
   * Right-to-erasure: delete EVERY row tied to a participantId across all
   * tables. The CASCADE FKs on participant-side tables clean up most of it;
   * the linked engine session (if any) is deleted explicitly here.
   */
  eraseParticipant(id: string): { deletedSessionId: string | null } {
    const p = this.getStudyParticipant(id);
    if (!p) return { deletedSessionId: null };
    const sid = p.session_id;
    const tx = this.db.transaction(() => {
      // CASCADE handles behavior_prompts, participant_responses, participant_events.
      this.db.prepare(`DELETE FROM study_participants WHERE id = ?`).run(id);
      if (sid) {
        // CASCADE inside sessions handles participants, turns, orchestrator_decisions, outcomes.
        this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
      }
    });
    tx();
    return { deletedSessionId: sid ?? null };
  }

  // ─── Admin queries: participants list with computed flags ────────────────

  listParticipantsForAdmin(limit = 200): Array<{
    id: string;
    role: string | null;
    created_at: string;
    finished_at: string | null;
    last_activity_at: string;
    status: "finished" | "in_progress" | "abandoned";
    experiment_mode: string;
    age: number | null;
    attention_check_pass: number | null;
    completion_code: string | null;
    session_id: string | null;
    outcome_type: string | null;
    outcome_terms_json: string | null;
    tokens_total: number | null;
    turns_consumed: number | null;
    last_screen: number | null;
    total_events: number;
    total_time_sec: number | null;
    device_type: string | null;
    opponent_personality: string | null;
    excluded: number;
    test_data: number;
    prolific_pid: string | null;
    prolific_study_id: string | null;
    prolific_session_id: string | null;
    flag_speeding: number;
    flag_short_prompt: number;
    flag_mobile: number;
    flag_copy_paste: number;
  }> {
    // Idle threshold: a participant is considered "in progress" only if their
    // most recent client/server activity is within this many seconds. Past
    // that they're "abandoned" (started the study but never made it to the
    // thanks screen). Tuned to 10 minutes — the entire flow including
    // streamed negotiation typically takes 4-7 minutes.
    const idleThresholdSec = 10 * 60;
    return this.db
      .prepare(
        `SELECT
           sp.id,
           sp.role,
           sp.created_at,
           sp.finished_at,
           sp.age,
           sp.attention_check_pass,
           sp.completion_code,
           sp.session_id,
           sp.device_type,
           sp.excluded,
           sp.test_data,
           sp.experiment_mode,
           sp.prolific_pid,
           sp.prolific_study_id,
           sp.prolific_session_id,
           s.outcome_type,
           s.outcome_terms_json,
           s.tokens_total,
           s.turns_consumed,
           (SELECT value_text FROM participant_responses
              WHERE participant_id = sp.id AND screen = 'engine' AND key = 'opponent_personality'
              LIMIT 1) AS opponent_personality,
           (SELECT MAX(screen) FROM participant_events WHERE participant_id = sp.id) AS last_screen,
           (SELECT COUNT(*) FROM participant_events WHERE participant_id = sp.id) AS total_events,
           CASE WHEN sp.finished_at IS NOT NULL
             THEN CAST((julianday(sp.finished_at) - julianday(sp.created_at)) * 86400 AS INTEGER)
             ELSE NULL END AS total_time_sec,
           -- last_activity_at: best-available timestamp of the participant's
           -- most recent observed action — newest of last event, last response
           -- submission, or fallback to created_at if neither exists.
           COALESCE(
             (SELECT MAX(server_ts) FROM participant_events WHERE participant_id = sp.id),
             (SELECT MAX(submitted_at) FROM participant_responses WHERE participant_id = sp.id),
             sp.created_at
           ) AS last_activity_at,
           -- Ternary status: finished | in_progress | abandoned. "In progress"
           -- is reserved for participants currently doing the task — anyone
           -- idle past the threshold without a completion code is abandoned.
           CASE
             WHEN sp.finished_at IS NOT NULL THEN 'finished'
             WHEN (julianday('now') - julianday(COALESCE(
               (SELECT MAX(server_ts) FROM participant_events WHERE participant_id = sp.id),
               (SELECT MAX(submitted_at) FROM participant_responses WHERE participant_id = sp.id),
               sp.created_at
             ))) * 86400 < ${idleThresholdSec} THEN 'in_progress'
             ELSE 'abandoned'
           END AS status,
           -- Speeding flag: finished in under 90 seconds (very rough).
           CASE WHEN sp.finished_at IS NOT NULL
             AND (julianday(sp.finished_at) - julianday(sp.created_at)) * 86400 < 90
             THEN 1 ELSE 0 END AS flag_speeding,
           -- Behavior prompt under 80 chars (low-effort).
           CASE WHEN EXISTS (
             SELECT 1 FROM behavior_prompts WHERE participant_id = sp.id AND length(prompt_text) < 80
           ) THEN 1 ELSE 0 END AS flag_short_prompt,
           -- Mobile/tablet flag: violates the "PC or laptop only" consent.
           CASE WHEN sp.device_type IN ('phone', 'tablet') THEN 1 ELSE 0 END AS flag_mobile,
           -- Copy/paste/cut/right-click flag: any blocked clipboard or
           -- contextmenu attempt anywhere in the participant's session
           -- promotes to a single visible badge in the admin (the client
           -- already preventDefaults the action; this is the audit trail).
           CASE WHEN EXISTS (
             SELECT 1 FROM participant_events
              WHERE participant_id = sp.id
                AND event_type IN ('paste', 'copy_attempt', 'cut_attempt', 'rightclick_attempt')
           ) THEN 1 ELSE 0 END AS flag_copy_paste
         FROM study_participants sp
         LEFT JOIN sessions s ON s.id = sp.session_id
         ORDER BY sp.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      role: string | null;
      created_at: string;
      finished_at: string | null;
      last_activity_at: string;
      status: "finished" | "in_progress" | "abandoned";
      experiment_mode: string;
      age: number | null;
      attention_check_pass: number | null;
      completion_code: string | null;
      session_id: string | null;
      outcome_type: string | null;
      outcome_terms_json: string | null;
      tokens_total: number | null;
      turns_consumed: number | null;
      last_screen: number | null;
      total_events: number;
      total_time_sec: number | null;
      device_type: string | null;
      opponent_personality: string | null;
      excluded: number;
      test_data: number;
      prolific_pid: string | null;
      prolific_study_id: string | null;
      prolific_session_id: string | null;
      flag_speeding: number;
      flag_short_prompt: number;
      flag_mobile: number;
      flag_copy_paste: number;
    }>;
  }

  /** Funnel: count of participants who reached each step. */
  funnelByScreen(): Array<{ screen: number; reached: number }> {
    return this.db
      .prepare(
        `SELECT screen, COUNT(DISTINCT participant_id) AS reached
           FROM participant_events
           WHERE event_type = 'screen_enter' AND screen IS NOT NULL
           GROUP BY screen
           ORDER BY screen`,
      )
      .all() as Array<{ screen: number; reached: number }>;
  }

  /** Total session tokens since a given ISO timestamp. Used by the cost cap. */
  tokensSpentSince(sinceIso: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(tokens_total), 0) AS t FROM sessions WHERE started_at >= ?`)
      .get(sinceIso) as { t: number };
    return row.t;
  }

  totalSpend(): { tokens_total: number; tokens_orchestrator: number; sessions: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens_total), 0) AS tokens_total,
                COALESCE(SUM(tokens_orchestrator), 0) AS tokens_orchestrator,
                COUNT(*) AS sessions FROM sessions`,
      )
      .get() as { tokens_total: number; tokens_orchestrator: number; sessions: number };
    return row;
  }

  countStudyParticipants(): { total: number; finished: number; in_progress: number; abandoned: number } {
    const idleThresholdSec = 10 * 60;
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN sp.finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished,
           SUM(CASE
             WHEN sp.finished_at IS NULL
                  AND (julianday('now') - julianday(COALESCE(
                    (SELECT MAX(server_ts) FROM participant_events WHERE participant_id = sp.id),
                    (SELECT MAX(submitted_at) FROM participant_responses WHERE participant_id = sp.id),
                    sp.created_at
                  ))) * 86400 < ${idleThresholdSec}
             THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE
             WHEN sp.finished_at IS NULL
                  AND (julianday('now') - julianday(COALESCE(
                    (SELECT MAX(server_ts) FROM participant_events WHERE participant_id = sp.id),
                    (SELECT MAX(submitted_at) FROM participant_responses WHERE participant_id = sp.id),
                    sp.created_at
                  ))) * 86400 >= ${idleThresholdSec}
             THEN 1 ELSE 0 END) AS abandoned
         FROM study_participants sp`,
      )
      .get() as { total: number; finished: number; in_progress: number; abandoned: number };
    return {
      total: row.total ?? 0,
      finished: row.finished ?? 0,
      in_progress: row.in_progress ?? 0,
      abandoned: row.abandoned ?? 0,
    };
  }

  // ─── Analytics: aggregates, distributions, time series ──────────────────

  /**
   * Per-condition (role × opponent_personality) aggregate stats.
   * The "paper-ready" table — counts, outcome rates, mean prices, mean turns.
   */
  aggregateByCondition(): Array<{
    role: string | null;
    personality: string | null;
    n: number;
    n_finished: number;
    n_agreed: number;
    n_impasse: number;
    n_rejected: number;
    pct_agreed: number;
    mean_price: number | null;
    median_price: number | null;
    mean_turns: number | null;
    mean_total_time_sec: number | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT
           sp.role AS role,
           op.value_text AS personality,
           sp.id,
           sp.finished_at,
           s.outcome_type,
           s.outcome_terms_json,
           s.turns_consumed,
           CASE WHEN sp.finished_at IS NOT NULL
             THEN (julianday(sp.finished_at) - julianday(sp.created_at)) * 86400
             ELSE NULL END AS total_time_sec
         FROM study_participants sp
         LEFT JOIN sessions s ON s.id = sp.session_id
         LEFT JOIN participant_responses op
           ON op.participant_id = sp.id
           AND op.screen = 'engine'
           AND op.key = 'opponent_personality'
         WHERE sp.excluded = 0`,
      )
      .all() as Array<{
      role: string | null;
      personality: string | null;
      id: string;
      finished_at: string | null;
      outcome_type: string | null;
      outcome_terms_json: string | null;
      turns_consumed: number | null;
      total_time_sec: number | null;
    }>;

    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.role || "—"}|${r.personality || "—"}`;
      const arr = groups.get(key);
      if (arr) arr.push(r);
      else groups.set(key, [r]);
    }

    const out: ReturnType<SqlitePersistence["aggregateByCondition"]> = [];
    for (const [key, group] of groups) {
      const [role, personality] = key.split("|");
      const prices: number[] = [];
      let nAgreed = 0, nImpasse = 0, nRejected = 0;
      const turns: number[] = [];
      const times: number[] = [];
      for (const r of group) {
        if (r.outcome_type === "agreed") nAgreed++;
        else if (r.outcome_type === "impasse" || r.outcome_type === "timeout") nImpasse++;
        else if (r.outcome_type === "rejected") nRejected++;
        if (r.outcome_terms_json) {
          try {
            const t = JSON.parse(r.outcome_terms_json);
            if (typeof t?.price === "number") prices.push(t.price);
          } catch { /* skip */ }
        }
        if (typeof r.turns_consumed === "number" && r.turns_consumed > 0) turns.push(r.turns_consumed);
        if (typeof r.total_time_sec === "number") times.push(r.total_time_sec);
      }
      const finished = group.filter(r => r.finished_at).length;
      const mean = (xs: number[]): number | null => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
      const median = (xs: number[]): number | null => {
        if (xs.length === 0) return null;
        const sorted = [...xs].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
      };
      out.push({
        role: role === "—" ? null : role!,
        personality: personality === "—" ? null : personality!,
        n: group.length,
        n_finished: finished,
        n_agreed: nAgreed,
        n_impasse: nImpasse,
        n_rejected: nRejected,
        pct_agreed: group.length > 0 ? Math.round((nAgreed / group.length) * 100) : 0,
        mean_price: mean(prices),
        median_price: median(prices),
        mean_turns: mean(turns),
        mean_total_time_sec: mean(times),
      });
    }
    return out.sort((a, b) =>
      (a.role || "").localeCompare(b.role || "") ||
      (a.personality || "").localeCompare(b.personality || ""),
    );
  }

  /** Outcome counts. */
  outcomeDistribution(): Array<{ outcome_type: string; count: number }> {
    return this.db
      .prepare(
        `SELECT s.outcome_type, COUNT(*) AS count
           FROM study_participants sp
           JOIN sessions s ON s.id = sp.session_id
           WHERE sp.excluded = 0 AND s.outcome_type IS NOT NULL
           GROUP BY s.outcome_type
           ORDER BY count DESC`,
      )
      .all() as Array<{ outcome_type: string; count: number }>;
  }

  /** Final-price histogram. Rounds to nearest $500 bucket. */
  priceDistribution(): Array<{ bucket: number; count: number }> {
    return this.db
      .prepare(
        `SELECT
           CAST(json_extract(s.outcome_terms_json, '$.price') / 500 AS INTEGER) * 500 AS bucket,
           COUNT(*) AS count
         FROM study_participants sp
         JOIN sessions s ON s.id = sp.session_id
         WHERE sp.excluded = 0
           AND s.outcome_type = 'agreed'
           AND s.outcome_terms_json IS NOT NULL
           AND json_extract(s.outcome_terms_json, '$.price') IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket`,
      )
      .all() as Array<{ bucket: number; count: number }>;
  }

  /** Turns-to-outcome histogram. */
  turnCountDistribution(): Array<{ turns: number; count: number }> {
    return this.db
      .prepare(
        `SELECT s.turns_consumed AS turns, COUNT(*) AS count
           FROM study_participants sp
           JOIN sessions s ON s.id = sp.session_id
           WHERE sp.excluded = 0 AND s.turns_consumed IS NOT NULL
           GROUP BY s.turns_consumed
           ORDER BY s.turns_consumed`,
      )
      .all() as Array<{ turns: number; count: number }>;
  }

  /** Mean Likert per question, broken down by role. */
  surveyAggregates(): Array<{ role: string | null; key: string; n: number; mean: number }> {
    const rows = this.db
      .prepare(
        `SELECT sp.role AS role, pr.key, pr.value_int
           FROM participant_responses pr
           JOIN study_participants sp ON sp.id = pr.participant_id
           WHERE sp.excluded = 0
             AND pr.screen = 'post_survey'
             AND pr.value_int IS NOT NULL
             AND pr.key NOT LIKE '\\_%' ESCAPE '\\'`,
      )
      .all() as Array<{ role: string | null; key: string; value_int: number }>;
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const k = `${r.role || "—"}|${r.key}`;
      const arr = groups.get(k);
      if (arr) arr.push(r.value_int);
      else groups.set(k, [r.value_int]);
    }
    const out: Array<{ role: string | null; key: string; n: number; mean: number }> = [];
    for (const [k, values] of groups) {
      const [role, key] = k.split("|");
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      out.push({ role: role === "—" ? null : role!, key: key!, n: values.length, mean });
    }
    return out.sort((a, b) =>
      (a.role || "").localeCompare(b.role || "") || a.key.localeCompare(b.key),
    );
  }

  /** Per-day spend summary (last N days). */
  spendByDay(days = 14): Array<{ day: string; tokens: number; sessions: number }> {
    return this.db
      .prepare(
        `SELECT
           substr(started_at, 1, 10) AS day,
           SUM(tokens_total) AS tokens,
           COUNT(*) AS sessions
         FROM sessions
         WHERE started_at >= datetime('now', ?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(`-${days} days`) as Array<{ day: string; tokens: number; sessions: number }>;
  }

  /** Cost broken down by opponent personality. */
  costByPersonality(): Array<{ personality: string; n: number; tokens: number; mean_tokens: number }> {
    return this.db
      .prepare(
        `SELECT
           op.value_text AS personality,
           COUNT(*) AS n,
           COALESCE(SUM(s.tokens_total), 0) AS tokens,
           CAST(COALESCE(AVG(s.tokens_total), 0) AS INTEGER) AS mean_tokens
         FROM participant_responses op
         JOIN study_participants sp ON sp.id = op.participant_id
         LEFT JOIN sessions s ON s.id = sp.session_id
         WHERE op.screen = 'engine'
           AND op.key = 'opponent_personality'
         GROUP BY op.value_text
         ORDER BY tokens DESC`,
      )
      .all() as Array<{ personality: string; n: number; tokens: number; mean_tokens: number }>;
  }

  // ─── Quality flags: extended set ────────────────────────────────────────

  /**
   * Compute extended flags per participant (in addition to the basic flags
   * already in listParticipantsForAdmin). Flags are computed from
   * participant_events + sessions tables.
   */
  extendedFlags(participantIds?: string[]): Map<string, {
    flag_paste: number;
    flag_tab_switch: number;
    flag_degraded: number;
    flag_mobile_blocked: number;
  }> {
    const filter = participantIds && participantIds.length > 0
      ? `AND participant_id IN (${participantIds.map(() => "?").join(",")})`
      : "";
    const params = participantIds ?? [];
    const eventCounts = this.db
      .prepare(
        `SELECT participant_id, event_type, screen, COUNT(*) AS n
           FROM participant_events
           WHERE 1=1 ${filter}
           GROUP BY participant_id, event_type, screen`,
      )
      .all(...params) as Array<{ participant_id: string; event_type: string; screen: number | null; n: number }>;
    const degraded = this.db
      .prepare(
        `SELECT sp.id AS participant_id, s.degraded
           FROM study_participants sp
           JOIN sessions s ON s.id = sp.session_id
           WHERE s.degraded = 1`,
      )
      .all() as Array<{ participant_id: string; degraded: number }>;
    const map = new Map<string, {
      flag_paste: number;
      flag_tab_switch: number;
      flag_degraded: number;
      flag_mobile_blocked: number;
    }>();
    const get = (id: string) => {
      let v = map.get(id);
      if (!v) {
        v = { flag_paste: 0, flag_tab_switch: 0, flag_degraded: 0, flag_mobile_blocked: 0 };
        map.set(id, v);
      }
      return v;
    };
    for (const r of eventCounts) {
      if (r.event_type === "paste") get(r.participant_id).flag_paste = 1;
      // Visibility-change events ON the negotiation screen (7) suggest tab switching during agents' turns.
      if (r.event_type === "visibilitychange" && r.screen === 7 && r.n >= 2) {
        get(r.participant_id).flag_tab_switch = 1;
      }
      if (r.event_type === "mobile_blocked") get(r.participant_id).flag_mobile_blocked = 1;
    }
    for (const r of degraded) get(r.participant_id).flag_degraded = 1;
    return map;
  }

  /** Toggle / set the excluded flag on a participant. */
  setExcluded(participantId: string, excluded: boolean): void {
    this.db
      .prepare(`UPDATE study_participants SET excluded = ?, excluded_reason = COALESCE(excluded_reason, ?) WHERE id = ?`)
      .run(excluded ? 1 : 0, excluded ? "manually excluded by researcher" : null, participantId);
  }

  /** Toggle / set the test_data flag (kept separate from excluded). */
  setTestData(participantId: string, testData: boolean): void {
    this.db
      .prepare(`UPDATE study_participants SET test_data = ? WHERE id = ?`)
      .run(testData ? 1 : 0, participantId);
  }

  /** Set the derived delegation manipulation-check pass flag (mirrors the
   *  existing attention_check_pass). The raw response is stored separately
   *  via the existing participant_responses path. */
  setManipulationCheck(participantId: string, pass: boolean): void {
    this.db
      .prepare(`UPDATE study_participants SET manipulation_check_pass = ? WHERE id = ?`)
      .run(pass ? 1 : 0, participantId);
  }

  /** Set structured exclusion booleans and recompute the derived
   *  excluded / excluded_reason rollup (excluded=1 iff any excl_* is set). */
  setExclusionFlags(
    participantId: string,
    flags: Partial<{
      attention: boolean; manipulation: boolean; speeding: boolean;
      comprehension: boolean; noncompletion: boolean;
    }>,
  ): void {
    const map: Record<string, string> = {
      attention: "excl_attention", manipulation: "excl_manipulation",
      speeding: "excl_speeding", comprehension: "excl_comprehension",
      noncompletion: "excl_noncompletion",
    };
    const tx = this.db.transaction(() => {
      for (const [k, col] of Object.entries(map)) {
        const v = (flags as Record<string, boolean | undefined>)[k];
        if (v === undefined) continue;
        this.db
          .prepare(`UPDATE study_participants SET ${col} = ? WHERE id = ?`)
          .run(v ? 1 : 0, participantId);
      }
      const row = this.db
        .prepare(
          `SELECT excl_attention, excl_manipulation, excl_speeding,
                  excl_comprehension, excl_noncompletion, excluded_reason
             FROM study_participants WHERE id = ?`,
        )
        .get(participantId) as
          | (Record<string, number | null> & { excluded_reason: string | null })
          | undefined;
      const set = Object.entries(row ?? {})
        .filter(([c, v]) => c.startsWith("excl_") && v === 1)
        .map(([c]) => c.replace("excl_", ""));
      const manual =
        typeof row?.excluded_reason === "string" &&
        row.excluded_reason.startsWith("manually");
      if (!manual) {
        this.db
          .prepare(
            `UPDATE study_participants
                SET excluded = ?, excluded_reason = ?
              WHERE id = ?`,
          )
          .run(
            set.length > 0 ? 1 : 0,
            set.length > 0 ? `auto: ${set.join(", ")}` : null,
            participantId,
          );
      }
    });
    tx();
  }

  /**
   * Persist a resolved condition assignment: writes the first-class
   * condition_* columns, dual-writes legacy experiment_mode/role (for the
   * admin dashboard + Prolific-code lookup), and appends one append-only
   * 'assigned' row to assignment_log. Atomic.
   */
  recordAssignment(
    participantId: string,
    a: {
      conditionMode: "delegated" | "direct";
      conditionRole: "buyer" | "seller";
      opponentBlock: "easygoing" | "moderate" | "tough";
      assignmentSeed: string;
      assignmentBlockIndex: number;
      replicateId: number;
      assignedAt: string;
    },
  ): void {
    const experimentMode =
      a.conditionMode === "delegated" ? "agent" : `human_${a.conditionRole}`;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE study_participants
              SET condition_mode = ?, condition_role = ?, opponent_block = ?,
                  assignment_seed = ?, assignment_block_index = ?,
                  replicate_id = ?, experiment_mode = ?, role = ?
            WHERE id = ?`,
        )
        .run(
          a.conditionMode, a.conditionRole, a.opponentBlock,
          a.assignmentSeed, a.assignmentBlockIndex, a.replicateId,
          experimentMode, a.conditionRole, participantId,
        );
      this.db
        .prepare(
          `INSERT INTO assignment_log
             (participant_id, event_type, condition_mode, condition_role,
              opponent_block, assignment_seed, assignment_block_index,
              replicate_id, void_reason, assigned_at, server_ts)
           VALUES (?, 'assigned', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          participantId, a.conditionMode, a.conditionRole, a.opponentBlock,
          a.assignmentSeed, a.assignmentBlockIndex, a.replicateId,
          a.assignedAt, new Date().toISOString(),
        );
    });
    tx();
  }

  /** Append a 'voided' or 'replaced' assignment_log row (audit + frees the
   *  stratum so the next claimant re-fills it). Copies the participant's
   *  current condition so the log row is self-describing. */
  recordAssignmentEvent(
    participantId: string,
    eventType: "voided" | "replaced",
    voidReason: string,
  ): void {
    const sp = this.db
      .prepare(
        `SELECT condition_mode, condition_role, opponent_block,
                assignment_seed, assignment_block_index, replicate_id
           FROM study_participants WHERE id = ?`,
      )
      .get(participantId) as
      | {
          condition_mode: string | null; condition_role: string | null;
          opponent_block: string | null; assignment_seed: string | null;
          assignment_block_index: number | null; replicate_id: number | null;
        }
      | undefined;
    this.db
      .prepare(
        `INSERT INTO assignment_log
           (participant_id, event_type, condition_mode, condition_role,
            opponent_block, assignment_seed, assignment_block_index,
            replicate_id, void_reason, assigned_at, server_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        participantId, eventType, sp?.condition_mode ?? null,
        sp?.condition_role ?? null, sp?.opponent_block ?? null,
        sp?.assignment_seed ?? null, sp?.assignment_block_index ?? null,
        sp?.replicate_id ?? null, voidReason,
        new Date().toISOString(), new Date().toISOString(),
      );
  }

  /**
   * IRREVERSIBLY delete a participant and ALL their associated data:
   * - participant_responses, participant_events, behavior_prompts (auto-cascade
   *   from the FK with ON DELETE CASCADE on study_participants)
   * - the session row, plus its turns / orchestrator_decisions / outcomes
   *   (auto-cascade from the FK on sessions)
   *
   * Wraps everything in a single transaction so a failure mid-delete leaves
   * the DB consistent. Returns the number of rows actually removed (0 if
   * the participant id wasn't found).
   *
   * Designed to be safe to call on any participant id — non-existent ids
   * are a silent no-op (returns 0). Caller is responsible for confirmation
   * UX. Once committed, the data is gone — no soft-delete, no recovery.
   */
  deleteParticipantCascade(participantId: string): number {
    const tx = this.db.transaction((id: string) => {
      // Look up the linked session id (if any) before nuking the row.
      const row = this.db
        .prepare(`SELECT session_id FROM study_participants WHERE id = ?`)
        .get(id) as { session_id: string | null } | undefined;
      if (!row) return 0;

      // Step 1: explicit DELETEs from every participant-keyed table.
      // ON DELETE CASCADE on study_participants(id) should already do this
      // for behavior_prompts / participant_responses / participant_events,
      // but we issue the same DELETEs explicitly so a misbehaving FK setup
      // (e.g. PRAGMA foreign_keys disabled on a connection, or a future
      // schema edit that drops the cascade clause) cannot leave orphans.
      this.db.prepare(`DELETE FROM behavior_prompts      WHERE participant_id = ?`).run(id);
      this.db.prepare(`DELETE FROM participant_responses WHERE participant_id = ?`).run(id);
      this.db.prepare(`DELETE FROM participant_events    WHERE participant_id = ?`).run(id);

      const partResult = this.db
        .prepare(`DELETE FROM study_participants WHERE id = ?`)
        .run(id);

      // Step 2: explicit DELETEs from every session-keyed table when no
      // other study_participant references the same session. Same belt-
      // and-braces logic — sessions FK chain handles this when ON DELETE
      // CASCADE fires correctly, but we hit each table explicitly so the
      // wide-format export stays free of session-orphan rows even if the
      // FK chain is ever bypassed.
      if (row.session_id) {
        const others = this.db
          .prepare(`SELECT COUNT(*) AS n FROM study_participants WHERE session_id = ?`)
          .get(row.session_id) as { n: number };
        if (others.n === 0) {
          const sid = row.session_id;
          this.db.prepare(`DELETE FROM turns                  WHERE session_id = ?`).run(sid);
          this.db.prepare(`DELETE FROM orchestrator_decisions WHERE session_id = ?`).run(sid);
          this.db.prepare(`DELETE FROM participants           WHERE session_id = ?`).run(sid);
          this.db.prepare(`DELETE FROM outcomes               WHERE session_id = ?`).run(sid);
          this.db.prepare(`DELETE FROM scores                 WHERE session_id = ?`).run(sid);
          this.db.prepare(`DELETE FROM sessions               WHERE id = ?`).run(sid);
        }
      }

      return partResult.changes;
    });
    return tx(participantId) as number;
  }

  /**
   * One-shot orphan sweep — removes rows in session-keyed tables whose
   * session is no longer in `sessions`, and rows in participant-keyed
   * tables whose participant is no longer in `study_participants`.
   *
   * Idempotent: a clean DB returns { tableName: 0, ... }. Safe to run on
   * every startup (see SqlitePersistence constructor) — keeps the DB free
   * of any stale rows from pre-cascade deletes or interrupted transactions.
   *
   * Returns a per-table count of rows removed so a researcher can see what
   * was cleaned up if anything was off.
   */
  purgeOrphanedRows(): Record<string, number> {
    const counts: Record<string, number> = {};
    const tx = this.db.transaction(() => {
      // Step 1 — sessions that no study_participant references. These come
      // from CLI runs, pre-study testing, or any past delete path that
      // removed the study_participant but left the session behind. They
      // pollute every session-keyed export sheet (Agent Log, Turns,
      // Orchestrator, Briefings, Outcomes) so we wipe them first and let
      // the dependent rows cascade out via ON DELETE CASCADE on sessions.
      const sessRes = this.db
        .prepare(
          `DELETE FROM sessions
            WHERE id NOT IN (
              SELECT session_id FROM study_participants WHERE session_id IS NOT NULL
            )`,
        )
        .run();
      counts.sessions = sessRes.changes;

      // Step 2 — belt-and-braces: any session-keyed row whose session is
      // STILL missing from `sessions` (in case the cascade didn't fire).
      const sessionTables = [
        "turns", "orchestrator_decisions", "participants", "outcomes", "scores",
      ];
      for (const t of sessionTables) {
        const r = this.db
          .prepare(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT id FROM sessions)`)
          .run();
        counts[t] = r.changes;
      }

      // Step 3 — participant-keyed rows with no participant. Same belt-
      // and-braces: ON DELETE CASCADE on study_participants(id) should
      // already do this, but we DELETE explicitly so the export is clean
      // even if the FK chain ever bypasses.
      const participantTables = [
        "behavior_prompts", "participant_responses", "participant_events",
      ];
      for (const t of participantTables) {
        const r = this.db
          .prepare(`DELETE FROM ${t} WHERE participant_id NOT IN (SELECT id FROM study_participants)`)
          .run();
        counts[t] = r.changes;
      }
    });
    tx();
    return counts;
  }

  /**
   * Bulk variant — calls deleteParticipantCascade for each id in a single
   * outer transaction. Returns the total number of participant rows deleted
   * across the batch (each successful delete contributes 1).
   */
  deleteParticipantsCascade(participantIds: readonly string[]): number {
    let total = 0;
    const tx = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) total += this.deleteParticipantCascade(id);
    });
    tx(participantIds);
    return total;
  }

  // ─── Replay data ────────────────────────────────────────────────────────

  /**
   * Full per-session replay payload: pack, all turns, all orchestrator
   * decisions, outcome. Used by /adx/replay/<sessionId>.
   */
  replaySession(sessionId: string): {
    session: Record<string, unknown>;
    pack: ScenarioPack;
    turns: Turn[];
    decisions: OrchestratorDecision[];
  } | null {
    const sessionRow = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
      | (Record<string, unknown> & { scenario_pack_json: string })
      | undefined;
    if (!sessionRow) return null;
    const pack = JSON.parse(sessionRow.scenario_pack_json) as ScenarioPack;
    const turns = this.db
      .prepare(
        `SELECT id, turn_number, emitter, emitter_id, tool_calls_json, message,
                thinking, tokens_json, latency_ms, model, timestamp
           FROM turns WHERE session_id = ? ORDER BY turn_number ASC`,
      )
      .all(sessionId) as Array<{
      id: string; turn_number: number; emitter: string; emitter_id: string;
      tool_calls_json: string; message: string | null; thinking: string | null;
      tokens_json: string; latency_ms: number; model: string; timestamp: string;
    }>;
    const decisions = this.db
      .prepare(
        `SELECT decision_index, turn_number, tool_name, tool_input_json, rationale, thinking, tokens_used, timestamp
           FROM orchestrator_decisions WHERE session_id = ? ORDER BY decision_index ASC`,
      )
      .all(sessionId) as Array<{
      decision_index: number; turn_number: number; tool_name: string;
      tool_input_json: string; rationale: string | null; thinking: string | null;
      tokens_used: number; timestamp: string;
    }>;
    return {
      session: sessionRow,
      pack,
      turns: turns.map((r) => ({
        id: r.id,
        sessionId,
        turnNumber: r.turn_number,
        emitter: r.emitter as Turn["emitter"],
        emitterId: r.emitter_id,
        toolCalls: JSON.parse(r.tool_calls_json),
        message: r.message ?? undefined,
        thinking: r.thinking ?? undefined,
        tokens: JSON.parse(r.tokens_json),
        latencyMs: r.latency_ms,
        model: r.model,
        timestamp: r.timestamp,
      })),
      decisions: decisions.map((d) => ({
        turnNumber: d.turn_number,
        toolCall: { name: d.tool_name, input: JSON.parse(d.tool_input_json) },
        rationale: d.rationale ?? undefined,
        thinking: d.thinking ?? undefined,
        timestamp: d.timestamp,
      })),
    };
  }

  // ─── Bulk export helpers ────────────────────────────────────────────────

  /**
   * Wide-format flat row per participant for the "single-row XLSX" export.
   * Joins everything: meta, demographics, free text, opponent, outcome,
   * survey, computed flags, dwell times.
   */
  exportFlatParticipants(): Array<Record<string, unknown>> {
    const participants = this.listParticipantsForAdmin(10000);
    const out: Array<Record<string, unknown>> = [];
    for (const p of participants) {
      const detail = this.exportParticipant(p.id);
      if (!detail) continue;
      const part = detail["participant"] as Record<string, unknown>;
      const responses = (detail["participant_responses"] as Array<Record<string, unknown>>) || [];
      const session = detail["session"] as Record<string, unknown> | null;
      const prompts = (detail["behavior_prompts"] as Array<Record<string, unknown>>) || [];
      const events = (detail["participant_events"] as Array<Record<string, unknown>>) || [];

      const findResp = (screen: string, key: string) =>
        responses.find((r) => r["screen"] === screen && r["key"] === key);
      const personalCtx = findResp("context", "personal_context")?.["value_text"] ?? null;
      const opponent = findResp("engine", "opponent_personality")?.["value_text"] ?? null;
      const latestPrompt = prompts.length > 0 ? prompts[prompts.length - 1] : null;
      const promptText = (latestPrompt?.["prompt_text"] as string) ?? null;
      const promptRevisions = prompts.length;

      // ─── Survey raw scores ──────────────────────────────────────────
      //
      // v2 active items (every new participant — 9 Likert + 1 free text).
      // Surfaced as fixed columns so the wide row is rectangular and easy
      // to slice into stats packages. NULLs for participants who didn't
      // complete the survey or who participated under v1 (those v1 keys
      // that overlap with v2, like `satisfaction`, will still be filled).
      const V2_SURVEY_KEYS = [
        "satisfaction",
        "would_use_again",
        "agent_represented",
        "control",
        "emot_pleasant",
        "emot_anxious",
        "effort_invested",
        "engage_engaged",
        "outfair_share",
      ];
      const surveyValues: Record<string, number | string | null> = {};
      for (const k of V2_SURVEY_KEYS) {
        const r = findResp("post_survey", k);
        surveyValues[k] = (r?.["value_int"] as number) ?? null;
      }
      // Legacy v1 items: include every other answered post-survey key as
      // `legacy_<key>` columns. Historical participants (the 79 already in
      // the DB) keep their rich item-level scores in the export without us
      // having to enumerate the 47-key v1 instrument explicitly here.
      const legacyValues: Record<string, number | string | null> = {};
      for (const r of responses) {
        if (r["screen"] !== "post_survey") continue;
        const k = String(r["key"] || "");
        if (!k || k.startsWith("_")) continue;
        if (V2_SURVEY_KEYS.includes(k) || k === "free_text") continue;
        legacyValues["legacy_" + k] = (r["value_int"] as number) ?? (r["value_text"] as string) ?? null;
      }
      const freeText = findResp("post_survey", "free_text")?.["value_text"] ?? null;

      // Dwell times by screen — _time_on_screen_ms keys
      const dwell: Record<string, number | null> = {
        time_on_consent_ms: (findResp("consent", "_time_on_screen_ms")?.["value_int"] as number) ?? null,
        time_on_context_ms: (findResp("context", "_time_on_screen_ms")?.["value_int"] as number) ?? null,
        time_on_demographics_ms: (findResp("demographics", "_time_on_screen_ms")?.["value_int"] as number) ?? null,
        time_on_post_survey_ms: (findResp("post_survey", "_time_on_screen_ms")?.["value_int"] as number) ?? null,
      };

      // Event counts by type
      const eventCounts: Record<string, number> = {};
      for (const e of events) {
        const t = e["event_type"] as string;
        eventCounts[t] = (eventCounts[t] || 0) + 1;
      }

      // Outcome / pricing / turns
      let outcomeType: string | null = null;
      let finalPrice: number | null = null;
      let turnsConsumed: number | null = null;
      let tokensTotal: number | null = null;
      let degraded = 0;
      let buyerFirstOffer: number | null = null;
      let buyerLastOffer: number | null = null;
      let sellerFirstOffer: number | null = null;
      let sellerLastOffer: number | null = null;
      if (session) {
        outcomeType = (session["outcome_type"] as string) ?? null;
        turnsConsumed = (session["turns_consumed"] as number) ?? null;
        tokensTotal = (session["tokens_total"] as number) ?? null;
        degraded = (session["degraded"] as number) ?? 0;
        try {
          const terms = session["outcome_terms_json"]
            ? JSON.parse(session["outcome_terms_json"] as string)
            : null;
          if (typeof terms?.price === "number") finalPrice = terms.price;
        } catch {}
        const turns = (session["turns"] as Array<Record<string, unknown>>) || [];
        for (const t of turns) {
          let proposedPrice: number | null = null;
          try {
            const tc = JSON.parse((t["tool_calls_json"] as string) || "[]") as Array<{ name: string; input: { issues?: Array<{ name: string; value: number }> } }>;
            const proposal = tc.find((c) => c.name === "submit_proposal");
            if (proposal) {
              const priceIssue = proposal.input.issues?.find((i) => i.name === "price");
              if (priceIssue && typeof priceIssue.value === "number") proposedPrice = priceIssue.value;
            }
          } catch {}
          if (proposedPrice == null) continue;
          if (t["emitter_id"] === "buyer") {
            if (buyerFirstOffer === null) buyerFirstOffer = proposedPrice;
            buyerLastOffer = proposedPrice;
          } else if (t["emitter_id"] === "seller") {
            if (sellerFirstOffer === null) sellerFirstOffer = proposedPrice;
            sellerLastOffer = proposedPrice;
          }
        }
      }
      const estCostUsd = tokensTotal !== null ? Math.round((tokensTotal / 1_000_000) * 9 * 1000) / 1000 : null;

      const expMode = (part["experiment_mode"] as string) ?? "agent";
      out.push({
        // Identity — Prolific PID is the canonical identifier where present
        // (study_participants.id == prolific_pid for new participants per
        // 2026-05-14 alignment change). prolific_pid is duplicated as a
        // separate column too so downstream tools that key on a named
        // 'prolific_pid' column work without inspecting the id.
        participant_id:      p.id,
        prolific_pid:        p.prolific_pid,
        prolific_study_id:   p.prolific_study_id,
        prolific_session_id: p.prolific_session_id,
        external_id: part["external_id"] ?? null,
        role: p.role,
        experiment_mode: expMode,
        opponent_personality: opponent,
        condition: p.role && opponent ? `${expMode}__${p.role}_vs_${opponent}` : null,
        excluded: part["excluded"] ?? 0,
        excluded_reason: part["excluded_reason"] ?? null,
        test_data: part["test_data"] ?? 0,
        // Timing
        created_at: p.created_at,
        finished_at: p.finished_at,
        total_time_sec: p.total_time_sec,
        completion_code: p.completion_code,
        // Consent + demographics
        consent: part["consent"] ?? 0,
        age: part["age"] ?? null,
        gender: part["gender"] ?? null,
        experience: part["experience"] ?? null,
        ai_familiarity: part["ai_familiarity"] ?? null,
        // Browser / device
        device_type: part["device_type"] ?? null,
        browser: part["browser"] ?? null,
        os: part["os"] ?? null,
        viewport_w: part["viewport_w"] ?? null,
        viewport_h: part["viewport_h"] ?? null,
        screen_w: part["screen_w"] ?? null,
        screen_h: part["screen_h"] ?? null,
        timezone: part["timezone"] ?? null,
        language: part["language"] ?? null,
        connection_type: part["connection_type"] ?? null,
        user_agent: part["user_agent"] ?? null,
        // (Prolific tokens already at the top of the row in the Identity
        // block — see participant_id / prolific_pid / prolific_study_id /
        // prolific_session_id above.)
        // Quality flags
        flag_mobile: p.flag_mobile,
        flag_speeding: p.flag_speeding,
        flag_short_prompt: p.flag_short_prompt,
        flag_copy_paste: p.flag_copy_paste,
        flag_degraded: degraded,
        // Free-text inputs
        personal_context: personalCtx,
        personal_context_length: typeof personalCtx === "string" ? personalCtx.length : 0,
        behavior_prompt: promptText,
        behavior_prompt_length: typeof promptText === "string" ? promptText.length : 0,
        behavior_prompt_revisions: promptRevisions,
        // Negotiation
        session_id: p.session_id,
        outcome_type: outcomeType,
        final_price: finalPrice,
        turns_consumed: turnsConsumed,
        tokens_total: tokensTotal,
        est_cost_usd: estCostUsd,
        buyer_first_offer: buyerFirstOffer,
        buyer_last_offer: buyerLastOffer,
        seller_first_offer: sellerFirstOffer,
        seller_last_offer: sellerLastOffer,
        // Survey — v2 active items as named columns, free_text below
        ...surveyValues,
        free_text: freeText,
        // Legacy v1 items (only present for participants who answered the
        // older instrument; null/absent on v2 rows). Prefixed with
        // `legacy_` so they're easy to drop in stats prep.
        ...legacyValues,
        // Dwell times
        ...dwell,
        // Event counts
        events_total: p.total_events,
        last_screen: p.last_screen,
        clicks: eventCounts["click"] || 0,
        focus_events: eventCounts["focus"] || 0,
        blur_events: eventCounts["blur"] || 0,
        paste_events: eventCounts["paste"] || 0,
        scroll_events: eventCounts["scroll"] || 0,
        visibility_changes: eventCounts["visibilitychange"] || 0,
        idle_periods: eventCounts["idle"] || 0,
        mobile_blocked_count: eventCounts["mobile_blocked"] || 0,
      });
    }
    return out;
  }

  /**
   * All buyer/seller turns across all sessions, flat. Wide column set: includes
   * private `thinking`, parsed proposal action + price for easy analysis,
   * tokens, latency, and the full tool_calls_json payload.
   */
  exportAllTurns(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT
           t.id AS turn_id,
           t.session_id,
           sp.id AS participant_id,
           sp.prolific_pid,
           sp.role AS participant_role,
           t.turn_number,
           t.emitter,
           t.emitter_id AS agent,
           t.timestamp,
           t.model,
           t.latency_ms,
           t.message,
           t.thinking,
           t.tool_calls_json,
           t.tokens_json
         FROM turns t
         LEFT JOIN study_participants sp ON sp.session_id = t.session_id
         ORDER BY t.session_id, t.turn_number ASC`,
      )
      .all() as Array<{
      turn_id: string;
      session_id: string;
      participant_id: string | null;
      participant_role: string | null;
      turn_number: number;
      emitter: string;
      agent: string;
      timestamp: string;
      model: string;
      latency_ms: number;
      message: string | null;
      thinking: string | null;
      tool_calls_json: string;
      tokens_json: string;
      prolific_pid: string | null;
    }>;
    // Enrich each row with parsed action/price + tokens broken out, while
    // preserving the raw JSON columns for full fidelity.
    return rows.map((r) => {
      let action: string | null = null;
      let price: number | null = null;
      let isFinal = 0;
      let intent: string | null = null;
      try {
        const tc = JSON.parse(r.tool_calls_json) as Array<{ name: string; input: Record<string, unknown> }>;
        const proposal = tc.find((c) => c.name === "submit_proposal");
        if (proposal) {
          action = (proposal.input as { action?: string }).action ?? null;
          isFinal = (proposal.input as { is_final?: boolean }).is_final ? 1 : 0;
          const issues = (proposal.input as { issues?: Array<{ name: string; value: number }> }).issues ?? [];
          const priceIssue = issues.find((i) => i.name === "price");
          if (priceIssue && typeof priceIssue.value === "number") price = priceIssue.value;
        } else {
          const msg = tc.find((c) => c.name === "send_message");
          if (msg) intent = (msg.input as { intent?: string }).intent ?? null;
        }
      } catch { /* preserve raw json */ }
      let tokensInput: number | null = null;
      let tokensOutput: number | null = null;
      let tokensCacheRead: number | null = null;
      let tokensCacheWrite: number | null = null;
      try {
        const tk = JSON.parse(r.tokens_json) as { input?: number; output?: number; cache_read_input?: number; cache_creation_input?: number };
        tokensInput = typeof tk.input === "number" ? tk.input : null;
        tokensOutput = typeof tk.output === "number" ? tk.output : null;
        tokensCacheRead = typeof tk.cache_read_input === "number" ? tk.cache_read_input : null;
        tokensCacheWrite = typeof tk.cache_creation_input === "number" ? tk.cache_creation_input : null;
      } catch { /* preserve raw json */ }
      return {
        turn_id: r.turn_id,
        session_id: r.session_id,
        participant_id: r.participant_id,
        prolific_pid: r.prolific_pid,
        participant_role: r.participant_role,
        turn_number: r.turn_number,
        timestamp: r.timestamp,
        agent: r.agent,
        emitter: r.emitter,
        model: r.model,
        latency_ms: r.latency_ms,
        action,
        price,
        is_final: isFinal,
        intent,
        message: r.message,
        thinking: r.thinking,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        tokens_cache_read: tokensCacheRead,
        tokens_cache_write: tokensCacheWrite,
        tokens_total: (tokensInput ?? 0) + (tokensOutput ?? 0),
        tool_calls_json: r.tool_calls_json,
        tokens_json: r.tokens_json,
      };
    });
  }

  /**
   * All orchestrator decisions across all sessions, flat. Includes private
   * `thinking`, the rationale string, the full input JSON of the chosen tool,
   * and a parsed `target_participant_id` when the decision was a request_turn.
   */
  exportAllDecisions(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT
           od.session_id,
           sp.id AS participant_id,
           sp.prolific_pid,
           od.decision_index,
           od.turn_number,
           od.timestamp,
           od.tool_name,
           od.tool_input_json,
           od.rationale,
           od.thinking,
           od.tokens_used
         FROM orchestrator_decisions od
         LEFT JOIN study_participants sp ON sp.session_id = od.session_id
         ORDER BY od.session_id, od.decision_index ASC`,
      )
      .all() as Array<{
      session_id: string;
      participant_id: string | null;
      prolific_pid: string | null;
      decision_index: number;
      turn_number: number;
      timestamp: string;
      tool_name: string;
      tool_input_json: string;
      rationale: string | null;
      thinking: string | null;
      tokens_used: number;
    }>;
    return rows.map((r) => {
      let targetParticipant: string | null = null;
      let instruction: string | null = null;
      let outcomeType: string | null = null;
      let outcomeSummary: string | null = null;
      try {
        const input = JSON.parse(r.tool_input_json) as Record<string, unknown>;
        if (typeof input.participant_id === "string") targetParticipant = input.participant_id;
        if (typeof input.instruction === "string") instruction = input.instruction;
        if (typeof input.type === "string") outcomeType = input.type;
        if (typeof input.summary === "string") outcomeSummary = input.summary;
      } catch { /* preserve raw json */ }
      return {
        session_id: r.session_id,
        participant_id: r.participant_id,
        prolific_pid: r.prolific_pid,
        decision_index: r.decision_index,
        turn_number: r.turn_number,
        timestamp: r.timestamp,
        agent: "orchestrator",
        tool_name: r.tool_name,
        target_participant: targetParticipant,
        instruction,
        outcome_type: outcomeType,
        outcome_summary: outcomeSummary,
        rationale: r.rationale,
        thinking: r.thinking,
        tokens_used: r.tokens_used,
        tool_input_json: r.tool_input_json,
      };
    });
  }

  /**
   * Unified per-session agent log — buyer, seller, AND orchestrator
   * interleaved in chronological order. Each row has a uniform set of columns
   * so a researcher can read top-to-bottom and see exactly what every agent
   * said and decided, with timestamps.
   */
  exportUnifiedAgentLog(): Array<Record<string, unknown>> {
    const turns = this.exportAllTurns();
    const decisions = this.exportAllDecisions();
    type LogRow = {
      session_id: string;
      participant_id: string | null;
      prolific_pid: string | null;
      timestamp: string;
      agent: string;            // 'buyer' | 'seller' | 'orchestrator'
      action: string | null;    // proposal action OR orchestrator tool name
      price: number | null;
      is_final: number;
      target_participant: string | null;
      message_or_instruction: string | null;
      thinking: string | null;
      rationale: string | null;
      model: string | null;
      latency_ms: number | null;
      tokens_in: number | null;
      tokens_out: number | null;
      tokens_total: number | null;
      raw_json: string;
    };
    const rows: LogRow[] = [];
    for (const t of turns) {
      rows.push({
        session_id: t["session_id"] as string,
        participant_id: (t["participant_id"] as string | null) ?? null,
        prolific_pid: (t["prolific_pid"] as string | null) ?? null,
        timestamp: t["timestamp"] as string,
        agent: t["agent"] as string,
        action: (t["action"] as string | null) ?? "speak",
        price: (t["price"] as number | null),
        is_final: (t["is_final"] as number) ?? 0,
        target_participant: null,
        message_or_instruction: (t["message"] as string | null) ?? null,
        thinking: (t["thinking"] as string | null) ?? null,
        rationale: null,
        model: (t["model"] as string | null) ?? null,
        latency_ms: (t["latency_ms"] as number | null) ?? null,
        tokens_in: (t["tokens_input"] as number | null) ?? null,
        tokens_out: (t["tokens_output"] as number | null) ?? null,
        tokens_total: (t["tokens_total"] as number | null) ?? null,
        raw_json: (t["tool_calls_json"] as string) ?? "[]",
      });
    }
    for (const d of decisions) {
      rows.push({
        session_id: d["session_id"] as string,
        participant_id: (d["participant_id"] as string | null) ?? null,
        prolific_pid: (d["prolific_pid"] as string | null) ?? null,
        timestamp: d["timestamp"] as string,
        agent: "orchestrator",
        action: (d["tool_name"] as string),
        price: null,
        is_final: 0,
        target_participant: (d["target_participant"] as string | null) ?? null,
        message_or_instruction: (d["instruction"] as string | null) ?? (d["outcome_summary"] as string | null) ?? null,
        thinking: (d["thinking"] as string | null) ?? null,
        rationale: (d["rationale"] as string | null) ?? null,
        model: null,
        latency_ms: null,
        tokens_in: null,
        tokens_out: null,
        tokens_total: (d["tokens_used"] as number | null) ?? null,
        raw_json: (d["tool_input_json"] as string) ?? "{}",
      });
    }
    rows.sort((a, b) => {
      if (a.session_id !== b.session_id) return a.session_id.localeCompare(b.session_id);
      return a.timestamp.localeCompare(b.timestamp);
    });
    return rows as unknown as Array<Record<string, unknown>>;
  }

  /**
   * The "system prompt" briefing of every agent in every session — exactly
   * what each LLM was told at startup. Useful for reproducibility checks and
   * for verifying that the participant's behavior prompt was wired through.
   */
  exportAllAgentBriefings(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT
           p.session_id,
           sp.id AS participant_id,
           sp.prolific_pid,
           p.participant_id AS agent,
           p.role,
           p.model,
           p.brief_json,
           p.system_prompt,
           s.scenario_id,
           s.started_at AS session_started_at
         FROM participants p
         JOIN sessions s ON s.id = p.session_id
         LEFT JOIN study_participants sp ON sp.session_id = p.session_id
         ORDER BY p.session_id, p.participant_id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  /** All behavior-prompt revisions, flat. */
  exportAllBehaviorPrompts(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT bp.participant_id, sp.prolific_pid, sp.role, bp.revision, bp.prompt_text,
                bp.mapped_signals_json, bp.mapped_notes, bp.match_rating,
                bp.correction_note, bp.submitted_at
         FROM behavior_prompts bp
         LEFT JOIN study_participants sp ON sp.id = bp.participant_id
         ORDER BY bp.participant_id, bp.revision`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  /** All survey responses flat, one row per (participant × question). */
  exportAllSurvey(): Array<Record<string, unknown>> {
    // Long-format post-survey table. One row per (participant × item).
    // Prolific tokens are joined onto every row so the file stands alone
    // for analysis without needing a second JOIN against participants.
    // For new participants the participant_id IS the prolific_pid; for
    // historical rows (nanoid id) the prolific_pid column carries the
    // separate Prolific token if any.
    return this.db
      .prepare(
        `SELECT pr.participant_id,
                sp.prolific_pid,
                sp.prolific_study_id,
                sp.prolific_session_id,
                sp.role,
                sp.experiment_mode,
                pr.key,
                pr.value_int,
                pr.value_text,
                pr.submitted_at
         FROM participant_responses pr
         LEFT JOIN study_participants sp ON sp.id = pr.participant_id
         WHERE pr.screen = 'post_survey'
           AND (pr.key IS NULL OR pr.key NOT LIKE '\\_%' ESCAPE '\\')
         ORDER BY pr.participant_id, pr.key`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  /** All events, flat. Useful for telemetry deep-dives. */
  exportAllEvents(limit = 100_000): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT pe.participant_id,
                sp.prolific_pid,
                pe.client_ts,
                pe.server_ts,
                pe.screen,
                pe.event_type,
                pe.payload_json
           FROM participant_events pe
           LEFT JOIN study_participants sp ON sp.id = pe.participant_id
           ORDER BY pe.id ASC
           LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  /** Plain-text per-session transcript for qualitative analysis. */
  buildTranscriptText(sessionId: string): string | null {
    const replay = this.replaySession(sessionId);
    if (!replay) return null;
    const lines: string[] = [];
    lines.push(`=== Session ${sessionId} ===`);
    lines.push(`Status: ${replay.session["status"]}`);
    lines.push(`Outcome: ${replay.session["outcome_type"]} — ${replay.session["outcome_summary"] || "—"}`);
    if (replay.session["outcome_terms_json"]) {
      try {
        const t = JSON.parse(replay.session["outcome_terms_json"] as string);
        lines.push(`Terms: ${JSON.stringify(t)}`);
      } catch {}
    }
    lines.push(`Turns: ${replay.turns.length}`);
    lines.push(``);
    for (const turn of replay.turns) {
      lines.push(`--- Turn ${turn.turnNumber} · ${turn.emitterId} ---`);
      lines.push(turn.message ?? "(no public message)");
      const proposal = turn.toolCalls.find((c) => c.name === "submit_proposal");
      if (proposal) {
        const input = proposal.input as { action?: string; issues?: Array<{ name: string; value: number }> };
        const priceIssue = input.issues?.find((i) => i.name === "price");
        if (priceIssue) lines.push(`→ ${input.action || "propose"} @ $${priceIssue.value.toLocaleString()}`);
      }
      lines.push(``);
    }
    return lines.join("\n");
  }

  /** Snapshot the SQLite DB to a temp path and return its bytes. Used by /adx/backup. */
  backupBytes(): Buffer {
    // SQLite VACUUM INTO creates a clean, defragmented copy at the target path.
    // Use a temp file in the OS temp dir; read its bytes; delete.
    const tmpPath = `/tmp/ai2ai-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    this.db.exec(`VACUUM INTO '${tmpPath}'`);
    const bytes = readFileSync(tmpPath);
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    return bytes;
  }

  close(): void {
    this.db.close();
  }
}

export function openPersistence(dbPath?: string): SqlitePersistence {
  const resolved = dbPath ?? process.env["AI2AI_DB_PATH"] ?? "./data/sessions.db";
  return new SqlitePersistence(resolved);
}
