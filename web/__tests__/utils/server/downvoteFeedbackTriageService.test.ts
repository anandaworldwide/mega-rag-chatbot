/** @jest-environment node */

jest.mock("@/services/firebase", () => ({ db: null }));
jest.mock("openai", () => ({ OpenAI: jest.fn() }));

import { DownvoteFeedbackTriageService } from "@/utils/server/downvoteFeedbackTriageService";

const baseEvent = {
  question: "Where is the nearest center?",
  answer: "The center is downtown.",
  feedbackReason: "Technical Issue" as const,
  feedbackComment: "the map button is broken",
};

function makeClientReturning(content: string | null) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as any;
}

describe("DownvoteFeedbackTriageService.classifyEvent", () => {
  it("falls back to heuristic triage when no client is configured", async () => {
    const service = new DownvoteFeedbackTriageService(null);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageMethod).toBe("heuristic");
    expect(result.triageCategory).toBe("code_bug");
  });

  it("uses LLM result when client returns valid JSON", async () => {
    const client = makeClientReturning(
      JSON.stringify({
        triageCategory: "prompt_improvement",
        triageConfidence: 0.91,
        triageSummary: "Prompt needs work",
        recommendedAction: "Tune the prompt",
        taskCandidateKey: "Prompt Tuning",
      })
    );
    const service = new DownvoteFeedbackTriageService(client);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageMethod).toBe("llm");
    expect(result.triageCategory).toBe("prompt_improvement");
    expect(result.triageConfidence).toBe(0.91);
    expect(result.taskCandidateKey).toBe("prompt_tuning");
  });

  it("clamps out-of-range confidence and keeps fallback fields when invalid", async () => {
    const client = makeClientReturning(
      JSON.stringify({ triageCategory: "not_a_category", triageConfidence: 5 })
    );
    const service = new DownvoteFeedbackTriageService(client);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageConfidence).toBe(1);
    // Invalid category falls back to heuristic category
    expect(result.triageCategory).toBe("code_bug");
  });

  it("falls back when LLM returns unparseable content", async () => {
    const client = makeClientReturning("not json");
    const service = new DownvoteFeedbackTriageService(client);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageMethod).toBe("heuristic");
  });

  it("falls back when LLM returns empty content", async () => {
    const client = makeClientReturning(null);
    const service = new DownvoteFeedbackTriageService(client);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageMethod).toBe("heuristic");
  });

  it("falls back when the LLM call throws", async () => {
    const client = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error("boom")) } },
    } as any;
    const service = new DownvoteFeedbackTriageService(client);
    const result = await service.classifyEvent(baseEvent);
    expect(result.triageMethod).toBe("heuristic");
  });
});

describe("DownvoteFeedbackTriageService db-gated methods", () => {
  it("returns null from enrichFeedbackEvent when db is unavailable", async () => {
    const service = new DownvoteFeedbackTriageService(null);
    expect(await service.enrichFeedbackEvent("evt-1")).toBeNull();
  });

  it("returns 0 from enrichRecentHeuristicEvents when db is unavailable", async () => {
    const service = new DownvoteFeedbackTriageService(null);
    expect(await service.enrichRecentHeuristicEvents()).toBe(0);
  });
});
