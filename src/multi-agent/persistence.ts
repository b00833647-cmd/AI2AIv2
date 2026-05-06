// SQLite persistence — every participant turn and orchestrator decision gets
// a row. The orchestrator's reasoning is auditable and replayable.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
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
          p.llm.model,
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
  } | undefined {
    return this.db
      .prepare(
        `SELECT id, created_at, finished_at, role, consent, age, gender,
                experience, ai_familiarity, attention_check_pass, session_id,
                completion_code, device_type, browser, os, user_agent
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
    age: number | null;
    attention_check_pass: number | null;
    completion_code: string | null;
    session_id: string | null;
    outcome_type: string | null;
    outcome_terms_json: string | null;
    tokens_total: number | null;
    last_screen: number | null;
    total_events: number;
    total_time_sec: number | null;
    device_type: string | null;
    flag_speeding: number;
    flag_attention: number;
    flag_short_prompt: number;
    flag_mobile: number;
  }> {
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
           s.outcome_type,
           s.outcome_terms_json,
           s.tokens_total,
           (SELECT MAX(screen) FROM participant_events WHERE participant_id = sp.id) AS last_screen,
           (SELECT COUNT(*) FROM participant_events WHERE participant_id = sp.id) AS total_events,
           CASE WHEN sp.finished_at IS NOT NULL
             THEN CAST((julianday(sp.finished_at) - julianday(sp.created_at)) * 86400 AS INTEGER)
             ELSE NULL END AS total_time_sec,
           -- Speeding flag: finished in under 90 seconds (very rough).
           CASE WHEN sp.finished_at IS NOT NULL
             AND (julianday(sp.finished_at) - julianday(sp.created_at)) * 86400 < 90
             THEN 1 ELSE 0 END AS flag_speeding,
           -- Attention check failed (selected anything other than 'A lot' on the IMC).
           CASE WHEN sp.attention_check_pass = 0 THEN 1 ELSE 0 END AS flag_attention,
           -- Behavior prompt under 80 chars (low-effort).
           CASE WHEN EXISTS (
             SELECT 1 FROM behavior_prompts WHERE participant_id = sp.id AND length(prompt_text) < 80
           ) THEN 1 ELSE 0 END AS flag_short_prompt,
           -- Mobile/tablet flag: violates the "PC or laptop only" consent.
           CASE WHEN sp.device_type IN ('phone', 'tablet') THEN 1 ELSE 0 END AS flag_mobile
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
      age: number | null;
      attention_check_pass: number | null;
      completion_code: string | null;
      session_id: string | null;
      outcome_type: string | null;
      outcome_terms_json: string | null;
      tokens_total: number | null;
      last_screen: number | null;
      total_events: number;
      total_time_sec: number | null;
      device_type: string | null;
      flag_speeding: number;
      flag_attention: number;
      flag_short_prompt: number;
      flag_mobile: number;
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

  countStudyParticipants(): { total: number; finished: number } {
    const t = this.db.prepare(`SELECT COUNT(*) AS n FROM study_participants`).get() as { n: number };
    const f = this.db
      .prepare(`SELECT COUNT(*) AS n FROM study_participants WHERE finished_at IS NOT NULL`)
      .get() as { n: number };
    return { total: t.n, finished: f.n };
  }

  close(): void {
    this.db.close();
  }
}

export function openPersistence(dbPath?: string): SqlitePersistence {
  const resolved = dbPath ?? process.env["AI2AI_DB_PATH"] ?? "./data/sessions.db";
  return new SqlitePersistence(resolved);
}
