/**
 * Retry policy for LLM capacity, network, and 5xx failures.
 * Does not retry auth or quota errors. Does not retry after tokens stream.
 */

import {
  getLlmProviderErrorFields,
  isLlmProviderAuthError,
  isLlmProviderCapacityError,
  isLlmProviderHttpServerError,
  isLlmProviderQuotaError,
  isLlmProviderRateLimitError,
} from "@/utils/server/errorSanitization";
import { isGrokModel } from "@/utils/server/llmProvider";
import { isNetworkError } from "@/utils/server/networkErrorUtils";
import type { Document } from "@langchain/core/documents";

export const LLM_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  capDelayMs: 4000,
  budgetMs: 8000,
} as const;

export type LlmCapacityRetryLogEvent = "llm_capacity_retry" | "llm_capacity_final";

export type LlmCapacityRetryLogFields = {
  provider: string;
  model: string;
  attempt: number;
  delayMs: number;
  priorityTier: boolean;
  siteId?: string;
  errorCode?: string;
};

export type CachedRagContext = {
  restatedQuestion: string;
  documents: Document[];
};

export function computeFullJitterDelayMs(
  retryIndex: number,
  random: () => number = Math.random,
  baseDelayMs: number = LLM_RETRY.baseDelayMs,
  factor: number = LLM_RETRY.factor,
  capDelayMs: number = LLM_RETRY.capDelayMs
): number {
  const ceiling = Math.min(capDelayMs, baseDelayMs * factor ** retryIndex);
  return random() * ceiling;
}

export function isRetryableLlmError(error: unknown, tokensStreamed: number): boolean {
  if (tokensStreamed > 0) {
    return false;
  }
  if (isLlmProviderAuthError(error) || isLlmProviderQuotaError(error) || isLlmProviderRateLimitError(error)) {
    return false;
  }
  return isLlmProviderCapacityError(error) || isNetworkError(error) || isLlmProviderHttpServerError(error);
}

export function shouldUsePriorityTier(model: string, attempt: number, maxAttempts: number = LLM_RETRY.maxAttempts): boolean {
  return attempt === maxAttempts && isGrokModel(model);
}

export function extractLlmErrorCode(error: unknown): string | undefined {
  const fields = getLlmProviderErrorFields(error);
  return fields.code;
}

export function inferProviderFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.startsWith("grok")) {
    return "xAI (Grok)";
  }
  if (lower.startsWith("claude")) {
    return "Anthropic";
  }
  if (lower.includes("gpt") || lower.includes("openai")) {
    return "OpenAI";
  }
  return "LLM provider";
}

export function logLlmCapacityEvent(event: LlmCapacityRetryLogEvent, fields: LlmCapacityRetryLogFields): void {
  const line = JSON.stringify({
    event,
    provider: fields.provider,
    model: fields.model,
    attempt: fields.attempt,
    delayMs: fields.delayMs,
    priorityTier: fields.priorityTier,
    siteId: fields.siteId,
    errorCode: fields.errorCode,
  });
  if (event === "llm_capacity_final") {
    console.error(line);
    return;
  }
  console.warn(line);
}

export type RunWithLlmCapacityRetryOptions<T> = {
  execute: (ctx: { attempt: number; usePriorityTier: boolean }) => Promise<T>;
  getTokensStreamed: () => number;
  model: string;
  provider?: string;
  siteId?: string;
  maxAttempts?: number;
  budgetMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithLlmCapacityRetry<T>(options: RunWithLlmCapacityRetryOptions<T>): Promise<T> {
  const maxAttempts = options.maxAttempts ?? LLM_RETRY.maxAttempts;
  const budgetMs = options.budgetMs ?? LLM_RETRY.budgetMs;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const provider = options.provider ?? inferProviderFromModel(options.model);
  let spentDelayMs = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const usePriorityTier = shouldUsePriorityTier(options.model, attempt, maxAttempts);
    try {
      return await options.execute({ attempt, usePriorityTier });
    } catch (error) {
      lastError = error;
      const tokensStreamed = options.getTokensStreamed();
      const errorCode = extractLlmErrorCode(error);
      const canRetry = isRetryableLlmError(error, tokensStreamed);
      if (!canRetry) {
        throw error;
      }

      const retryIndex = attempt - 1;
      const delayMs = computeFullJitterDelayMs(retryIndex, random);
      const budgetAllows = spentDelayMs + delayMs <= budgetMs;
      const isLastAttempt = attempt >= maxAttempts;

      if (isLastAttempt || !budgetAllows) {
        logLlmCapacityEvent("llm_capacity_final", {
          provider,
          model: options.model,
          attempt,
          delayMs: 0,
          priorityTier: usePriorityTier,
          siteId: options.siteId,
          errorCode,
        });
        throw error;
      }

      logLlmCapacityEvent("llm_capacity_retry", {
        provider,
        model: options.model,
        attempt,
        delayMs,
        priorityTier: usePriorityTier,
        siteId: options.siteId,
        errorCode,
      });
      await sleep(delayMs);
      spentDelayMs += delayMs;
    }
  }

  throw lastError || new Error("LLM retry loop ended without a result");
}
