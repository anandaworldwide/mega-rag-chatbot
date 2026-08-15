/**
 * TTFB split metrics for measuring chat latency experiments.
 * Logged as a single grep-friendly `[TTFB_METRICS]` JSON line per request.
 * In local dev, also appended to `tmp/ttfb-metrics.jsonl` (size-capped).
 */

import fs from "fs";
import path from "path";
import { resolveGrokReasoningEffort, isGrokModel } from "@/utils/server/llmProvider";

/** Rough token estimate used elsewhere in makechain (~4 chars/token). */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type TtfbSplitDurations = {
  geoIntentMs: number;
  promptLoadMs: number;
  rephraseMs: number;
  retrievalMs: number;
  /** Answer-model stream/invoke start → first visible answer token. */
  answerModelWaitMs: number;
  toolRounds: number;
  retrievalToolMs: number;
};

export type TtfbPromptSizeEstimates = {
  systemPromptTokens: number;
  contextTokens: number;
  historyTokens: number;
};

export type TtfbProviderUsage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type TtfbMetricsPayload = {
  experiment: string;
  model: string;
  reasoningEffort: string | null;
  ttfbMs: number;
  pineconeSetupMs: number;
  vectorStoreSetupMs: number;
  chainExecutionMs: number;
  llmThinkTimeMs: number;
  tokenDeliveryMs: number;
  geoIntentMs: number;
  promptLoadMs: number;
  rephraseMs: number;
  retrievalMs: number;
  answerModelWaitMs: number;
  toolRounds: number;
  retrievalToolMs: number;
  systemPromptTokens: number;
  contextTokens: number;
  historyTokens: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachePromptLayout: boolean;
  curbRetrievalTools: boolean;
};

export function resolveTtfbExperiment(): string {
  const raw = process.env.TTFB_EXPERIMENT?.trim();
  return raw && raw.length > 0 ? raw : "baseline";
}

/**
 * Cache-friendly prompt layout (stable system + variable human) is always on.
 * Rollback = code change if needed.
 */
export function isCachePromptLayoutEnabled(): boolean {
  return true;
}

/**
 * Stricter "answer first" retrieval-tool guidance is always on (tools still bind).
 * Rollback = code change if needed.
 */
export function isCurbRetrievalToolsEnabled(): boolean {
  return true;
}

/**
 * Strip per-request placeholders from the site template so the system message
 * stays stable for xAI prompt caching.
 */
export function stripVariablePromptPlaceholders(template: string): string {
  return template
    .replace(/# Context\s*\n+\{context\}\s*/gi, "")
    .replace(/# Chat History\s*\n+\{chat_history\}\s*/gi, "")
    .replace(/# Active Filters\s*\n+\{activeFiltersSummary\}\s*/gi, "")
    .replace(/Question:\s*\{question\}\s*\n?Helpful answer:\s*/gi, "")
    .replace(/\{context\}/g, "")
    .replace(/\{chat_history\}/g, "")
    .replace(/\{activeFiltersSummary\}/g, "")
    .replace(/\{question\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildVariableHumanMessage(params: {
  context: string;
  chatHistory: string;
  question: string;
  activeFiltersSummary: string;
}): string {
  const parts = [
    "# Active Filters",
    params.activeFiltersSummary || "(none)",
    "",
    "# Chat History",
    params.chatHistory || "(none)",
    "",
    "# Context",
    params.context || "(no retrieved sources)",
    "",
    `Question: ${params.question}`,
    "Helpful answer:",
  ];
  return parts.join("\n");
}

export function extractProviderUsage(message: unknown): TtfbProviderUsage {
  const empty: TtfbProviderUsage = {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  };
  if (!message || typeof message !== "object") {
    return empty;
  }

  const record = message as Record<string, unknown>;
  const usageMeta = (record.usage_metadata || {}) as Record<string, unknown>;
  const responseMeta = (record.response_metadata || {}) as Record<string, unknown>;
  const tokenUsage = (responseMeta.tokenUsage || responseMeta.usage || {}) as Record<string, unknown>;
  const promptDetails = (tokenUsage.prompt_tokens_details ||
    usageMeta.input_token_details ||
    {}) as Record<string, unknown>;
  const outputDetails = (tokenUsage.completion_tokens_details ||
    usageMeta.output_token_details ||
    {}) as Record<string, unknown>;

  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  return {
    promptTokens: num(usageMeta.input_tokens) || num(tokenUsage.promptTokens) || num(tokenUsage.prompt_tokens),
    cachedTokens:
      num(promptDetails.cached_tokens) ||
      num(promptDetails.cache_read) ||
      num(usageMeta.cache_read_input_tokens),
    completionTokens:
      num(usageMeta.output_tokens) || num(tokenUsage.completionTokens) || num(tokenUsage.completion_tokens),
    reasoningTokens: num(outputDetails.reasoning_tokens) || num(usageMeta.reasoning_tokens),
  };
}

/** Write provider usage onto the chat timing bag (final answer turn, not the tool-call turn). */
export function applyProviderUsageToTimingMetrics(
  timingMetrics: Record<string, unknown> | null | undefined,
  message: unknown
): void {
  if (!timingMetrics) return;
  const usage = extractProviderUsage(message);
  timingMetrics.promptTokens = usage.promptTokens;
  timingMetrics.cachedTokens = usage.cachedTokens;
  timingMetrics.completionTokens = usage.completionTokens;
  timingMetrics.reasoningTokens = usage.reasoningTokens;
}

export function buildTtfbMetricsPayload(params: {
  model: string;
  ttfbMs: number;
  pineconeSetupMs: number;
  vectorStoreSetupMs: number;
  chainExecutionMs: number;
  llmThinkTimeMs: number;
  tokenDeliveryMs: number;
  splits: Partial<TtfbSplitDurations>;
  promptSizes: Partial<TtfbPromptSizeEstimates>;
  usage: Partial<TtfbProviderUsage>;
}): TtfbMetricsPayload {
  const reasoningEffort = isGrokModel(params.model) ? resolveGrokReasoningEffort() : null;
  return {
    experiment: resolveTtfbExperiment(),
    model: params.model,
    reasoningEffort,
    ttfbMs: params.ttfbMs,
    pineconeSetupMs: params.pineconeSetupMs,
    vectorStoreSetupMs: params.vectorStoreSetupMs,
    chainExecutionMs: params.chainExecutionMs,
    llmThinkTimeMs: params.llmThinkTimeMs,
    tokenDeliveryMs: params.tokenDeliveryMs,
    geoIntentMs: params.splits.geoIntentMs ?? 0,
    promptLoadMs: params.splits.promptLoadMs ?? 0,
    rephraseMs: params.splits.rephraseMs ?? 0,
    retrievalMs: params.splits.retrievalMs ?? 0,
    answerModelWaitMs: params.splits.answerModelWaitMs ?? 0,
    toolRounds: params.splits.toolRounds ?? 0,
    retrievalToolMs: params.splits.retrievalToolMs ?? 0,
    systemPromptTokens: params.promptSizes.systemPromptTokens ?? 0,
    contextTokens: params.promptSizes.contextTokens ?? 0,
    historyTokens: params.promptSizes.historyTokens ?? 0,
    promptTokens: params.usage.promptTokens ?? 0,
    cachedTokens: params.usage.cachedTokens ?? 0,
    completionTokens: params.usage.completionTokens ?? 0,
    reasoningTokens: params.usage.reasoningTokens ?? 0,
    cachePromptLayout: isCachePromptLayoutEnabled(),
    curbRetrievalTools: isCurbRetrievalToolsEnabled(),
  };
}

export function logTtfbMetrics(payload: TtfbMetricsPayload): void {
  console.log(`[TTFB_METRICS] ${JSON.stringify(payload)}`);
  appendTtfbMetricsFile(payload);
}

const TTFB_METRICS_FILE_NAME = "ttfb-metrics.jsonl";
const TTFB_METRICS_MAX_BYTES = 1_000_000;
const TTFB_METRICS_KEEP_LINES = 500;

function shouldWriteTtfbMetricsFile(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.TTFB_METRICS_FILE === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/** Append one JSONL row; trim to last N lines when the file grows past the cap. */
export function appendTtfbMetricsFile(payload: TtfbMetricsPayload): void {
  if (!shouldWriteTtfbMetricsFile()) return;
  try {
    const dir = path.join(process.cwd(), "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, TTFB_METRICS_FILE_NAME);
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    const stats = fs.statSync(filePath);
    if (stats.size <= TTFB_METRICS_MAX_BYTES) return;
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(-TTFB_METRICS_KEEP_LINES);
    fs.writeFileSync(filePath, `${kept.join("\n")}\n`, "utf8");
  } catch {
    // Never break the request path for optional file logging.
  }
}
