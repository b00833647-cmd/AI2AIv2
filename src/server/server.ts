// Minimal demo server: a single HTML page + an SSE endpoint that runs a
// negotiation session and streams events back to the browser.
//
// Built on Node's stdlib `http` — no Express, no build step. Start with:
//   ANTHROPIC_API_KEY=... \
//   BUYER_ANTHROPIC_API_KEY=... \
//   SELLER_ANTHROPIC_API_KEY=... \
//   ORCHESTRATOR_ANTHROPIC_API_KEY=... \
//   npm run serve
//
// Then open http://localhost:3000 in your browser.

import http from "node:http";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { runSession } from "../multi-agent/session-runner.ts";
import {
  buildPack,
  pickOpponentPersonality,
  type IntakeAnswers,
  type Role,
} from "../multi-agent/pack-builder.ts";
import { openPersistence, type SqlitePersistence } from "../multi-agent/persistence.ts";

const PORT = Number(process.env["AI2AI_PORT"] ?? 3737);
const WEB_ROOT = path.resolve("web");
const SCENARIO_ID = "toyota-camry-negotiation";

// CORS headers — required so the page works inside Claude's Launch preview
// iframe (a different origin) and via plain file:// opens. Wide-open is fine
// for a local research demo; tighten if you ever expose this beyond localhost.
function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      await handleHealth(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(WEB_ROOT, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/study" || url.pathname === "/study.html")) {
      const html = await readFile(path.join(WEB_ROOT, "study.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Static asset serving for /img/... — serves files under web/img/.
    // Path-traversal-safe: rejects '..' and absolute paths, then resolves
    // against WEB_ROOT and re-checks the resolved path is still inside it.
    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      await handleStaticImage(url.pathname, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      await handleRun(req, res);
      return;
    }

    // Participant-study endpoints (one human, one walkthrough).
    if (req.method === "POST" && url.pathname === "/api/p/start") {
      await handleParticipantStart(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/consent") {
      await handleParticipantConsent(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/demographics") {
      await handleParticipantDemographics(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/role") {
      await handleParticipantRole(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/context") {
      await handleParticipantContext(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/prompt") {
      await handleParticipantPrompt(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/prompt-confirm") {
      await handleParticipantPromptConfirm(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/run") {
      await handleParticipantRun(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/finish") {
      await handleParticipantFinish(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/event") {
      await handleParticipantEvent(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/p/export") {
      await handleParticipantExport(req, res, url);
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/p/erase") {
      await handleParticipantErase(req, res, url);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      await handleAdminPage(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/data") {
      await handleAdminData(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/admin/p/")) {
      const pid = url.pathname.slice("/admin/p/".length);
      await handleAdminParticipantDetail(req, res, pid);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    console.error("[server] unhandled:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end((err as Error).message);
    } else {
      res.end();
    }
  }
});

// Boot-time env validation. Exits if no Anthropic key is reachable; warns
// (but proceeds) if optional protections aren't configured.
function validateBootEnv(): void {
  const k1 = process.env["ANTHROPIC_API_KEY"];
  const buyer = process.env["BUYER_ANTHROPIC_API_KEY"];
  const seller = process.env["SELLER_ANTHROPIC_API_KEY"];
  const orch = process.env["ORCHESTRATOR_ANTHROPIC_API_KEY"];
  const haveAny = Boolean(k1 || (buyer && seller && orch));
  if (!haveAny) {
    console.error("[boot] ✗ No Anthropic API key configured.");
    console.error("[boot]   Set ANTHROPIC_API_KEY (single-key mode) OR all three of");
    console.error("[boot]   BUYER_ANTHROPIC_API_KEY / SELLER_ANTHROPIC_API_KEY / ORCHESTRATOR_ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  if (!process.env["AI2AI_ADMIN_PASSWORD"]) {
    console.warn("[boot] ⚠ AI2AI_ADMIN_PASSWORD not set — /admin and /api/p/erase will return 503.");
  }
  if (!process.env["AI2AI_DAILY_BUDGET_USD"]) {
    console.warn("[boot] ⚠ AI2AI_DAILY_BUDGET_USD not set — no daily LLM cost cap.");
  }
  if (!process.env["AI2AI_DB_PATH"]) {
    console.warn("[boot] ⚠ AI2AI_DB_PATH not set — using ./data/sessions.db (mount a volume for persistence in production).");
  }
}
validateBootEnv();

server.listen(PORT, () => {
  console.log(`[boot] ✓ AI2AI server listening on http://localhost:${PORT}`);
  console.log(`[boot]   participant study at /study, admin dashboard at /admin`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — refusing new connections, draining…`);
  server.close((err) => {
    if (err) {
      console.error("[shutdown] server.close error:", err);
      process.exit(1);
    }
    console.log("[shutdown] clean exit");
    process.exit(0);
  });
  // Hard kill after 10s if anything's stuck.
  setTimeout(() => {
    console.error("[shutdown] timed out after 10s — forcing exit");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Per-IP rate limit (in-memory) ───────────────────────────────────────
//
// `recentStarts` maps a hashed IP → timestamp of last /api/p/start. When
// the server restarts, the map clears (acceptable for a single-machine
// research rig). For a multi-instance deploy use Redis instead.
const recentStarts = new Map<string, number>();

function getClientIp(req: http.IncomingMessage): string {
  // Trust X-Forwarded-For when behind a known proxy (Railway / Fly / etc.).
  // Take the FIRST address — the original client.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

import crypto from "node:crypto";
function hashIp(ip: string): string {
  // Per-day salt so the hash isn't a stable identifier across days.
  const salt = new Date().toISOString().slice(0, 10);
  return crypto.createHash("sha256").update(salt + ":" + ip).digest("hex").slice(0, 16);
}

// Periodic cleanup of stale rate-limit entries (older than 24h).
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, ts] of recentStarts) if (ts < cutoff) recentStarts.delete(k);
}, 60 * 60 * 1000).unref();

// ─── Cost cap helper ─────────────────────────────────────────────────────
//
// ~$9/M is the Sonnet 4.6 input/output midpoint we use for ballpark estimates.
// Refine if you switch models or want input/output broken out.
function spendUsdToday(db: SqlitePersistence): number {
  const todayIso = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const tokens = db.tokensSpentSince(todayIso);
  return (tokens / 1_000_000) * 9;
}

// ─── Health endpoint (for cloud platform health checks) ──────────────────
const STARTED_AT = Date.now();
async function handleHealth(res: http.ServerResponse): Promise<void> {
  let dbWritable = false;
  try {
    withDb((db) => db.countStudyParticipants());
    dbWritable = true;
  } catch { /* leave false */ }
  const body = {
    ok: dbWritable && !shuttingDown,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    dbWritable,
    shuttingDown,
    version: "1.0.0",
  };
  res.writeHead(body.ok ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── /api/run handler ─────────────────────────────────────────────────────

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let answers: IntakeAnswers;
  try {
    answers = JSON.parse(body) as IntakeAnswers;
  } catch (err) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("invalid JSON: " + (err as Error).message);
    return;
  }

  // SSE headers.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  try {
    // 1. Pick opponent personality (free-text mode — no behavior mapping).
    const opponentPersonality = pickOpponentPersonality();
    const opponentRole = answers.userRole === "buyer" ? "seller" : "buyer";
    send("opponent_personality", { role: opponentRole, personality: opponentPersonality });

    // 2. Build pack and persist it on disk for transparency.
    const pack = buildPack({
      answers,
      opponentPersonality,
      scenarioId: SCENARIO_ID,
    });
    const outPath = path.resolve(`scenarios/${SCENARIO_ID}/pack.json`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(pack, null, 2));

    // 4. Run the session, streaming events as they happen.
    send("status", { stage: "negotiating", message: "Negotiation starting…" });
    const persistence = openPersistence();
    try {
      const result = await runSession({
        pack,
        persistence,
        verbose: false,
        onEvent: (event) => {
          if (aborted) return;
          if (event.type === "session_start") {
            send("session_start", { sessionId: event.sessionId, orchestratorModel: event.orchestratorModel });
          } else if (event.type === "participant_turn") {
            const t = event.turn;
            send("turn", {
              turnNumber: t.turnNumber,
              emitterId: t.emitterId,
              message: t.message ?? null,
              toolCalls: t.toolCalls,
              tokens: t.tokens,
            });
          } else if (event.type === "orchestrator_decision") {
            send("decision", {
              turnNumber: event.decision.turnNumber,
              toolName: event.decision.toolCall.name,
              input: event.decision.toolCall.input,
              tokensUsed: event.tokensUsed,
            });
          } else if (event.type === "fallback_triggered") {
            send("fallback", { reason: event.reason });
          } else if (event.type === "session_end") {
            send("session_end", {
              outcome: event.outcome,
              degraded: event.degraded,
              consumed: event.consumed,
            });
          }
        },
        orchestratorLLM: pack.orchestrator ?? {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 4000,
          apiKeyEnv: "ORCHESTRATOR_ANTHROPIC_API_KEY",
        },
      });
      send("done", {
        sessionId: result.sessionId,
        outcome: result.outcome,
        consumed: result.consumed,
        degraded: result.degraded,
      });
    } finally {
      persistence.close();
    }
  } catch (err) {
    console.error("[server] /api/run error:", err);
    send("error", { message: (err as Error).message });
  } finally {
    res.end();
  }
}

// Static-image serving for `/img/...` — only files under WEB_ROOT/img/.
// Path-traversal-safe: relative path must not contain '..' segments and the
// resolved absolute path must still live inside WEB_ROOT.
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
async function handleStaticImage(pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname.replace(/^\/+/, ""); // strip leading slash
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad path");
    return;
  }
  const abs = path.resolve(WEB_ROOT, rel);
  if (!abs.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const ctype = MIME_BY_EXT[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": ctype,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ─── Locked stimulus for the participant study ────────────────────────────
//
// Same scenario for every participant. Hidden from the form; only their role
// and behavior prompt vary. Opponent has neutral signals (all zeros) so any
// behavior differences across participants are attributable to *their*
// prompt, not opponent-luck.

const STUDY_STIMULUS = {
  mileage: "32,000 mi",
  customizations:
    "All-weather floor mats added; new Michelin tires installed 2 months ago; dealer-serviced.",
  marketPrice: 24000,
  sellerListing: 25500,
  sellerMinimum: 22500,
  buyerTarget: 22000,
  buyerMax: 24500,
} as const;

// (NEUTRAL_OPPONENT removed — opponent is now drawn at random per session in
//  handleParticipantRun. The randomized signals are saved to
//  participant_responses(screen='engine', key='opponent_signals') for analysis.)

// ─── JSON helpers ─────────────────────────────────────────────────────────

async function readJson<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
  const body = await readBody(req);
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("invalid JSON: " + (err as Error).message);
    return null;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function withDb<T>(fn: (db: SqlitePersistence) => T): T {
  const db = openPersistence();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function require400(
  res: http.ServerResponse,
  cond: boolean,
  msg: string,
): cond is true {
  if (!cond) sendJson(res, 400, { error: msg });
  return cond;
}

// ─── Participant-study handlers ───────────────────────────────────────────

interface StartBody {
  userAgent?: string;
  externalId?: string;
  // Browser / device metadata captured client-side at study start.
  viewport?: { w: number; h: number };
  screen?: { w: number; h: number };
  timezone?: string;
  language?: string;
  referrer?: string;
  connectionType?: string;
}
async function handleParticipantStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Per-IP rate limit — one new participant per IP per 24h. Prevents farming.
  // Disabled when AI2AI_RATE_LIMIT=off (e.g. for lab pilots over a single IP).
  if (process.env["AI2AI_RATE_LIMIT"] !== "off") {
    const ipHash = hashIp(getClientIp(req));
    if (recentStarts.has(ipHash)) {
      const elapsed = Date.now() - (recentStarts.get(ipHash) ?? 0);
      if (elapsed < 24 * 60 * 60 * 1000) {
        sendJson(res, 429, {
          error: "rate_limited",
          message: "Only one study attempt per IP per 24 hours. Please contact the researcher if you need to retry.",
        });
        return;
      }
    }
    recentStarts.set(ipHash, Date.now());
  }

  const body = await readJson<StartBody>(req, res);
  if (body === null) return;
  const id = nanoid(12);
  const ua = body.userAgent ?? "";
  const { browser, os, deviceType } = parseUserAgent(ua);
  withDb((db) => {
    db.createStudyParticipant({ id, userAgent: ua });
    db.updateStudyParticipant(id, {
      viewport_w: body.viewport?.w ?? null,
      viewport_h: body.viewport?.h ?? null,
      screen_w: body.screen?.w ?? null,
      screen_h: body.screen?.h ?? null,
      timezone: body.timezone ?? null,
      language: body.language ?? null,
      referrer: body.referrer ?? null,
      browser,
      os,
      device_type: deviceType,
      connection_type: body.connectionType ?? null,
    } as Parameters<typeof db.updateStudyParticipant>[1]);
  });
  sendJson(res, 200, { participantId: id });
}

/** Tiny user-agent parser — good enough for analysis grouping. */
function parseUserAgent(ua: string): { browser: string; os: string; deviceType: string } {
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
  const isTablet = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  const deviceType = isTablet ? "tablet" : isMobile ? "phone" : "desktop";
  let browser = "Unknown";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  let os = "Unknown";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return { browser, os, deviceType };
}

interface ConsentBody {
  participantId: string;
  consent: boolean;
  timeOnScreenMs?: number;
}
async function handleParticipantConsent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<ConsentBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, body.consent === true, "consent required")) return;

  withDb((db) => {
    db.updateStudyParticipant(body.participantId, { consent: true });
    if (typeof body.timeOnScreenMs === "number") {
      db.insertParticipantResponses(body.participantId, "consent", [
        { key: "_time_on_screen_ms", valueInt: body.timeOnScreenMs },
      ]);
    }
  });
  sendJson(res, 200, { ok: true });
}

interface DemographicsBody {
  participantId: string;
  age?: number | null;
  gender?: string | null;
  experience?: string | null;
  ai_familiarity?: string | null;
  attention_check_pass?: boolean;
  timeOnScreenMs?: number;
}
async function handleParticipantDemographics(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<DemographicsBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;

  withDb((db) => {
    db.updateStudyParticipant(body.participantId, {
      age: body.age ?? null,
      gender: body.gender ?? null,
      experience: body.experience ?? null,
      ai_familiarity: body.ai_familiarity ?? null,
      attention_check_pass: body.attention_check_pass ?? false,
    });
    if (typeof body.timeOnScreenMs === "number") {
      db.insertParticipantResponses(body.participantId, "demographics", [
        { key: "_time_on_screen_ms", valueInt: body.timeOnScreenMs },
      ]);
    }
  });
  sendJson(res, 200, { ok: true });
}

interface RoleBody {
  participantId: string;
  role: Role;
}
async function handleParticipantRole(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<RoleBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, body.role === "buyer" || body.role === "seller", "role must be buyer or seller")) return;

  withDb((db) => db.updateStudyParticipant(body.participantId, { role: body.role }));
  sendJson(res, 200, { ok: true });
}

interface ContextBody {
  participantId: string;
  contextText: string;
  timeOnScreenMs?: number;
}
async function handleParticipantContext(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<ContextBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, typeof body.contextText === "string", "contextText required")) return;

  withDb((db) => {
    db.insertParticipantResponses(body.participantId, "context", [
      { key: "personal_context", valueText: body.contextText },
      ...(typeof body.timeOnScreenMs === "number"
        ? [{ key: "_time_on_screen_ms", valueInt: body.timeOnScreenMs }]
        : []),
    ]);
  });
  sendJson(res, 200, { ok: true });
}

interface PromptBody {
  participantId: string;
  promptText: string;
  personalContext?: string;
}
async function handleParticipantPrompt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<PromptBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, typeof body.promptText === "string" && body.promptText.length > 0, "promptText required")) return;

  const participant = withDb((db) => db.getStudyParticipant(body.participantId));
  if (!participant) {
    sendJson(res, 404, { error: "unknown participantId" });
    return;
  }
  if (!participant.role) {
    sendJson(res, 400, { error: "set role first" });
    return;
  }

  // Free-text mode: no signal mapping, no extra LLM call. The participant's
  // prompt goes straight into the agent's system prompt at session start.
  // mapped_signals_json is stored as JSON literal `null` (column is NOT NULL).
  const { revision } = withDb((db) =>
    db.insertBehaviorPrompt({
      participantId: body.participantId,
      promptText: body.promptText,
      mappedSignals: null,
      mappedNotes: null,
    }),
  );

  sendJson(res, 200, { revision });
}

interface PromptConfirmBody {
  participantId: string;
  matchRating: number;
  correctionNote?: string;
  timeOnScreenMs?: number;
}
async function handleParticipantPromptConfirm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<PromptConfirmBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, Number.isInteger(body.matchRating) && body.matchRating >= 1 && body.matchRating <= 7, "matchRating must be 1-7 integer")) return;

  withDb((db) => {
    const latest = db.getLatestBehaviorPrompt(body.participantId);
    if (!latest) throw new Error("no behavior prompt to confirm");
    db.updateBehaviorPromptCheck({
      participantId: body.participantId,
      revision: latest.revision,
      matchRating: body.matchRating,
      correctionNote: body.correctionNote,
    });
    if (typeof body.timeOnScreenMs === "number") {
      db.insertParticipantResponses(body.participantId, "manipulation_check", [
        { key: "_time_on_screen_ms", valueInt: body.timeOnScreenMs },
      ]);
    }
  });
  sendJson(res, 200, { ok: true });
}

async function handleParticipantRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ participantId: string }>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;

  // Daily LLM-spend kill switch. Refuses new negotiations if today's
  // estimated cost exceeds AI2AI_DAILY_BUDGET_USD. Resets at midnight UTC.
  const budgetCap = Number(process.env["AI2AI_DAILY_BUDGET_USD"] ?? 0);
  if (budgetCap > 0) {
    const spent = withDb((db) => spendUsdToday(db));
    if (spent >= budgetCap) {
      sendJson(res, 503, {
        error: "budget_exceeded",
        message: `Daily LLM budget reached ($${spent.toFixed(2)} / $${budgetCap.toFixed(2)}). Try again tomorrow or contact the researcher.`,
      });
      return;
    }
  }

  // Pull the participant's role + latest prompt from the DB.
  const participant = withDb((db) => db.getStudyParticipant(body.participantId));
  if (!participant) {
    sendJson(res, 404, { error: "unknown participantId" });
    return;
  }
  if (!participant.role) {
    sendJson(res, 400, { error: "set role first" });
    return;
  }
  const promptRow = withDb((db) => db.getLatestBehaviorPrompt(body.participantId));
  if (!promptRow) {
    sendJson(res, 400, { error: "no behavior prompt submitted yet" });
    return;
  }
  const role = participant.role as Role;

  // Fetch the participant's saved personal-context text (from screen 5).
  const personalContext = withDb((db) => db.getParticipantContextText(body.participantId));

  const intake: IntakeAnswers = {
    ...STUDY_STIMULUS,
    userRole: role,
    userPersonalContext: personalContext,
    userBehaviorPrompt: promptRow.prompt_text,
  };

  // Pick the opponent's personality once per session — uniform over the three
  // pre-written profiles (easygoing | moderate | tough). The pack is persisted
  // to sessions.scenario_pack_json so we can always recover what the
  // participant faced. We also write a participant_responses row keyed
  // 'opponent_personality' for easier admin querying.
  const opponentPersonality = pickOpponentPersonality();
  withDb((db) => {
    db.insertParticipantResponses(body.participantId, "engine", [
      { key: "opponent_personality", valueText: opponentPersonality },
    ]);
  });

  const pack = buildPack({
    answers: intake,
    opponentPersonality,
    scenarioId: SCENARIO_ID,
  });
  const outPath = path.resolve(`scenarios/${SCENARIO_ID}/pack.json`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(pack, null, 2));

  // SSE response.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  send("status", { message: "Negotiation starting…" });
  send("opponent_personality", {
    role: role === "buyer" ? "seller" : "buyer",
    personality: opponentPersonality,
  });

  const persistence = openPersistence();
  try {
    const result = await runSession({
      pack,
      persistence,
      verbose: false,
      onEvent: (event) => {
        if (aborted) return;
        if (event.type === "session_start") {
          // Link engine session to this participant.
          persistence.updateStudyParticipant(body.participantId, { session_id: event.sessionId });
          send("session_start", { sessionId: event.sessionId, orchestratorModel: event.orchestratorModel });
        } else if (event.type === "turn_starting") {
          send("turn_starting", { participantId: event.participantId, turnNumber: event.turnNumber });
        } else if (event.type === "participant_turn") {
          const t = event.turn;
          send("turn", {
            turnNumber: t.turnNumber,
            emitterId: t.emitterId,
            message: t.message ?? null,
            toolCalls: t.toolCalls,
          });
        } else if (event.type === "session_end") {
          send("session_end", {
            outcome: event.outcome,
            degraded: event.degraded,
            consumed: event.consumed,
          });
        } else if (event.type === "fallback_triggered") {
          send("fallback", { reason: event.reason });
        }
      },
      orchestratorLLM: pack.orchestrator ?? {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 4000,
        apiKeyEnv: "ORCHESTRATOR_ANTHROPIC_API_KEY",
      },
    });
    send("done", {
      sessionId: result.sessionId,
      outcome: result.outcome,
      consumed: result.consumed,
      degraded: result.degraded,
    });
  } catch (err) {
    console.error("[server] /api/p/run error:", err);
    send("error", { message: (err as Error).message });
  } finally {
    persistence.close();
    res.end();
  }
}

interface FinishBody {
  participantId: string;
  responses: Record<string, number | string>;
  freeText?: string;
  timeOnScreenMs?: number;
}
async function handleParticipantFinish(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<FinishBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, body.responses && typeof body.responses === "object", "responses required")) return;

  const completionCode = `AI2AI-${nanoid(8).toUpperCase()}`;
  withDb((db) => {
    const items = Object.entries(body.responses).map(([key, value]) => {
      if (typeof value === "number") return { key, valueInt: value };
      return { key, valueText: String(value) };
    });
    if (body.freeText) {
      items.push({ key: "free_text", valueText: body.freeText });
    }
    if (typeof body.timeOnScreenMs === "number") {
      items.push({ key: "_time_on_screen_ms", valueInt: body.timeOnScreenMs });
    }
    db.insertParticipantResponses(body.participantId, "post_survey", items);
    db.updateStudyParticipant(body.participantId, {
      finished_at: new Date().toISOString(),
      completion_code: completionCode,
    });
  });
  sendJson(res, 200, { ok: true, completionCode });
}

// ─── Behavioral telemetry ────────────────────────────────────────────────

interface EventBatchBody {
  participantId: string;
  events: Array<{ ts: string; screen?: number; type: string; payload?: unknown }>;
}
async function handleParticipantEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<EventBatchBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, Array.isArray(body.events), "events must be an array")) return;
  // Hard cap on batch size to prevent abuse.
  const events = body.events.slice(0, 200);
  const inserted = withDb((db) => db.insertParticipantEvents(body.participantId, events));
  sendJson(res, 200, { ok: true, inserted });
}

// ─── GDPR endpoints ──────────────────────────────────────────────────────

async function handleParticipantExport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get("id");
  if (!id) {
    sendJson(res, 400, { error: "id query parameter required" });
    return;
  }
  // Right-to-access requires either a matching participantId in the request
  // OR admin auth. We accept either to keep the endpoint usable both for
  // researcher exports and for participants asking for their own data.
  const adminOk = checkAdminAuth(req);
  // Allow self-service (no auth required) — the participantId itself is the
  // unguessable secret (12-char nanoid). Admin auth is just a convenience for
  // the dashboard's "download" button.
  const data = withDb((db) => db.exportParticipant(id));
  if (!data) {
    sendJson(res, 404, { error: "unknown participantId" });
    return;
  }
  void adminOk;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="participant-${id}.json"`,
  });
  res.end(JSON.stringify(data, null, 2));
}

async function handleParticipantErase(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  // Erase is destructive — admin auth required.
  if (!requireAdmin(req, res)) return;
  const id = url.searchParams.get("id");
  if (!id) {
    sendJson(res, 400, { error: "id query parameter required" });
    return;
  }
  const result = withDb((db) => db.eraseParticipant(id));
  sendJson(res, 200, { ok: true, ...result });
}

// ─── Admin auth ──────────────────────────────────────────────────────────

function checkAdminAuth(req: http.IncomingMessage): boolean {
  const expected = process.env["AI2AI_ADMIN_PASSWORD"];
  if (!expected) return false;
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    const pass = decoded.slice(colon + 1);
    return pass === expected;
  } catch {
    return false;
  }
}

function requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const expected = process.env["AI2AI_ADMIN_PASSWORD"];
  if (!expected) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Admin disabled. Set AI2AI_ADMIN_PASSWORD on the server to enable /admin.");
    return false;
  }
  if (!checkAdminAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="AI2AI Admin"',
      "Content-Type": "text/plain",
    });
    res.end("Authentication required");
    return false;
  }
  return true;
}

// ─── Admin pages ─────────────────────────────────────────────────────────

async function handleAdminPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const html = await readFile(path.join(WEB_ROOT, "admin.html"), "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleAdminData(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => ({
    counts: db.countStudyParticipants(),
    spend: db.totalSpend(),
    funnel: db.funnelByScreen(),
    participants: db.listParticipantsForAdmin(200),
  }));
  // Rough cost estimate using Sonnet 4.6 pricing: $3/M input, $15/M output.
  // We don't break input/output here — use an average $9/M token midpoint.
  const estUsd = (data.spend.tokens_total / 1_000_000) * 9;
  sendJson(res, 200, { ...data, estUsd: Number(estUsd.toFixed(2)) });
}

async function handleAdminParticipantDetail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pid: string,
): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => db.exportParticipant(pid));
  if (!data) {
    sendJson(res, 404, { error: "unknown participantId" });
    return;
  }
  sendJson(res, 200, data);
}
