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
};

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

export function anthropicSupportsSamplingTemperature(model: string): boolean {
  const normalized = model.toLowerCase();
  return !ANTHROPIC_NO_SAMPLING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Returns a LangChain chat model for OpenAI or Anthropic based on the model id.
 */
export function getChatModel(options: ChatModelOptions): BaseChatModel {
  const { model, temperature, streaming = false, maxTokens, effort } = options;

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

  return new ChatOpenAI({
    model,
    temperature,
    streaming,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
}
