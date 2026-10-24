/** @jest-environment node */

import {
  computeFullJitterDelayMs,
  inferProviderFromModel,
  isRetryableLlmError,
  LLM_RETRY,
  runWithLlmCapacityRetry,
  shouldUsePriorityTier,
} from "@/utils/server/llmCapacityRetry";

function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function capacityError(message = "The model is currently at capacity due to high demand"): Error {
  return Object.assign(new Error(message), { code: "resource-exhausted", type: "server_error" });
}

describe("llmCapacityRetry policy", () => {
  test("fixed-seed jitter delays stay within bounds", () => {
    const random = createSeededRandom(42);
    const first = computeFullJitterDelayMs(0, random);
    const second = computeFullJitterDelayMs(1, random);
    const third = computeFullJitterDelayMs(2, random);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(500);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThanOrEqual(1000);
    expect(third).toBeGreaterThanOrEqual(0);
    expect(third).toBeLessThanOrEqual(2000);
    expect(third).toBeLessThanOrEqual(LLM_RETRY.capDelayMs);
  });

  test("does not retry auth or quota errors", () => {
    expect(isRetryableLlmError(new Error('400 "Incorrect API key provided."'), 0)).toBe(false);
    expect(
      isRetryableLlmError(new Error("Your team 9bd216ec-d39a-4422-81a3-5a0f430a2d56 used all available credits"), 0)
    ).toBe(false);
    expect(isRetryableLlmError(new Error("429 rate_limit exceeded"), 0)).toBe(false);
    expect(isRetryableLlmError(capacityError(), 0)).toBe(true);
  });

  test("does not retry after tokens have streamed", () => {
    expect(isRetryableLlmError(capacityError(), 12)).toBe(false);
  });

  test("uses priority only on the last Grok attempt", () => {
    expect(shouldUsePriorityTier("grok-4.5", 1, 3)).toBe(false);
    expect(shouldUsePriorityTier("grok-4.5", 2, 3)).toBe(false);
    expect(shouldUsePriorityTier("grok-4.5", 3, 3)).toBe(true);
    expect(shouldUsePriorityTier("gpt-4o", 3, 3)).toBe(false);
  });

  test("infers xAI from Grok model ids", () => {
    expect(inferProviderFromModel("grok-4.5")).toBe("xAI (Grok)");
  });
});

describe("runWithLlmCapacityRetry", () => {
  test("retries capacity errors then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await runWithLlmCapacityRetry({
      model: "grok-4.5",
      siteId: "ananda",
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      getTokensStreamed: () => 0,
      execute: async () => {
        calls += 1;
        if (calls < 3) {
          throw capacityError();
        }
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  test("does not retry after tokens stream", async () => {
    let calls = 0;
    await expect(
      runWithLlmCapacityRetry({
        model: "grok-4.5",
        sleep: async () => undefined,
        getTokensStreamed: () => (calls === 0 ? 0 : 8),
        execute: async () => {
          calls += 1;
          throw capacityError();
        },
      })
    ).rejects.toThrow(/at capacity/);
    expect(calls).toBe(1);
  });

  test("does not retry auth errors", async () => {
    let calls = 0;
    await expect(
      runWithLlmCapacityRetry({
        model: "grok-4.5",
        sleep: async () => undefined,
        getTokensStreamed: () => 0,
        execute: async () => {
          calls += 1;
          throw new Error('400 "Incorrect API key provided."');
        },
      })
    ).rejects.toThrow(/Incorrect API key/);
    expect(calls).toBe(1);
  });

  test("enforces the total retry budget", async () => {
    let calls = 0;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runWithLlmCapacityRetry({
        model: "grok-4.5",
        budgetMs: 100,
        random: () => 1,
        sleep: async () => undefined,
        getTokensStreamed: () => 0,
        execute: async () => {
          calls += 1;
          throw capacityError();
        },
      })
    ).rejects.toThrow(/at capacity/);
    expect(calls).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("llm_capacity_final"));
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("sends priority only on the last attempt", async () => {
    const tiers: boolean[] = [];
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runWithLlmCapacityRetry({
        model: "grok-4.5",
        random: () => 0,
        sleep: async () => undefined,
        getTokensStreamed: () => 0,
        execute: async ({ attempt, usePriorityTier }) => {
          tiers[attempt - 1] = usePriorityTier;
          throw capacityError();
        },
      })
    ).rejects.toThrow(/at capacity/);
    expect(tiers).toEqual([false, false, true]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("llm_capacity_retry"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("llm_capacity_final"));
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("stack"))).toBe(false);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
