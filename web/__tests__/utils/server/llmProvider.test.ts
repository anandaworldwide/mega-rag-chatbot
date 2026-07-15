/** @jest-environment node */

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn().mockImplementation((opts) => ({ provider: "openai", opts })),
}));

jest.mock("@langchain/anthropic", () => ({
  ChatAnthropic: jest.fn().mockImplementation((opts) => ({ provider: "anthropic", opts })),
}));

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  anthropicSupportsSamplingTemperature,
  getChatModel,
  isAnthropicModel,
  isGrokModel,
  resolveGrokReasoningEffort,
} from "@/utils/server/llmProvider";

describe("llmProvider", () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalXaiKey = process.env.XAI_API_KEY;
  const originalGrokEffort = process.env.GROK_REASONING_EFFORT;

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    process.env.XAI_API_KEY = originalXaiKey;
    process.env.GROK_REASONING_EFFORT = originalGrokEffort;
    jest.clearAllMocks();
  });

  test("isAnthropicModel detects Claude model ids", () => {
    expect(isAnthropicModel("claude-fable-5")).toBe(true);
    expect(isAnthropicModel("Claude-Sonnet-5")).toBe(true);
    expect(isAnthropicModel("gpt-4o")).toBe(false);
    expect(isAnthropicModel("grok-4.5")).toBe(false);
  });

  test("isGrokModel detects Grok model ids", () => {
    expect(isGrokModel("grok-4.5")).toBe(true);
    expect(isGrokModel("Grok-Build")).toBe(true);
    expect(isGrokModel("gpt-4o")).toBe(false);
  });

  test("anthropicSupportsSamplingTemperature is false for Fable/Mythos/Opus 4.7+", () => {
    expect(anthropicSupportsSamplingTemperature("claude-fable-5")).toBe(false);
    expect(anthropicSupportsSamplingTemperature("claude-mythos-5")).toBe(false);
    expect(anthropicSupportsSamplingTemperature("claude-opus-4-8")).toBe(false);
    expect(anthropicSupportsSamplingTemperature("claude-sonnet-5")).toBe(true);
  });

  test("getChatModel returns ChatOpenAI for GPT models", () => {
    const model = getChatModel({ model: "gpt-4o", temperature: 0.4, streaming: true });
    expect(ChatOpenAI).toHaveBeenCalled();
    expect(model).toEqual(
      expect.objectContaining({
        provider: "openai",
        opts: expect.objectContaining({ model: "gpt-4o", temperature: 0.4, streaming: true }),
      })
    );
  });

  test("getChatModel routes Grok to xAI with low reasoning effort by default", () => {
    process.env.XAI_API_KEY = "xai-test-key";
    delete process.env.GROK_REASONING_EFFORT;
    getChatModel({ model: "grok-4.5", temperature: 0.3, streaming: true });
    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-4.5",
        temperature: 0.3,
        streaming: true,
        apiKey: "xai-test-key",
        configuration: { baseURL: "https://api.x.ai/v1" },
        modelKwargs: { reasoning_effort: "low" },
      })
    );
  });

  test("resolveGrokReasoningEffort respects GROK_REASONING_EFFORT env", () => {
    process.env.GROK_REASONING_EFFORT = "medium";
    expect(resolveGrokReasoningEffort()).toBe("medium");
  });

  test("getChatModel throws when Grok is requested without XAI_API_KEY", () => {
    delete process.env.XAI_API_KEY;
    expect(() => getChatModel({ model: "grok-4.5", temperature: 0.3 })).toThrow(/XAI_API_KEY is required/);
  });

  test("getChatModel omits temperature for Claude Fable 5", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    getChatModel({ model: "claude-fable-5", temperature: 0.4, streaming: true });
    expect(ChatAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-fable-5",
        streaming: true,
        anthropicApiKey: "sk-test-anthropic",
      })
    );
    const call = (ChatAnthropic as unknown as jest.Mock).mock.calls[0][0];
    expect(call.temperature).toBeUndefined();
  });

  test("getChatModel passes temperature for Claude models that still support sampling", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
    getChatModel({ model: "claude-sonnet-5", temperature: 0.4, streaming: true });
    expect(ChatAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5",
        temperature: 0.4,
        streaming: true,
      })
    );
  });

  test("getChatModel throws when Claude is requested without ANTHROPIC_API_KEY", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getChatModel({ model: "claude-fable-5", temperature: 0.4 })).toThrow(
      /ANTHROPIC_API_KEY is required/
    );
  });
});
