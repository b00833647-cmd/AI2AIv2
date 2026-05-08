// LLM provider abstraction.
//
// Today: Anthropic only. The interface is provider-agnostic so OpenAI/etc. can
// slot in later by implementing the same shape.

import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig, ToolCall, ToolDefinition, TokenUsage } from "./types.ts";

export interface LLMRequest {
  /** Cached static system prompt — gets `cache_control: ephemeral`. */
  systemStatic?: string;
  /** Volatile system additions appended after the cache breakpoint. */
  systemDynamic?: string;
  /** User-turn content. For participants, this is the orchestrator-curated context. */
  userMessage: string;
  /**
   * Optional images attached to the user turn (e.g. listing photos).
   * Sent as image content blocks BEFORE the userMessage text. We tag the
   * last image with `cache_control: ephemeral` so the entire image set is
   * cached — every turn after the first gets the cache-read discount and
   * doesn't re-bill image tokens.
   */
  userImages?: Array<{ mediaType: string; data: string }>;
  /** Tools the model can call. May be empty. */
  tools: ToolDefinition[];
  /** If set, force the model to call exactly one of these tools. */
  toolChoice?: "auto" | "any" | "required" | { name: string };
}

export interface LLMResponse {
  /** All structured tool calls in the response, in order. */
  toolCalls: ToolCall[];
  /** Public natural-language text. */
  message?: string;
  /** Private reasoning, if surfaced. */
  thinking?: string;
  tokens: TokenUsage;
  latencyMs: number;
  model: string;
  /** Stop reason ('end_turn', 'tool_use', 'max_tokens', etc.). */
  stopReason: string | null;
  /** Model-version-specific fields the caller may want to forward. */
  raw: Anthropic.Message;
}

export interface LLMClient {
  call(req: LLMRequest): Promise<LLMResponse>;
  readonly model: string;
}

// ─── Anthropic implementation ──────────────────────────────────────────────

/**
 * Heuristic: is this model in the 4.6+/4.7 family (adaptive thinking only,
 * `budget_tokens` removed/deprecated)?
 */
function isAdaptiveOnly(model: string): boolean {
  return /claude-(opus-4-(6|7|8|9|10)|sonnet-4-(6|7|8|9|10)|haiku-4-(5|6|7|8|9|10))/.test(model);
}

/** Sampling parameters are removed on Opus 4.7 — sending them returns 400. */
function rejectsSamplingParams(model: string): boolean {
  return /claude-opus-4-(7|8|9|10)/.test(model);
}

function resolveApiKey(cfg: LLMConfig): string {
  const envKey = cfg.apiKeyEnv && process.env[cfg.apiKeyEnv];
  const fallback = process.env["ANTHROPIC_API_KEY"];
  const key = (envKey && envKey.length > 0 ? envKey : fallback) ?? "";
  if (!key) {
    const hint = cfg.apiKeyEnv ? `${cfg.apiKeyEnv} or ANTHROPIC_API_KEY` : "ANTHROPIC_API_KEY";
    throw new Error(`No Anthropic API key found. Set ${hint} in your environment.`);
  }
  return key;
}

/**
 * Build a multi-modal user-message content array: image blocks first, then
 * the text block. The LAST image gets `cache_control: ephemeral` so all
 * blocks up to and including it form a single cached prefix. The text after
 * is the volatile per-turn payload (transcript, broadcasts, instruction).
 */
function buildUserContentWithImages(
  images: Array<{ mediaType: string; data: string }>,
  text: string,
): Anthropic.ContentBlockParam[] {
  const lastIdx = images.length - 1;
  const blocks: Anthropic.ContentBlockParam[] = images.map((img, i) => {
    const block: Anthropic.ImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: img.mediaType as Anthropic.Base64ImageSource["media_type"], data: img.data },
    };
    if (i === lastIdx) (block as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
    return block;
  });
  blocks.push({ type: "text", text });
  return blocks;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export class AnthropicLLMClient implements LLMClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly cfg: LLMConfig;

  constructor(cfg: LLMConfig) {
    if (cfg.provider !== "anthropic") {
      throw new Error(`AnthropicLLMClient only supports provider='anthropic', got '${cfg.provider}'`);
    }
    this.cfg = cfg;
    this.model = cfg.model;
    this.client = new Anthropic({ apiKey: resolveApiKey(cfg) });
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const params = this.buildParams(req);
    const start = Date.now();
    const response = await this.client.messages.create(params);
    const latencyMs = Date.now() - start;

    const toolCalls: ToolCall[] = [];
    let message: string | undefined;
    let thinking: string | undefined;

    for (const block of response.content) {
      if (block.type === "text") {
        message = (message ?? "") + block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      } else if (block.type === "thinking") {
        if (block.thinking) thinking = (thinking ?? "") + block.thinking;
      }
    }

    const usage = response.usage;
    const tokens: TokenUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreate: usage.cache_creation_input_tokens ?? undefined,
      cacheRead: usage.cache_read_input_tokens ?? undefined,
    };

    return {
      toolCalls,
      message,
      thinking,
      tokens,
      latencyMs,
      model: response.model,
      stopReason: response.stop_reason,
      raw: response,
    };
  }

  private buildParams(req: LLMRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system = this.buildSystem(req);
    const tools = toAnthropicTools(req.tools);

    // Build the user content: either a plain string (no images) or an array
    // of image blocks followed by the text. The last image carries the cache
    // breakpoint so the entire image set is cached — first turn writes the
    // cache, every turn after reads it back at ~10% the cost.
    const userContent = (req.userImages && req.userImages.length > 0)
      ? buildUserContentWithImages(req.userImages, req.userMessage)
      : req.userMessage;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.cfg.maxTokens ?? 8000,
      system,
      messages: [{ role: "user", content: userContent }],
    };

    let forcesTool = false;
    if (tools.length > 0) {
      params.tools = tools;
      if (req.toolChoice) {
        params.tool_choice = this.buildToolChoice(req.toolChoice);
        forcesTool = req.toolChoice !== "auto";
      }
    }

    // The Anthropic API rejects `thinking` when `tool_choice` forces tool use
    // ("Thinking may not be enabled when tool_choice forces tool use"). Skip
    // thinking in that case rather than letting every call 400. Affects the
    // orchestrator (tool_choice='any') but not normal participants (auto).
    if (this.cfg.thinkingBudget && this.cfg.thinkingBudget > 0 && !forcesTool) {
      // Adaptive on modern models, enabled+budget on older ones. The skill
      // recommends adaptive everywhere it's supported — that's the default.
      if (isAdaptiveOnly(this.model)) {
        params.thinking = { type: "adaptive" };
      } else {
        params.thinking = { type: "enabled", budget_tokens: this.cfg.thinkingBudget };
      }
    }

    if (this.cfg.effort) {
      params.output_config = { effort: this.cfg.effort };
    }

    if (!rejectsSamplingParams(this.model) && typeof this.cfg.temperature === "number") {
      params.temperature = this.cfg.temperature;
    }

    return params;
  }

  private buildSystem(req: LLMRequest): Anthropic.MessageCreateParamsNonStreaming["system"] {
    const blocks: Anthropic.TextBlockParam[] = [];

    if (req.systemStatic) {
      // Cache the static prefix. Identical across all turns and (for the
      // orchestrator) all sessions of a deployment.
      blocks.push({
        type: "text",
        text: req.systemStatic,
        cache_control: { type: "ephemeral" },
      });
    }

    if (req.systemDynamic) {
      blocks.push({ type: "text", text: req.systemDynamic });
    }

    if (blocks.length === 0) return undefined;
    return blocks;
  }

  private buildToolChoice(
    choice: NonNullable<LLMRequest["toolChoice"]>,
  ): Anthropic.ToolChoice {
    if (choice === "auto") return { type: "auto" };
    if (choice === "any" || choice === "required") return { type: "any" };
    return { type: "tool", name: choice.name };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createLLMClient(cfg: LLMConfig): LLMClient {
  if (cfg.provider === "anthropic") return new AnthropicLLMClient(cfg);
  throw new Error(`Unsupported LLM provider: ${cfg.provider}`);
}
