import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export type ChatModelOptions = {
  model: string;
  temperature: number;
  streaming?: boolean;
  maxTokens?: number;
  /** Anthropic output effort (adaptive models). Lower = less thinking latency. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Sticky conversation id for xAI prompt-cache routing (`x-grok-conv-id`).
   * Prefer a real conversation id; fall back to siteId for first turns.
   */
  promptCacheKey?: string;
};

export type GrokReasoningEffort = "low" | "medium" | "high";

const XAI_API_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_GROK_REASONING_EFFORT: GrokReasoningEffort = "low";

/** Models that reject non-default temperature/top_p/top_k (Claude adaptive-only generation). */
const ANTHROPIC_NO_SAMPLING_PREFIXES = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-4-7",
  "claude-opus-4-8",
] as const;

export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().startsWith("claude");
}

export function isGrokModel(model: string): boolean {
  return model.toLowerCase().startsWith("grok");
}

export function anthropicSupportsSamplingTemperature(model: string): boolean {
  const normalized = model.toLowerCase();
  return !ANTHROPIC_NO_SAMPLING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function resolveGrokReasoningEffort(): GrokReasoningEffort {
  const raw = process.env.GROK_REASONING_EFFORT?.trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return DEFAULT_GROK_REASONING_EFFORT;
}

/**
 * Returns a LangChain chat model for OpenAI, Anthropic, or xAI (Grok) based on the model id.
 */
export function getChatModel(options: ChatModelOptions): BaseChatModel {
  const { model, temperature, streaming = false, maxTokens, effort, promptCacheKey } = options;

  if (isAnthropicModel(model)) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for Claude models but is not set");
    }

    const anthropicOptions: ConstructorParameters<typeof ChatAnthropic>[0] = {
      model,
      streaming,
      maxTokens: maxTokens ?? 4096,
      anthropicApiKey: apiKey,
    };

    // Fable/Mythos/Opus 4.7+ reject non-default temperature; omit so LangChain leaves it undefined.
    if (anthropicSupportsSamplingTemperature(model)) {
      anthropicOptions.temperature = temperature;
    }

    if (effort) {
      anthropicOptions.outputConfig = { effort };
    }

    return new ChatAnthropic(anthropicOptions);
  }

  if (isGrokModel(model)) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error("XAI_API_KEY is required for Grok models but is not set");
    }

    const reasoningEffort = resolveGrokReasoningEffort();
    const defaultHeaders =
      promptCacheKey && promptCacheKey.trim().length > 0
        ? { "x-grok-conv-id": promptCacheKey.trim() }
        : undefined;
    return new ChatOpenAI({
      model,
      temperature,
      streaming,
      apiKey,
      configuration: {
        baseURL: XAI_API_BASE_URL,
        ...(defaultHeaders ? { defaultHeaders } : {}),
      },
      // xAI Chat Completions accepts reasoning_effort for grok-4.5 (API default high; we use low for TTFB).
      modelKwargs: {
        reasoning_effort: reasoningEffort,
      },
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }

  return new ChatOpenAI({
    model,
    temperature,
    streaming,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
}
