/** @jest-environment node */

const mockGet = jest.fn();

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

import {
  CLAUDE_AB_TEST_TREATMENT_MODEL,
  isClaudeAbTestComparableAnswer,
  resolveClaudeAbTestModel,
} from "@/utils/server/claudeAbTest";

describe("claudeAbTest", () => {
  const originalPercent = process.env.CLAUDE_AB_TEST_PERCENT;
  const originalForce = process.env.CLAUDE_AB_TEST_FORCE_MODEL;

  afterEach(() => {
    process.env.CLAUDE_AB_TEST_PERCENT = originalPercent;
    process.env.CLAUDE_AB_TEST_FORCE_MODEL = originalForce;
    mockGet.mockReset();
    jest.restoreAllMocks();
  });

  test("returns null when experiment is disabled", async () => {
    await expect(
      resolveClaudeAbTestModel({ enabled: false, controlModel: "gpt-4o" })
    ).resolves.toBeNull();
  });

  test("reuses sticky abTestModel from conversation history", async () => {
    mockGet.mockResolvedValue({
      docs: [{ data: () => ({ abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL }) }],
    });

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
      convId: "conv-123",
    });

    expect(result).toEqual({
      model: CLAUDE_AB_TEST_TREATMENT_MODEL,
      abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
    });
  });

  test("percent 0 always assigns control model for new conversations", async () => {
    process.env.CLAUDE_AB_TEST_PERCENT = "0";
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({ model: "gpt-4o", abTestModel: "gpt-4o" });
  });

  test("force model env overrides random assignment", async () => {
    process.env.CLAUDE_AB_TEST_PERCENT = "0";
    process.env.CLAUDE_AB_TEST_FORCE_MODEL = CLAUDE_AB_TEST_TREATMENT_MODEL;

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: CLAUDE_AB_TEST_TREATMENT_MODEL,
      abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
    });
  });

  test("assigns treatment when random roll is below percent", async () => {
    process.env.CLAUDE_AB_TEST_PERCENT = "30";
    delete process.env.CLAUDE_AB_TEST_FORCE_MODEL;
    jest.spyOn(Math, "random").mockReturnValue(0.1); // 10 < 30

    const result = await resolveClaudeAbTestModel({
      enabled: true,
      controlModel: "gpt-4o",
    });

    expect(result).toEqual({
      model: CLAUDE_AB_TEST_TREATMENT_MODEL,
      abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
    });
  });

  describe("isClaudeAbTestComparableAnswer", () => {
    test("returns true when model matches sticky abTestModel", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: CLAUDE_AB_TEST_TREATMENT_MODEL,
          abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
        })
      ).toBe(true);
    });

    test("returns false for geo overrides where execution model differs from arm", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: "gpt-4.1-mini",
          abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
          isLocationQuery: true,
        })
      ).toBe(false);
    });

    test("returns false when model and abTestModel differ even without geo flag", () => {
      expect(
        isClaudeAbTestComparableAnswer({
          model: "gpt-4.1-mini",
          abTestModel: CLAUDE_AB_TEST_TREATMENT_MODEL,
        })
      ).toBe(false);
    });
  });
});
