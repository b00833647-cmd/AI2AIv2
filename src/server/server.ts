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
import zlib from "node:zlib";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { runSession } from "../multi-agent/session-runner.ts";
import { extractOffer } from "../multi-agent/offer-extractor.ts";
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

    // Public study URLs:
    //   /blx → buyer condition (SPA reads the path and skips role pick)
    //   /slx → seller condition (same)
    //   /   → 302 redirect to /blx (default for anyone who hits the bare
    //         domain; researchers should distribute /blx and /slx directly)
    //   /study, /study.html → kept as backward-compat aliases
    if (
      req.method === "GET" &&
      (url.pathname === "/blx" ||
        url.pathname === "/slx" ||
        url.pathname === "/bhx" ||
        url.pathname === "/shx" ||
        url.pathname === "/study" ||
        url.pathname === "/study.html")
    ) {
      const html = await readFile(path.join(WEB_ROOT, "study.html"), "utf-8");
      // No-cache so design/copy/CSS changes pushed to Railway show up
      // immediately on the next page load, no hard-refresh needed.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: "/blx" });
      res.end();
      return;
    }

    // Operator-facing dev demo (legacy single-page form). Kept for QA.
    if (req.method === "GET" && (url.pathname === "/dev" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(WEB_ROOT, "index.html"), "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
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
    if (req.method === "POST" && url.pathname === "/api/p/turn") {
      await handleParticipantHumanTurn(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/p/mode") {
      await handleParticipantMode(req, res);
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
    if (
      req.method === "GET" &&
      (url.pathname === "/admin" ||
        url.pathname === "/admin/" ||
        url.pathname === "/adx" ||
        url.pathname === "/adx/")
    ) {
      await handleAdminPage(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/admin/data" || url.pathname === "/adx/data")) {
      await handleAdminData(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/diagnostics" || url.pathname === "/admin/diagnostics")) {
      await handleAdminDiagnostics(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/admin/p/")) {
      const pid = url.pathname.slice("/admin/p/".length);
      await handleAdminParticipantDetail(req, res, pid);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/adx/p/")) {
      const pid = url.pathname.slice("/adx/p/".length);
      await handleAdminParticipantDetail(req, res, pid);
      return;
    }

    // ─── Admin extensions: aggregates / exports / quality / replay / ops ──
    if (req.method === "GET" && (url.pathname === "/adx/aggregates" || url.pathname === "/admin/aggregates")) {
      await handleAdminAggregates(req, res);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/adx/exclude" || url.pathname === "/admin/exclude")) {
      await handleAdminExclude(req, res);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/adx/test-data" || url.pathname === "/admin/test-data")) {
      await handleAdminTestData(req, res);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/adx/delete" || url.pathname === "/admin/delete")) {
      await handleAdminDelete(req, res, url);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/backup" || url.pathname === "/admin/backup")) {
      await handleAdminBackup(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/adx/replay/")) {
      const sid = url.pathname.slice("/adx/replay/".length);
      await handleAdminReplay(req, res, sid);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/export/participants.xlsx" || url.pathname === "/admin/export/participants.xlsx")) {
      await handleAdminExportParticipantsXlsx(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/export/full.xlsx" || url.pathname === "/admin/export/full.xlsx")) {
      await handleAdminExportFullXlsx(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/export/participants.csv" || url.pathname === "/admin/export/participants.csv")) {
      await handleAdminExportParticipantsCsv(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/export/all.json" || url.pathname === "/admin/export/all.json")) {
      await handleAdminExportAllJson(req, res);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/adx/export/transcripts.zip" || url.pathname === "/admin/export/transcripts.zip")) {
      await handleAdminExportTranscriptsZip(req, res);
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

// ─── API-key diagnostics ───────────────────────────────────────────────
//
// Stored at module scope so they're queryable at runtime via
// /adx/diagnostics (admin-auth gated) and /health (anonymized).
// Compares FULL key values to detect duplicate-paste mistakes — last-4
// alone could collide on rare matches, but identical full strings is
// definitive: same key → same Anthropic workspace.
interface KeyDiagnostics {
  mode: "3-key" | "1-key" | "mixed";
  distinctKeyCount: number;     // how many UNIQUE key values are in use across the 3 roles
  buyer:        { source: "specific" | "shared"; fingerprint: string };
  seller:       { source: "specific" | "shared"; fingerprint: string };
  orchestrator: { source: "specific" | "shared"; fingerprint: string };
  duplicateKeys: boolean;        // true if any two roles use the same key
}
let __keyDiag: KeyDiagnostics | null = null;
function getKeyDiagnostics(): KeyDiagnostics | null { return __keyDiag; }

// Boot-time env validation. Exits if no Anthropic key is reachable; warns
// (but proceeds) if optional protections aren't configured. In multi-key
// mode, also reports which key each role resolved to (first-8 + last-4
// fingerprint only — never logs the full secret) so misconfigurations
// are visible at a glance.
function validateBootEnv(): void {
  const shared = process.env["ANTHROPIC_API_KEY"];
  const buyerKey  = process.env["BUYER_ANTHROPIC_API_KEY"];
  const sellerKey = process.env["SELLER_ANTHROPIC_API_KEY"];
  const orchKey   = process.env["ORCHESTRATOR_ANTHROPIC_API_KEY"];
  const haveAny = Boolean(shared || (buyerKey && sellerKey && orchKey));
  if (!haveAny) {
    console.error("[boot] ✗ No Anthropic API key configured.");
    console.error("[boot]   Set ANTHROPIC_API_KEY (single-key mode) OR all three of");
    console.error("[boot]   BUYER_ANTHROPIC_API_KEY / SELLER_ANTHROPIC_API_KEY / ORCHESTRATOR_ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  // Resolve what each role will actually use at runtime, mirroring
  // resolveApiKey() in llm.ts. Then report the configuration clearly.
  // Fingerprint = first 8 chars + last 4 chars, separated by an ellipsis.
  // Two keys with identical fingerprints are almost certainly the same key
  // (the real check below uses full-string equality for definitive proof).
  const fp = (k: string | undefined): string => {
    if (!k) return "(none)";
    if (k.length < 16) return "(short)";
    return `${k.slice(0, 8)}…${k.slice(-4)}`;
  };
  const sourceFor = (specific: string | undefined): "specific" | "shared" => {
    return (specific && specific.length > 0) ? "specific" : "shared";
  };
  const resolveFor = (specific: string | undefined): string => {
    return (specific && specific.length > 0) ? specific : (shared || "");
  };
  const buyerResolved  = resolveFor(buyerKey);
  const sellerResolved = resolveFor(sellerKey);
  const orchResolved   = resolveFor(orchKey);
  const buyerSrc  = sourceFor(buyerKey);
  const sellerSrc = sourceFor(sellerKey);
  const orchSrc   = sourceFor(orchKey);
  const allSpecific = buyerSrc === "specific" && sellerSrc === "specific" && orchSrc === "specific";
  const allShared   = buyerSrc === "shared"   && sellerSrc === "shared"   && orchSrc === "shared";

  // Definitive uniqueness — compare FULL key strings, not just fingerprints.
  const distinctKeys = new Set([buyerResolved, sellerResolved, orchResolved].filter(Boolean));
  const distinctKeyCount = distinctKeys.size;
  const duplicateKeys = distinctKeyCount < 3;

  __keyDiag = {
    mode: allSpecific ? "3-key" : allShared ? "1-key" : "mixed",
    distinctKeyCount,
    buyer:        { source: buyerSrc,  fingerprint: fp(buyerResolved) },
    seller:       { source: sellerSrc, fingerprint: fp(sellerResolved) },
    orchestrator: { source: orchSrc,   fingerprint: fp(orchResolved) },
    duplicateKeys,
  };

  if (allSpecific) {
    if (!duplicateKeys) {
      console.log("[boot] ✓ API keys: 3-key mode — all 3 keys are DISTINCT");
      console.log(`[boot]   buyer        → BUYER_ANTHROPIC_API_KEY        ${fp(buyerKey)}`);
      console.log(`[boot]   seller       → SELLER_ANTHROPIC_API_KEY       ${fp(sellerKey)}`);
      console.log(`[boot]   orchestrator → ORCHESTRATOR_ANTHROPIC_API_KEY ${fp(orchKey)}`);
      console.log("[boot]   Each role's traffic will be attributed to its own Anthropic workspace.");
    } else {
      // Hard-stop visual: bracketed banner, error level, explicit fix steps.
      console.error("");
      console.error("[boot] ╔════════════════════════════════════════════════════════════════════╗");
      console.error("[boot] ║                                                                    ║");
      console.error("[boot] ║   ✗ API KEY MISCONFIGURATION — WORKSPACE ISOLATION IS NOT ACTIVE   ║");
      console.error("[boot] ║                                                                    ║");
      console.error("[boot] ╚════════════════════════════════════════════════════════════════════╝");
      console.error("");
      console.error("[boot] All three per-role env vars are SET, but only");
      console.error(`[boot]   ${distinctKeyCount} distinct key value(s) are present across them.`);
      console.error("[boot] ");
      console.error(`[boot]   buyer        → BUYER_ANTHROPIC_API_KEY        ${fp(buyerKey)}`);
      console.error(`[boot]   seller       → SELLER_ANTHROPIC_API_KEY       ${fp(sellerKey)}`);
      console.error(`[boot]   orchestrator → ORCHESTRATOR_ANTHROPIC_API_KEY ${fp(orchKey)}`);
      console.error("[boot] ");
      console.error("[boot] All API traffic will hit the SAME Anthropic workspace, defeating the");
      console.error("[boot] point of the 3-workspace setup. Your Anthropic console will show");
      console.error("[boot] all usage attributed to a single workspace.");
      console.error("[boot] ");
      console.error("[boot] To fix:");
      console.error("[boot]   1. console.anthropic.com → top-left workspace switcher → 'Create workspace'");
      console.error("[boot]   2. Create THREE workspaces: 'AI2AI–Buyer', 'AI2AI–Seller', 'AI2AI–Orchestrator'");
      console.error("[boot]   3. In EACH workspace, generate a NEW API key (Settings → API Keys)");
      console.error("[boot]      — keys are unique per-workspace, so 3 different workspaces = 3 different keys");
      console.error("[boot]   4. In Railway → Variables, paste each NEW key into its matching env var:");
      console.error("[boot]        BUYER_ANTHROPIC_API_KEY        = key from AI2AI–Buyer workspace");
      console.error("[boot]        SELLER_ANTHROPIC_API_KEY       = key from AI2AI–Seller workspace");
      console.error("[boot]        ORCHESTRATOR_ANTHROPIC_API_KEY = key from AI2AI–Orchestrator workspace");
      console.error("[boot]   5. Redeploy. The boot log should then say 'all 3 keys are DISTINCT'.");
      console.error("[boot] ");
      console.error("[boot] Server is starting anyway with these duplicate keys (so the platform stays");
      console.error("[boot] functional), but you do NOT have rate-limit or spending isolation right now.");
      console.error("");
    }
  } else if (allShared) {
    console.log("[boot] API keys: 1-key shared mode");
    console.log(`[boot]   ANTHROPIC_API_KEY ${fp(shared)} (used by buyer / seller / orchestrator)`);
    console.log("[boot]   To upgrade to per-role isolation, set the three BUYER_/SELLER_/ORCHESTRATOR_ vars.");
  } else {
    // Mixed setup — some per-role keys present, others falling back to shared.
    // Common during a partial migration to 3-key mode. Warn but don't fail.
    console.warn("[boot] ⚠ Mixed API key configuration detected:");
    console.warn(`[boot]   buyer        → ${buyerSrc === "specific" ? `BUYER_ANTHROPIC_API_KEY ${fp(buyerKey)}` : `(falling back to shared) ${fp(shared)}`}`);
    console.warn(`[boot]   seller       → ${sellerSrc === "specific" ? `SELLER_ANTHROPIC_API_KEY ${fp(sellerKey)}` : `(falling back to shared) ${fp(shared)}`}`);
    console.warn(`[boot]   orchestrator → ${orchSrc === "specific" ? `ORCHESTRATOR_ANTHROPIC_API_KEY ${fp(orchKey)}` : `(falling back to shared) ${fp(shared)}`}`);
    console.warn("[boot]   For full 3-workspace isolation, set ALL three of");
    console.warn("[boot]   BUYER_ANTHROPIC_API_KEY / SELLER_ANTHROPIC_API_KEY / ORCHESTRATOR_ANTHROPIC_API_KEY.");
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
  console.log(`[boot]   buyer study  → /blx`);
  console.log(`[boot]   seller study → /slx`);
  console.log(`[boot]   admin panel  → /adx (or /admin)`);
  console.log(`[boot]   dev demo     → /dev`);
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

// ─── Pending human-turn registry ─────────────────────────────────────────
//
// Keyed by participantId (one active session per participant). When the
// engine asks for a human turn, it stores a resolver here and waits. When
// the SPA POSTs /api/p/turn with the human's action, we look up the
// resolver and fulfil it. The engine then records the turn and resumes.
import type { HumanTurnResponse } from "../multi-agent/session-runner.ts";
import type { ToolCall as EngineToolCall } from "../multi-agent/types.ts";

interface PendingHumanTurn {
  participantId: string;
  startedAt: number;
  resolve: (r: HumanTurnResponse) => void;
  reject: (err: Error) => void;
}
const pendingHumanTurns = new Map<string, PendingHumanTurn>();

// Soft per-participant throttle: at least 1.5s between accepted human turns.
// Prevents script-driven spam from breaking the engine's rhythm.
const lastTurnAcceptedAt = new Map<string, number>();
const HUMAN_TURN_MIN_INTERVAL_MS = 1500;
const HUMAN_TURN_MAX_MESSAGE_CHARS = 1500;

/**
 * Per-session offer-board state. The orchestrator-side server tracks each
 * party's most recent offer here as turns arrive and emits an `offer_update`
 * SSE event downstream so the SPA's ticker is a passive renderer of
 * authoritative server state — not a client-side regex extractor.
 */
interface OfferBoard { buyer: number | null; seller: number | null; }

/**
 * Inspect a freshly-arrived Turn and return the price it represents, if any.
 *
 * STRICT POLICY: only authoritative submit_proposal toolCalls count. Numbers
 * mentioned conversationally in send_message text — quoting the listing,
 * referencing a previous offer, citing market data, hypothesising aloud —
 * MUST NOT update the offer board. The board reflects "what is on the
 * counter right now", not every dollar figure in the chat.
 *
 * Both sides have proper paths to surface a counter as a submit_proposal:
 *   - AI agents are bound by the HARD RULE in their system prompts —
 *     any number representing their own move goes through submit_proposal.
 *   - Human participants in /bhx and /shx — the client's intent detector
 *     converts "$22,500" / "I can do 22500" into action=propose, and the
 *     server constructs the corresponding submit_proposal toolCall before
 *     the Turn lands here.
 *
 * If neither path produced a submit_proposal, the agent or human did NOT
 * formally counter — and the board correctly does not change.
 */
function extractTurnPrice(t: { toolCalls?: EngineToolCall[]; message?: string }): number | null {
  const proposal = (t.toolCalls || []).find((c) => c.name === "submit_proposal");
  const input = proposal?.input as {
    action?: "propose" | "counter" | "accept" | "reject";
    issues?: Array<{ name: string; value: number }>;
  } | undefined;
  if (!input || !Array.isArray(input.issues)) return null;

  // CRITICAL — action gate: only `propose`, `counter`, and `accept` carry the
  // SPEAKER'S OWN number in the price field. A `reject` action's price field
  // identifies WHICH offer is being rejected (i.e. the OTHER side's last
  // number) and must NOT update the rejecter's board.
  //
  // Real bug this guard addresses (session nF1LHvnuG95lW-SepDUAG, /blx,
  // 2026-05-13): buyer rejected the seller's $23,800 with
  //   { action: "reject", issues: [{ name: "price", value: 23800 }] }
  // and the buyer board showed $23,800 instead of the buyer's actual last
  // offer of $23,500 (made two turns earlier).
  //
  // For `accept`, we DO want the price to update the speaker's board — they
  // are converging to the other side's number, and the board correctly
  // reflects "what they've committed to right now".
  if (input.action === "reject") return null;

  const priceIssue = input.issues.find((i) => i.name === "price");
  if (!priceIssue || !Number.isFinite(priceIssue.value)) return null;
  return Number(priceIssue.value);
}

/**
 * Update the per-session offer board from a Turn and return whether the
 * board changed. Mutates `board` in-place and is safe to call on every
 * turn — the caller decides whether to emit an SSE update.
 *
 * Optional `overridePrice` lets a downstream extractor (the offer-extractor
 * LLM) supply a price for turns whose toolCalls don't carry submit_proposal.
 * The extractor's price is treated as an authoritative second opinion.
 */
function updateOfferBoardFromTurn(
  board: OfferBoard,
  t: { emitterId: string; toolCalls?: EngineToolCall[]; message?: string },
  overridePrice?: number | null,
): { changed: boolean; source: "buyer" | "seller" | null } {
  const price = overridePrice != null ? overridePrice : extractTurnPrice(t);
  if (price == null) return { changed: false, source: null };
  if (t.emitterId === "buyer" && board.buyer !== price) {
    board.buyer = price;
    return { changed: true, source: "buyer" };
  }
  if (t.emitterId === "seller" && board.seller !== price) {
    board.seller = price;
    return { changed: true, source: "seller" };
  }
  return { changed: false, source: null };
}

/**
 * Server-side mirror of the SPA's intent-detection regex. Returns the last
 * plausible price found in `text` (in USD), or null when none are present.
 *
 * Mirrors web/study.html `detectChatIntent` price logic exactly:
 *   - `$`-prefixed amounts are accepted at face value
 *   - Bare 4–6 digit numbers are accepted if they're outside year range
 *     (1900–2100), to avoid false positives like "2023 Camry"
 *   - Plausible range cap: $1,000–$100,000
 *   - When multiple prices appear, the last one wins (typically the
 *     speaker's own counter rather than a quote of the other side)
 */
function detectPriceInText(text: string): number | null {
  if (!text) return null;
  const re = /(\$\s*)?(\d{1,3}(?:,\d{3})+|\d{4,6})\b/g;
  const matches: Array<{ n: number; hadDollar: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hadDollar = !!m[1];
    const digits = m[2];
    if (!digits) continue;
    const n = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 5000 || n > 100000) continue;     // realistic used-car floor
    if (!hadDollar && n >= 1900 && n <= 2100) continue;             // skip year-like bare numbers
    matches.push({ n, hadDollar });
  }
  if (matches.length === 0) return null;
  // Prefer $-prefixed matches when present — disambiguates against bare
  // numbers that might be mileage ("$22,500 since the mileage is 32,000"
  // → pick 22500, not 32000). Falls through to bare numbers if no $ used.
  const dollared = matches.filter((x) => x.hadDollar);
  if (dollared.length > 0) return dollared[dollared.length - 1]!.n;
  return matches[matches.length - 1]!.n;
}

async function handleParticipantHumanTurn(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{
    participantId: string;
    action: "send_message" | "propose" | "counter" | "accept" | "reject";
    message: string;
    price?: number;
    isFinal?: boolean;
  }>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  if (!require400(res, typeof body.message === "string", "message required (may be empty)")) return;
  if (!require400(
    res,
    body.message.length <= HUMAN_TURN_MAX_MESSAGE_CHARS,
    `message must be ≤ ${HUMAN_TURN_MAX_MESSAGE_CHARS} characters`,
  )) return;
  const validActions = ["send_message", "propose", "counter", "accept", "reject"];
  if (!require400(res, validActions.includes(body.action), `action must be one of ${validActions.join(", ")}`)) return;

  // Throttle: reject submissions that come faster than the minimum interval.
  const last = lastTurnAcceptedAt.get(body.participantId) ?? 0;
  if (Date.now() - last < HUMAN_TURN_MIN_INTERVAL_MS) {
    sendJson(res, 429, {
      error: "too_fast",
      message: `Please slow down — turns are accepted at most every ${HUMAN_TURN_MIN_INTERVAL_MS}ms.`,
    });
    return;
  }

  const pending = pendingHumanTurns.get(body.participantId);
  if (!pending) {
    sendJson(res, 409, {
      error: "no_pending_turn",
      message:
        "No human turn is currently being awaited for this participant. The engine may not have requested your turn yet, or your turn already submitted.",
    });
    return;
  }
  pendingHumanTurns.delete(body.participantId);
  lastTurnAcceptedAt.set(body.participantId, Date.now());

  // ─── Safety-net price detection ───────────────────────────────────────
  // If the client posted action="send_message" but the message text clearly
  // contains a price ($-prefixed, or a bare 5-digit number outside year
  // range), upgrade the action to "propose" with that price. This makes the
  // offer board the authoritative record of every number put on the table,
  // regardless of whether the client-side intent detector caught it.
  let effectiveAction = body.action;
  let effectivePrice  = body.price;
  if (effectiveAction === "send_message") {
    const detected = detectPriceInText(body.message);
    if (detected != null) {
      effectiveAction = "propose";
      effectivePrice = detected;
    }
  }

  // Build the toolCalls payload to look identical to what an LLM would emit.
  const toolCalls: EngineToolCall[] = [];
  if (effectiveAction === "send_message") {
    toolCalls.push({
      name: "send_message",
      input: { message: body.message, intent: "other" },
    });
  } else {
    // proposal / counter / accept / reject
    if (effectiveAction !== "accept" && effectiveAction !== "reject") {
      if (typeof effectivePrice !== "number" || !Number.isFinite(effectivePrice) || effectivePrice <= 0) {
        sendJson(res, 400, { error: "price required for propose/counter" });
        // Re-register the pending turn so the human can retry.
        pendingHumanTurns.set(body.participantId, pending);
        return;
      }
    }
    toolCalls.push({
      name: "submit_proposal",
      input: {
        action: effectiveAction,
        issues: [
          {
            name: "price",
            value: typeof effectivePrice === "number" ? effectivePrice : 0,
            justification: body.message || "(no justification provided)",
          },
        ],
        message: body.message || "(no message)",
        is_final: body.isFinal === true,
      },
    });
  }

  pending.resolve({
    message: body.message,
    toolCalls,
    latencyMs: Date.now() - pending.startedAt,
  });
  sendJson(res, 200, { ok: true });
}

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
  // Same cutoff for the human-turn throttle — these entries are tiny but
  // there's no reason to keep them after a day of inactivity.
  for (const [k, ts] of lastTurnAcceptedAt) if (ts < cutoff) lastTurnAcceptedAt.delete(k);
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

  // SSE heartbeat — Railway / Cloudflare / etc. close idle long-lived
  // connections after ~30–60s of no traffic. A single Anthropic call
  // (vision + thinking) can occasionally exceed that, leaving the SPA
  // staring at "Error: network error". An SSE comment line (";:" prefix)
  // counts as activity but is ignored by browser EventSource clients.
  const heartbeat = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); }
    catch { /* socket closed; cleanup will fire below */ }
  }, 15_000);

  let aborted = false;
  req.on("close", () => {
    aborted = true;
    clearInterval(heartbeat);
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
    // Per-session offer board — server is the single authority on the
    // displayed buyer/seller numbers. We update it from every turn (using
    // submit_proposal first, then a text-detection fallback) and emit an
    // `offer_update` SSE event whenever it changes, so the SPA ticker is
    // a passive renderer of state rather than a client-side regex.
    const offerBoard: OfferBoard = { buyer: null, seller: null };
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
            // Two-stage offer tracking — see /api/p/run for full rationale.
            // 1. Authoritative: submit_proposal toolCall (instant).
            // 2. LLM extractor (background): for turns whose text contains
            //    an informal offer, the offer-extractor reads the message
            //    and reports the price. Updates the board out-of-band.
            const fastUpdate = updateOfferBoardFromTurn(offerBoard, t);
            if (fastUpdate.changed) {
              send("offer_update", {
                buyer: offerBoard.buyer,
                seller: offerBoard.seller,
                spread:
                  offerBoard.buyer != null && offerBoard.seller != null
                    ? Math.abs(offerBoard.buyer - offerBoard.seller)
                    : null,
                source: fastUpdate.source,
              });
            } else if (t.message && t.message.trim().length > 0) {
              extractOffer(t.message, t.emitterId).then((extracted) => {
                if (aborted) return;
                if (!extracted || !extracted.has_offer) return;
                if (extracted.confidence === "low") return;
                if (extracted.price == null || !Number.isFinite(extracted.price)) return;
                if (extracted.price < 5000 || extracted.price > 100_000) return;
                const llmUpdate = updateOfferBoardFromTurn(offerBoard, t, extracted.price);
                if (llmUpdate.changed) {
                  send("offer_update", {
                    buyer: offerBoard.buyer,
                    seller: offerBoard.seller,
                    spread:
                      offerBoard.buyer != null && offerBoard.seller != null
                        ? Math.abs(offerBoard.buyer - offerBoard.seller)
                        : null,
                    source: llmUpdate.source,
                  });
                }
              }).catch(() => { /* extractor logs its own errors */ });
            }
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
    clearInterval(heartbeat);
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
  // Market price is now a range, not a point estimate. The mid-point keeps
  // working as `marketPrice` for any code that needs a single number; the
  // low/high bounds are surfaced to participants and agents so anchoring
  // and concession pacing have wider room.
  marketPrice: 24000,
  marketPriceLow: 23000,
  marketPriceHigh: 26000,
  sellerListing: 25500,
  sellerMinimum: 22500,
  buyerTarget: 21500,
  buyerMax: 23500,
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

interface ModeBody {
  participantId: string;
  /** 'agent' | 'human_buyer' | 'human_seller' */
  mode: string;
}
async function handleParticipantMode(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<ModeBody>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  const allowed = ["agent", "human_buyer", "human_seller"];
  if (!require400(res, allowed.includes(body.mode), "mode must be agent | human_buyer | human_seller")) return;
  withDb((db) => db.updateStudyParticipant(body.participantId, { experiment_mode: body.mode }));
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
  const role = participant.role as Role;
  // experiment_mode tells us whether this is the original delegated flow
  // (mode='agent') or the new direct-chat flow (mode='human_buyer'/'human_seller').
  // When the SPA hits /bhx or /shx it POSTs /api/p/mode before /api/p/run,
  // so this column will be set before we get here.
  const mode = (participant as { experiment_mode?: string }).experiment_mode || "agent";
  const isHumanMode = mode === "human_buyer" || mode === "human_seller";
  const humanRole: Role | undefined = mode === "human_buyer"
    ? "buyer"
    : mode === "human_seller"
      ? "seller"
      : undefined;

  // For agent mode, we require a behavior prompt before running. Human mode
  // skips this — there's no AI on the participant's side to brief.
  let promptRow: ReturnType<SqlitePersistence["getLatestBehaviorPrompt"]> | undefined;
  if (!isHumanMode) {
    promptRow = withDb((db) => db.getLatestBehaviorPrompt(body.participantId));
    if (!promptRow) {
      sendJson(res, 400, { error: "no behavior prompt submitted yet" });
      return;
    }
  }

  // Personal context: in agent mode we keep it (screen 5); in human mode the
  // researcher chose to drop screen 5 entirely so this stays empty.
  const personalContext = isHumanMode
    ? ""
    : withDb((db) => db.getParticipantContextText(body.participantId));

  const intake: IntakeAnswers = {
    ...STUDY_STIMULUS,
    userRole: role,
    userPersonalContext: personalContext,
    userBehaviorPrompt: promptRow ? promptRow.prompt_text : "",
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
    humanRole,
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
  // SSE heartbeat — see /api/run handler for full rationale. Long Anthropic
  // calls (vision + thinking) can occasionally exceed proxy idle limits;
  // this comment-line ping keeps the stream alive between real events.
  const heartbeat = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); }
    catch { /* socket closed; cleanup will fire below */ }
  }, 15_000);
  let aborted = false;
  req.on("close", () => {
    aborted = true;
    clearInterval(heartbeat);
    // If the human was mid-turn when they disconnected, reject the pending
    // promise so the engine can declare a timeout outcome rather than hanging.
    const pending = pendingHumanTurns.get(body.participantId);
    if (pending) {
      pendingHumanTurns.delete(body.participantId);
      try { pending.reject(new Error("SSE client disconnected mid-turn")); } catch { /* ignore */ }
    }
  });

  send("status", { message: "Negotiation starting…" });
  send("opponent_personality", {
    role: role === "buyer" ? "seller" : "buyer",
    personality: opponentPersonality,
  });
  send("experiment_mode", { mode });

  const persistence = openPersistence();
  // Per-session offer board (orchestrator-tracked). The server is the single
  // authority on the displayed buyer/seller numbers — see updateOfferBoardFromTurn.
  const offerBoard: OfferBoard = { buyer: null, seller: null };
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
        } else if (event.type === "human_turn_required") {
          // Forward to the SPA so it can enable the chat input.
          send("human_turn_required", {
            participantId: event.participantId,
            turnNumber: event.turnNumber,
            instruction: event.instruction ?? null,
          });
        } else if (event.type === "participant_turn") {
          const t = event.turn;
          send("turn", {
            turnNumber: t.turnNumber,
            emitterId: t.emitterId,
            emitter: t.emitter,
            message: t.message ?? null,
            toolCalls: t.toolCalls,
          });
          // Orchestrator-side offer tracking — two-stage:
          //
          //  1. Authoritative path: if the turn has a `submit_proposal`
          //     toolCall, take that price immediately and broadcast.
          //  2. LLM-extractor path: if NO submit_proposal, hand the turn's
          //     message to the offer-extractor LLM (Sonnet, separate from
          //     the main orchestrator). It reads the message and decides
          //     whether the speaker put a price on the table that wasn't
          //     formalised — handles "How about 23K?", "25500 is over my
          //     budget — I can do 23", quote-vs-offer ambiguity, etc.
          //     If it returns has_offer with confidence high/medium, we
          //     update the board and broadcast.
          //
          // The extractor runs in the background — we DO NOT await it
          // before responding to the SSE consumer. Out-of-order updates
          // are fine; the board converges to the correct state.
          const fastUpdate = updateOfferBoardFromTurn(offerBoard, t);
          if (fastUpdate.changed) {
            send("offer_update", {
              buyer: offerBoard.buyer,
              seller: offerBoard.seller,
              spread:
                offerBoard.buyer != null && offerBoard.seller != null
                  ? Math.abs(offerBoard.buyer - offerBoard.seller)
                  : null,
              source: fastUpdate.source,
            });
          } else if (t.message && t.message.trim().length > 0) {
            // No formal proposal — ask the extractor LLM whether the
            // message text contained an informal offer.
            extractOffer(t.message, t.emitterId).then((extracted) => {
              if (aborted) return;
              if (!extracted || !extracted.has_offer) return;
              if (extracted.confidence === "low") return;
              if (extracted.price == null || !Number.isFinite(extracted.price)) return;
              if (extracted.price < 5000 || extracted.price > 100_000) return;
              const llmUpdate = updateOfferBoardFromTurn(offerBoard, t, extracted.price);
              if (llmUpdate.changed) {
                send("offer_update", {
                  buyer: offerBoard.buyer,
                  seller: offerBoard.seller,
                  spread:
                    offerBoard.buyer != null && offerBoard.seller != null
                      ? Math.abs(offerBoard.buyer - offerBoard.seller)
                      : null,
                  source: llmUpdate.source,
                });
              }
            }).catch(() => { /* extractor logs its own errors */ });
          }
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
      // Human-turn provider: when the engine requests a human turn, register
      // the resolver in pendingHumanTurns and wait. The SPA will POST
      // /api/p/turn which finds the pending entry and resolves it.
      humanTurnProvider: !isHumanMode
        ? undefined
        : ({ turnNumber, instruction, lastOpponentTurn }) => {
            return new Promise<HumanTurnResponse>((resolve, reject) => {
              // Drop any stale pending turn for this participant first.
              const stale = pendingHumanTurns.get(body.participantId);
              if (stale) {
                stale.reject(new Error("Superseded by a new turn request"));
                pendingHumanTurns.delete(body.participantId);
              }
              pendingHumanTurns.set(body.participantId, {
                participantId: body.participantId,
                startedAt: Date.now(),
                resolve,
                reject,
              });
              // If the SSE client disconnects while we're waiting, fail
              // the turn so the engine can declare an outcome (timeout).
              if (aborted) {
                pendingHumanTurns.delete(body.participantId);
                reject(new Error("Client aborted before submitting turn"));
              }
              // Touch turnNumber + instruction so they're not flagged unused
              // (they're already forwarded to the SPA via the SSE event above).
              void turnNumber;
              void instruction;
              void lastOpponentTurn;
            });
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
    clearInterval(heartbeat);
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
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
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

// ─── Diagnostics endpoint ──────────────────────────────────────────────
//
// Returns the runtime API-key configuration so the researcher can verify
// (without checking Railway logs) that all 3 per-role keys are distinct
// and per-workspace isolation is actually active. Admin-auth gated.
// Never returns the actual key values — only fingerprints (first-8 + last-4).
async function handleAdminDiagnostics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const diag = getKeyDiagnostics();
  sendJson(res, 200, {
    apiKeys: diag,
    bootedAt: __bootedAt,
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
  });
}
const __bootedAt = new Date().toISOString();

// ─── Admin extension handlers ────────────────────────────────────────────

async function handleAdminAggregates(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => ({
    byCondition: db.aggregateByCondition(),
    outcomes: db.outcomeDistribution(),
    prices: db.priceDistribution(),
    turns: db.turnCountDistribution(),
    survey: db.surveyAggregates(),
    spendByDay: db.spendByDay(14),
    costByPersonality: db.costByPersonality(),
  }));
  sendJson(res, 200, data);
}

async function handleAdminExclude(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await readJson<{ participantId: string; excluded: boolean }>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  withDb((db) => db.setExcluded(body.participantId, body.excluded === true));
  sendJson(res, 200, { ok: true });
}

async function handleAdminTestData(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await readJson<{ participantId: string; testData: boolean }>(req, res);
  if (body === null) return;
  if (!require400(res, typeof body.participantId === "string", "participantId required")) return;
  withDb((db) => db.setTestData(body.participantId, body.testData === true));
  sendJson(res, 200, { ok: true });
}

/**
 * IRREVERSIBLY delete one or more participants and all their cascading
 * data. Two calling conventions:
 *   - Single: POST /adx/delete?id=<participantId>  (no body)
 *   - Bulk:   POST /adx/delete  with body { ids: string[] }
 *
 * Returns { deleted: <number>, requested: <number> } so the caller can
 * tell whether all requested ids actually existed. No-op for unknown ids.
 *
 * Admin-auth gated. Once the transaction commits, the data is GONE —
 * no soft-delete, no recovery beyond restoring from a backup.
 */
async function handleAdminDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  if (!requireAdmin(req, res)) return;

  let ids: string[] = [];
  // Single-id query-string path.
  const queryId = url.searchParams.get("id");
  if (queryId) ids = [queryId];

  // Bulk JSON-body path. If the request has a content-type or body, parse
  // it; otherwise the query-string path took care of things.
  if (ids.length === 0) {
    const body = await readJson<{ ids?: unknown }>(req, res);
    if (body === null) return;
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      sendJson(res, 400, {
        error: "ids required",
        message: "Pass ?id=<participantId> for a single delete, or POST { ids: [...] } for bulk.",
      });
      return;
    }
    ids = body.ids.filter((x): x is string => typeof x === "string");
  }

  if (ids.length === 0) {
    sendJson(res, 400, { error: "no valid ids" });
    return;
  }
  // Hard cap to prevent runaway requests.
  if (ids.length > 500) {
    sendJson(res, 400, { error: "too many ids", message: "Max 500 participants per request." });
    return;
  }

  const deleted = withDb((db) => db.deleteParticipantsCascade(ids));
  sendJson(res, 200, { deleted, requested: ids.length });
}

async function handleAdminBackup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const bytes = withDb((db) => db.backupBytes());
  const fname = `ai2ai-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.db`;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fname}"`,
    "Content-Length": String(bytes.length),
  });
  res.end(bytes);
}

async function handleAdminReplay(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => db.replaySession(sessionId));
  if (!data) {
    sendJson(res, 404, { error: "unknown sessionId" });
    return;
  }
  sendJson(res, 200, data);
}

// ─── Export handlers ─────────────────────────────────────────────────────

/** Tiny CSV serializer that quotes any cell containing comma, newline, or quote. */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

async function handleAdminExportParticipantsXlsx(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const rows = withDb((db) => db.exportFlatParticipants());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI2AI";
  wb.created = new Date();
  const ws = wb.addWorksheet("Participants");
  if (rows.length === 0) {
    ws.addRow(["No data yet."]);
  } else {
    const headers = Object.keys(rows[0]!);
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(12, h.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D2230" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of rows) ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  const fname = `ai2ai-participants-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${fname}"`,
    "Content-Length": String(buf.byteLength),
  });
  res.end(Buffer.from(buf));
}

async function handleAdminExportFullXlsx(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => ({
    participants: db.exportFlatParticipants(),
    behaviorPrompts: db.exportAllBehaviorPrompts(),
    survey: db.exportAllSurvey(),
    agentLog: db.exportUnifiedAgentLog(),
    buyerSellerTurns: db.exportAllTurns(),
    orchestrator: db.exportAllDecisions(),
    briefings: db.exportAllAgentBriefings(),
    events: db.exportAllEvents(50_000),
    aggregates: db.aggregateByCondition(),
  }));
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI2AI";
  wb.created = new Date();
  const headerStyle = (ws: import("exceljs").Worksheet) => {
    if (ws.rowCount > 0) {
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D2230" } };
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
  };
  // Long-text columns get a bigger fixed width so 'thinking', 'message',
  // 'system_prompt' etc. are readable when the workbook is opened.
  const wideCols = new Set([
    "message", "thinking", "rationale", "instruction", "outcome_summary",
    "system_prompt", "brief_json", "tool_calls_json", "tool_input_json",
    "tokens_json", "behavior_prompt", "personal_context", "free_text",
    "message_or_instruction", "raw_json",
  ]);
  const addSheet = (name: string, rows: Array<Record<string, unknown>>) => {
    const ws = wb.addWorksheet(name);
    if (rows.length === 0) { ws.addRow(["(empty)"]); return; }
    const headers = Object.keys(rows[0]!);
    ws.columns = headers.map((h) => ({
      header: h,
      key: h,
      width: wideCols.has(h) ? 60 : Math.min(40, Math.max(12, h.length + 2)),
    }));
    for (const r of rows) ws.addRow(r);
    // Wrap text in long-text columns so multiline content is visible.
    for (const h of headers) {
      if (wideCols.has(h)) {
        ws.getColumn(h).alignment = { wrapText: true, vertical: "top" };
      }
    }
    headerStyle(ws);
  };
  addSheet("Participants", data.participants);
  addSheet("By Condition", data.aggregates as Array<Record<string, unknown>>);
  addSheet("Behavior Prompts", data.behaviorPrompts);
  addSheet("Survey", data.survey);
  // The unified Agent Log is the new headline sheet — chronological,
  // includes all 3 agents (buyer, seller, orchestrator), with timestamps.
  addSheet("Agent Log", data.agentLog);
  addSheet("Buyer+Seller Turns", data.buyerSellerTurns);
  addSheet("Orchestrator", data.orchestrator);
  addSheet("Agent Briefings", data.briefings);
  addSheet("Events", data.events);
  const buf = await wb.xlsx.writeBuffer();
  const fname = `ai2ai-full-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${fname}"`,
    "Content-Length": String(buf.byteLength),
  });
  res.end(Buffer.from(buf));
}

async function handleAdminExportParticipantsCsv(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const rows = withDb((db) => db.exportFlatParticipants());
  const csv = toCsv(rows);
  const fname = `ai2ai-participants-${new Date().toISOString().slice(0, 10)}.csv`;
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fname}"`,
  });
  res.end(csv);
}

async function handleAdminExportAllJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const data = withDb((db) => {
    const participants = db.listParticipantsForAdmin(10000);
    return {
      _exported_at: new Date().toISOString(),
      _participant_count: participants.length,
      participants: participants.map((p) => db.exportParticipant(p.id)),
      aggregates: {
        byCondition: db.aggregateByCondition(),
        outcomes: db.outcomeDistribution(),
        prices: db.priceDistribution(),
        turns: db.turnCountDistribution(),
        survey: db.surveyAggregates(),
        spendByDay: db.spendByDay(60),
        costByPersonality: db.costByPersonality(),
      },
    };
  });
  const fname = `ai2ai-full-${new Date().toISOString().slice(0, 10)}.json`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fname}"`,
  });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * ZIP bundle of per-session text transcripts for qualitative analysis.
 * Implemented without an external zip library — Node has zlib + deflateRaw,
 * which is enough to assemble a valid ZIP file. (Stored entries would also
 * work but DEFLATE keeps the file small.)
 */
async function handleAdminExportTranscriptsZip(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const transcripts = withDb((db) => {
    const participants = db.listParticipantsForAdmin(10000);
    const out: Array<{ name: string; content: string }> = [];
    for (const p of participants) {
      if (!p.session_id) continue;
      const text = db.buildTranscriptText(p.session_id);
      if (text) {
        const tag = `${p.role || "noroles"}-${p.id}`;
        out.push({ name: `${tag}.txt`, content: text });
      }
    }
    return out;
  });
  const zipBuffer = buildZip(transcripts);
  const fname = `ai2ai-transcripts-${new Date().toISOString().slice(0, 10)}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${fname}"`,
    "Content-Length": String(zipBuffer.length),
  });
  res.end(zipBuffer);
}

// Minimal ZIP writer (DEFLATE) — enough for plain UTF-8 text bundles.
// Implements local file headers + central directory + end-of-central-directory
// per the ZIP appnote spec. No external deps.
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const data = Buffer.from(entry.content, "utf-8");
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32Fallback(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);            // local file header signature
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(0, 6);                     // general purpose flags
    local.writeUInt16LE(8, 8);                     // compression method = DEFLATE
    local.writeUInt16LE(0, 10);                    // last mod time
    local.writeUInt16LE(0, 12);                    // last mod date
    local.writeUInt32LE(crc, 14);                  // CRC-32
    local.writeUInt32LE(compressed.length, 18);    // compressed size
    local.writeUInt32LE(data.length, 22);          // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);       // file name length
    local.writeUInt16LE(0, 28);                    // extra field length
    localParts.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);                  // version made by
    central.writeUInt16LE(20, 6);                  // version needed
    central.writeUInt16LE(0, 8);                   // flags
    central.writeUInt16LE(8, 10);                  // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);                  // extra
    central.writeUInt16LE(0, 32);                  // comment
    central.writeUInt16LE(0, 34);                  // disk
    central.writeUInt16LE(0, 36);                  // internal attrs
    central.writeUInt32LE(0, 38);                  // external attrs
    central.writeUInt32LE(offset, 42);             // relative offset of local header
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // disk where central starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);                       // comment length
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// CRC-32 fallback — older Node versions don't expose zlib.crc32.
function crc32Fallback(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}
