/** @jest-environment node */

import { aggregateVoteStats, parseVoteStatsLookbackDays } from "@/utils/server/voteStatsUtils";

describe("voteStatsUtils", () => {
  it("defaults lookback to 7 and accepts 30", () => {
    expect(parseVoteStatsLookbackDays(undefined)).toBe(7);
    expect(parseVoteStatsLookbackDays("7")).toBe(7);
    expect(parseVoteStatsLookbackDays("14")).toBe(7);
    expect(parseVoteStatsLookbackDays("30")).toBe(30);
    expect(parseVoteStatsLookbackDays(["30"])).toBe(30);
  });

  it("aggregates A/B arms and comparable vote rates", () => {
    const result = aggregateVoteStats([
      {
        id: "a1",
        question: "Control good",
        vote: 1,
        model: "gpt-4o",
        abTestModel: "gpt-4o",
        timestamp: "2026-07-12T00:00:00.000Z",
      },
      {
        id: "a2",
        question: "Treatment bad",
        vote: -1,
        model: "claude-fable-5",
        abTestModel: "claude-fable-5",
        feedbackReason: "Incorrect Information",
        feedbackComment: "Wrong cite",
        timestamp: "2026-07-11T00:00:00.000Z",
      },
      {
        id: "a3",
        question: "Geo override upvote",
        vote: 1,
        model: "gpt-4.1-mini",
        abTestModel: "claude-fable-5",
        isLocationQuery: true,
        timestamp: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "a4",
        question: "No arm",
        vote: 1,
        model: "gpt-4.1-mini",
        timestamp: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "a5",
        question: "Unvoted control",
        model: "gpt-4o",
        abTestModel: "gpt-4o",
        timestamp: "2026-07-08T00:00:00.000Z",
      },
    ]);

    expect(result.summary.answersInWindow).toBe(5);
    expect(result.summary.upvotes).toBe(3);
    expect(result.summary.downvotes).toBe(1);
    expect(result.summary.answersWithAbTestModel).toBe(4);
    expect(result.summary.comparableVotes).toBe(2);
    expect(result.summary.comparableUpvotes).toBe(1);
    expect(result.summary.comparableDownvotes).toBe(1);
    expect(result.summary.geoAnswers).toBe(1);

    const control = result.arms.find((arm) => arm.arm === "gpt-4o");
    const treatment = result.arms.find((arm) => arm.arm === "claude-fable-5");
    const noArm = result.arms.find((arm) => arm.arm === "(no abTestModel)");

    expect(control).toMatchObject({
      answers: 2,
      comparableAnswers: 2,
      upvotes: 1,
      downvotes: 0,
      comparableUpvotes: 1,
      comparableDownvotes: 0,
    });
    expect(treatment).toMatchObject({
      answers: 2,
      comparableAnswers: 1,
      upvotes: 1,
      downvotes: 1,
      comparableUpvotes: 0,
      comparableDownvotes: 1,
      geoOrOverrideVotes: 1,
    });
    expect(noArm).toMatchObject({ answers: 1, upvotes: 1, comparableAnswers: 0 });

    expect(result.recentVotes[0].id).toBe("a1");
    expect(result.modelCounts[0].model).toBe("gpt-4o");
  });

  it("includes downvote events created in-window", () => {
    const result = aggregateVoteStats([], [
      {
        id: "e1",
        answerDocId: "doc-1",
        question: "Old answer downvoted recently",
        feedbackReason: "Off-Topic Response",
        feedbackComment: "Not helpful",
        model: "gpt-4o",
        abTestModel: "gpt-4o",
        triageCategory: "prompt_improvement",
        triageStatus: "classified",
        createdAt: "2026-07-12T12:00:00.000Z",
      },
    ]);

    expect(result.summary.downvoteEventsInWindow).toBe(1);
    expect(result.recentDownvoteEvents).toHaveLength(1);
    expect(result.recentDownvoteEvents[0].reason).toBe("Off-Topic Response");
  });
});
