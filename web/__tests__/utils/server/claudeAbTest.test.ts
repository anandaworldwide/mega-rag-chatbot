/** @jest-environment node */

const mockGet = jest.fn();
const mockIsDevelopment = jest.fn(() => false);

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: (...args: unknown[]) => mockGet(...args),
    })),
  },
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: () => mockIsDevelopment(),
  isProduction: () => !mockIsDevelopment(),
  getEnvName: () => (mockIsDevelopment() ? "dev" : "prod"),
}));

import {
  AB_TEST_FABLE_HOLDOUT_MODEL,
  AB_TEST_GROK_MODEL,
  isClaudeAbTestComparableAnswer,
  pickArmFromWeights,
  resolveAbTestArmWeights,
  resolveClaudeAbTestModel,
} from "@/utils/server/claudeAbTest";

describe("claudeAbTest", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mockGet.mockReset();
    mockIsDevelopment.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  test("returns null when experiment is disabled", async () => {
    await expect(resolveClaudeAbTestModel({ enabled: false, controlModel: "gpt-4o" })).resolves.toBeNull();
  });

  test("reuses sticky abTestModel from conversation history", async () => {
    mockGet.mockResolvedValue({
      docs: [{ data: () => ({ abTestModel: AB_TEST_GROK_MODEL }) }],
    });

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
      convId: "conv-123",
    });

    expect(result).toEqual({
      model: AB_TEST_GROK_MODEL,
      abTestModel: AB_TEST_GROK_MODEL,
    });
  });

  test("explicit weights with zero treatment assign control", async () => {
    process.env.AB_TEST_CONTROL_PERCENT = "100";
    process.env.AB_TEST_GROK_PERCENT = "0";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "0";
    delete process.env.AB_TEST_FORCE_MODEL;
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({ model: "gpt-4o", abTestModel: "gpt-4o" });
  });

  test("force model env overrides random assignment", async () => {
    process.env.AB_TEST_CONTROL_PERCENT = "100";
    process.env.AB_TEST_GROK_PERCENT = "0";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "0";
    process.env.AB_TEST_FORCE_MODEL = AB_TEST_GROK_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: AB_TEST_GROK_MODEL,
      abTestModel: AB_TEST_GROK_MODEL,
    });
  });

  test("pickArmFromWeights uses control → Grok → Fable band order", () => {
    const weights = { control: 62, grok: 30, fableHoldout: 8 };
    expect(pickArmFromWeights(weights, "gpt-4o", 10)).toBe("gpt-4o");
    expect(pickArmFromWeights(weights, "gpt-4o", 61.9)).toBe("gpt-4o");
    expect(pickArmFromWeights(weights, "gpt-4o", 62)).toBe(AB_TEST_GROK_MODEL);
    expect(pickArmFromWeights(weights, "gpt-4o", 91.9)).toBe(AB_TEST_GROK_MODEL);
    expect(pickArmFromWeights(weights, "gpt-4o", 92)).toBe(AB_TEST_FABLE_HOLDOUT_MODEL);
    expect(pickArmFromWeights(weights, "gpt-4o", 99.9)).toBe(AB_TEST_FABLE_HOLDOUT_MODEL);
  });

  test("assigns control when roll falls in control band", async () => {
    process.env.AB_TEST_CONTROL_PERCENT = "62";
    process.env.AB_TEST_GROK_PERCENT = "30";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "8";
    delete process.env.AB_TEST_FORCE_MODEL;
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;
    jest.spyOn(Math, "random").mockReturnValue(0.1); // roll = 10 → control [0, 62)

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: "gpt-4o",
      abTestModel: "gpt-4o",
    });
  });

  test("assigns Grok when roll falls in Grok weight band", async () => {
    process.env.AB_TEST_CONTROL_PERCENT = "62";
    process.env.AB_TEST_GROK_PERCENT = "30";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "8";
    delete process.env.AB_TEST_FORCE_MODEL;
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;
    jest.spyOn(Math, "random").mockReturnValue(0.7); // roll = 70 → Grok [62, 92)

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: AB_TEST_GROK_MODEL,
      abTestModel: AB_TEST_GROK_MODEL,
    });
  });

  test("assigns Fable holdout when roll falls in holdout band", async () => {
    process.env.AB_TEST_CONTROL_PERCENT = "62";
    process.env.AB_TEST_GROK_PERCENT = "30";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "8";
    delete process.env.AB_TEST_FORCE_MODEL;
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;
    jest.spyOn(Math, "random").mockReturnValue(0.95); // roll = 95 → holdout [92, 100)

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: AB_TEST_FABLE_HOLDOUT_MODEL,
      abTestModel: AB_TEST_FABLE_HOLDOUT_MODEL,
    });
  });

  test("legacy CLAUDE_AB_TEST_PERCENT is ignored; plan defaults apply", () => {
    delete process.env.AB_TEST_CONTROL_PERCENT;
    delete process.env.AB_TEST_GROK_PERCENT;
    delete process.env.AB_TEST_FABLE_HOLDOUT_PERCENT;
    process.env.CLAUDE_AB_TEST_PERCENT = "0";

    expect(resolveAbTestArmWeights()).toEqual({
      control: 62,
      grok: 30,
      fableHoldout: 8,
    });
  });

  test("default weights are 62/30/8 when no env set", () => {
    delete process.env.AB_TEST_CONTROL_PERCENT;
    delete process.env.AB_TEST_GROK_PERCENT;
    delete process.env.AB_TEST_FABLE_HOLDOUT_PERCENT;
    delete process.env.CLAUDE_AB_TEST_PERCENT;

    expect(resolveAbTestArmWeights()).toEqual({
      control: 62,
      grok: 30,
      fableHoldout: 8,
    });
  });

  test("partial AB_TEST_* treats unset siblings as 0 then normalizes", () => {
    delete process.env.AB_TEST_CONTROL_PERCENT;
    delete process.env.AB_TEST_FABLE_HOLDOUT_PERCENT;
    process.env.AB_TEST_GROK_PERCENT = "0";

    // Only GROK=0 → all arms 0 → safe fallback to 100% control
    expect(resolveAbTestArmWeights()).toEqual({
      control: 100,
      grok: 0,
      fableHoldout: 0,
    });
  });

  test("partial AB_TEST_GROK_PERCENT=30 alone normalizes to 100% Grok", () => {
    delete process.env.AB_TEST_CONTROL_PERCENT;
    delete process.env.AB_TEST_FABLE_HOLDOUT_PERCENT;
    process.env.AB_TEST_GROK_PERCENT = "30";

    expect(resolveAbTestArmWeights()).toEqual({
      control: 0,
      grok: 100,
      fableHoldout: 0,
    });
  });

  test("development always assigns Grok and ignores sticky history", async () => {
    mockIsDevelopment.mockReturnValue(true);
    mockGet.mockResolvedValue({
      docs: [{ data: () => ({ abTestModel: "gpt-4o" }) }],
    });
    delete process.env.AB_TEST_FORCE_MODEL;
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
      convId: "conv-old",
    });

    expect(result).toEqual({
      model: AB_TEST_GROK_MODEL,
      abTestModel: AB_TEST_GROK_MODEL,
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("development weights are 100% Grok", () => {
    mockIsDevelopment.mockReturnValue(true);
    process.env.AB_TEST_CONTROL_PERCENT = "62";
    process.env.AB_TEST_GROK_PERCENT = "30";
    process.env.AB_TEST_FABLE_HOLDOUT_PERCENT = "8";

    expect(resolveAbTestArmWeights()).toEqual({
      control: 0,
      grok: 100,
      fableHoldout: 0,
    });
  });

  test("development Grok wins even when force model is set", async () => {
    mockIsDevelopment.mockReturnValue(true);
    process.env.AB_TEST_FORCE_MODEL = AB_TEST_FABLE_HOLDOUT_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: AB_TEST_GROK_MODEL,
      abTestModel: AB_TEST_GROK_MODEL,
    });
  });

  describe("isClaudeAbTestComparableAnswer", () => {
    test("returns true when model matches sticky abTestModel", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: AB_TEST_GROK_MODEL,
          abTestModel: AB_TEST_GROK_MODEL,
        })
      ).toBe(true);
    });

    test("returns false for geo overrides where execution model differs from arm", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: "gpt-4.1-mini",
          abTestModel: AB_TEST_FABLE_HOLDOUT_MODEL,
          isLocationQuery: true,
        })
      ).toBe(false);
    });

    test("returns false when model and abTestModel differ even without geo flag", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: "gpt-4.1-mini",
          abTestModel: AB_TEST_GROK_MODEL,
        })
      ).toBe(false);
    });
  });
});
