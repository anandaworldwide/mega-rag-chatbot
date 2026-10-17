/** @jest-environment node */

import fs from "fs";
import os from "os";
import path from "path";
import {
  appendTtfbMetricsFile,
  buildTtfbMetricsPayload,
  buildVariableHumanMessage,
  estimatePromptTokens,
  extractProviderUsage,
  applyProviderUsageToTimingMetrics,
  isCachePromptLayoutEnabled,
  isCurbRetrievalToolsEnabled,
  isEvalQuestionRepeatEnabled,
  logTtfbMetrics,
  resolveTtfbExperiment,
  stripVariablePromptPlaceholders,
} from "@/utils/server/ttfbMetrics";
import { ModelPerformanceTracker } from "@/utils/server/modelPerformanceUtils";

describe("ttfbMetrics", () => {
  const originalExperiment = process.env.TTFB_EXPERIMENT;
  const originalMetricsFile = process.env.TTFB_METRICS_FILE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;
  const originalEvalQuestionRepeat = process.env.EVAL_QUESTION_REPEAT;

  afterEach(() => {
    process.env.TTFB_EXPERIMENT = originalExperiment;
    process.env.TTFB_METRICS_FILE = originalMetricsFile;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.VERCEL = originalVercel;
    if (originalEvalQuestionRepeat === undefined) {
      delete process.env.EVAL_QUESTION_REPEAT;
    } else {
      process.env.EVAL_QUESTION_REPEAT = originalEvalQuestionRepeat;
    }
  });

  test("estimatePromptTokens uses ~4 chars per token", () => {
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcdefgh")).toBe(2);
  });

  test("resolveTtfbExperiment defaults to baseline", () => {
    delete process.env.TTFB_EXPERIMENT;
    expect(resolveTtfbExperiment()).toBe("baseline");
    process.env.TTFB_EXPERIMENT = "cache-layout";
    expect(resolveTtfbExperiment()).toBe("cache-layout");
  });

  test("cache layout and retrieval curb are always on in code", () => {
    expect(isCachePromptLayoutEnabled()).toBe(true);
    expect(isCurbRetrievalToolsEnabled()).toBe(true);
  });

  test("stripVariablePromptPlaceholders removes per-request slots", () => {
    const stripped = stripVariablePromptPlaceholders(
      "Rules here.\n\n# Context\n\n{context}\n\n# Chat History\n\n{chat_history}\n\nQuestion: {question}\nHelpful answer:\n"
    );
    expect(stripped).toContain("Rules here.");
    expect(stripped).not.toContain("{context}");
    expect(stripped).not.toContain("{question}");
  });

  const defaultHumanMessageParams = {
    context: "doc text",
    chatHistory: "Human: hi",
    question: "What is karma?",
    activeFiltersSummary: "Whole library",
  };

  const DEFAULT_HUMAN_MESSAGE_GOLDEN = [
    "# Active Filters",
    "Whole library",
    "",
    "# Chat History",
    "Human: hi",
    "",
    "# Context",
    "doc text",
    "",
    "Question: What is karma?",
    "Helpful answer:",
  ].join("\n");

  test("buildVariableHumanMessage puts context once after filters/history", () => {
    delete process.env.EVAL_QUESTION_REPEAT;
    process.env.NODE_ENV = "test";
    const human = buildVariableHumanMessage(defaultHumanMessageParams);
    expect(human.indexOf("# Active Filters")).toBeLessThan(human.indexOf("# Context"));
    expect(human).toContain("doc text");
    expect(human).toContain("Question: What is karma?");
  });

  test("default human prompt is byte-identical when eval question repeat is off", () => {
    process.env.NODE_ENV = "test";
    delete process.env.EVAL_QUESTION_REPEAT;
    const unsetSwitch = buildVariableHumanMessage(defaultHumanMessageParams);
    process.env.EVAL_QUESTION_REPEAT = "0";
    const zeroSwitch = buildVariableHumanMessage(defaultHumanMessageParams);
    process.env.EVAL_QUESTION_REPEAT = "";
    const emptySwitch = buildVariableHumanMessage(defaultHumanMessageParams);

    expect(unsetSwitch).toBe(DEFAULT_HUMAN_MESSAGE_GOLDEN);
    expect(zeroSwitch).toBe(DEFAULT_HUMAN_MESSAGE_GOLDEN);
    expect(emptySwitch).toBe(DEFAULT_HUMAN_MESSAGE_GOLDEN);
    expect(Buffer.from(unsetSwitch, "utf8").equals(Buffer.from(DEFAULT_HUMAN_MESSAGE_GOLDEN, "utf8"))).toBe(
      true
    );
    expect(unsetSwitch).not.toContain("Question (repeated):");
    expect(isEvalQuestionRepeatEnabled()).toBe(false);
  });

  test("eval question repeat stays off in production even when the env var is set", () => {
    process.env.NODE_ENV = "production";
    process.env.EVAL_QUESTION_REPEAT = "1";
    const human = buildVariableHumanMessage(defaultHumanMessageParams);
    expect(isEvalQuestionRepeatEnabled()).toBe(false);
    expect(human).toBe(DEFAULT_HUMAN_MESSAGE_GOLDEN);
    expect(Buffer.from(human, "utf8").equals(Buffer.from(DEFAULT_HUMAN_MESSAGE_GOLDEN, "utf8"))).toBe(true);
  });

  test("eval question repeat appends one extra line after the sources block", () => {
    process.env.NODE_ENV = "test";
    process.env.EVAL_QUESTION_REPEAT = "1";
    expect(isEvalQuestionRepeatEnabled()).toBe(true);
    const human = buildVariableHumanMessage(defaultHumanMessageParams);
    const expectedOn = [
      "# Active Filters",
      "Whole library",
      "",
      "# Chat History",
      "Human: hi",
      "",
      "# Context",
      "doc text",
      "",
      "Question (repeated): What is karma?",
      "",
      "Question: What is karma?",
      "Helpful answer:",
    ].join("\n");
    expect(human).toBe(expectedOn);
    expect(human.indexOf("# Context")).toBeLessThan(human.indexOf("Question (repeated):"));
    expect(human.indexOf("Question (repeated):")).toBeLessThan(human.indexOf("Question: What is karma?"));
    expect(human).not.toBe(DEFAULT_HUMAN_MESSAGE_GOLDEN);
  });

  test("extractProviderUsage reads LangChain usage_metadata", () => {
    const usage = extractProviderUsage({
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 50,
        input_token_details: { cache_read: 800 },
        output_token_details: { reasoning_tokens: 20 },
      },
    });
    expect(usage).toEqual({
      promptTokens: 1000,
      cachedTokens: 800,
      completionTokens: 50,
      reasoningTokens: 20,
    });
  });

  test("applyProviderUsageToTimingMetrics overwrites prior usage fields", () => {
    const timingMetrics: Record<string, unknown> = {
      promptTokens: 100,
      cachedTokens: 10,
      completionTokens: 5,
      reasoningTokens: 1,
    };
    applyProviderUsageToTimingMetrics(timingMetrics, {
      usage_metadata: {
        input_tokens: 22000,
        output_tokens: 400,
        input_token_details: { cache_read: 20000 },
        output_token_details: { reasoning_tokens: 40 },
      },
    });
    expect(timingMetrics).toMatchObject({
      promptTokens: 22000,
      cachedTokens: 20000,
      completionTokens: 400,
      reasoningTokens: 40,
    });
  });

  test("buildTtfbMetricsPayload includes splits and experiment", () => {
    process.env.TTFB_EXPERIMENT = "baseline";
    const payload = buildTtfbMetricsPayload({
      model: "grok-4.5",
      ttfbMs: 4200,
      pineconeSetupMs: 400,
      vectorStoreSetupMs: 10,
      chainExecutionMs: 3700,
      llmThinkTimeMs: 3600,
      tokenDeliveryMs: 100,
      splits: {
        geoIntentMs: 20,
        promptLoadMs: 30,
        rephraseMs: 0,
        retrievalMs: 200,
        answerModelWaitMs: 3300,
        toolRounds: 0,
        retrievalToolMs: 0,
      },
      promptSizes: {
        systemPromptTokens: 21000,
        contextTokens: 500,
        historyTokens: 0,
      },
      usage: {
        promptTokens: 22000,
        cachedTokens: 0,
        completionTokens: 40,
        reasoningTokens: 25,
      },
    });
    expect(payload.experiment).toBe("baseline");
    expect(payload.answerModelWaitMs).toBe(3300);
    expect(payload.systemPromptTokens).toBe(21000);
    expect(payload.cachePromptLayout).toBe(true);
    expect(payload.curbRetrievalTools).toBe(true);
  });

  test("appendTtfbMetricsFile writes JSONL in local development", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ttfb-metrics-"));
    const previousCwd = process.cwd();
    process.chdir(tmpRoot);
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL;
    delete process.env.TTFB_METRICS_FILE;

    try {
      const payload = buildTtfbMetricsPayload({
        model: "grok-4.5",
        ttfbMs: 100,
        pineconeSetupMs: 1,
        vectorStoreSetupMs: 1,
        chainExecutionMs: 90,
        llmThinkTimeMs: 80,
        tokenDeliveryMs: 10,
        splits: {},
        promptSizes: {},
        usage: {},
      });
      appendTtfbMetricsFile(payload);
      const filePath = path.join(tmpRoot, "tmp", "ttfb-metrics.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);
      const line = fs.readFileSync(filePath, "utf8").trim();
      expect(JSON.parse(line).ttfbMs).toBe(100);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("logTtfbMetrics skips file write when TTFB_METRICS_FILE=0", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ttfb-metrics-off-"));
    const previousCwd = process.cwd();
    process.chdir(tmpRoot);
    process.env.NODE_ENV = "development";
    process.env.TTFB_METRICS_FILE = "0";
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      logTtfbMetrics(
        buildTtfbMetricsPayload({
          model: "grok-4.5",
          ttfbMs: 50,
          pineconeSetupMs: 1,
          vectorStoreSetupMs: 1,
          chainExecutionMs: 40,
          llmThinkTimeMs: 30,
          tokenDeliveryMs: 10,
          splits: {},
          promptSizes: {},
          usage: {},
        })
      );
      expect(fs.existsSync(path.join(tmpRoot, "tmp", "ttfb-metrics.jsonl"))).toBe(false);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("ModelPerformanceTracker TTFB splits", () => {
  test("buildTimingBreakdown includes answerModelWait and prompt sizes", () => {
    const tracker = new ModelPerformanceTracker();
    const start = 1_000_000;
    const breakdown = tracker.buildTimingBreakdown({
      startTime: start,
      pineconeSetupComplete: start + 400,
      vectorStoreSetupComplete: start + 410,
      chainExecutionStart: start + 420,
      answerModelStart: start + 700,
      firstTokenGenerated: start + 5200,
      firstByteTime: start + 5200,
      geoIntentMs: 15,
      promptLoadMs: 25,
      rephraseMs: 0,
      retrievalMs: 180,
      answerModelWaitMs: 4500,
      systemPromptTokens: 21000,
      contextTokens: 1200,
      historyTokens: 0,
      toolRounds: 1,
      retrievalToolMs: 300,
      promptTokens: 23000,
      cachedTokens: 18000,
      completionTokens: 80,
      reasoningTokens: 30,
    });

    expect(breakdown.ttfb).toBe(5200);
    expect(breakdown.answerModelWaitMs).toBe(4500);
    expect(breakdown.geoIntentMs).toBe(15);
    expect(breakdown.retrievalMs).toBe(180);
    expect(breakdown.systemPromptTokens).toBe(21000);
    expect(breakdown.cachedTokens).toBe(18000);
    expect(breakdown.toolRounds).toBe(1);
  });
});
