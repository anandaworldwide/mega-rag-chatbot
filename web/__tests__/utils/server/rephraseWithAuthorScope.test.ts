/** @jest-environment node */

import {
  getCondenseTemplateWithAuthorScope,
  invokeRephraseWithAuthorScope,
  parseRephraseWithAuthorScope,
} from "@/utils/server/rephraseWithAuthorScope";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const PLAIN_CONDENSE_TAIL = `<chat_history>
  {chat_history}
</chat_history>

Follow Up Input: {question}
Standalone question:`;

describe("rephraseWithAuthorScope", () => {
  it("builds a JSON-only condense template without the plain Standalone question tail", () => {
    const result = getCondenseTemplateWithAuthorScope(PLAIN_CONDENSE_TAIL);

    expect(result).not.toContain("Standalone question:");
    expect(result).toContain('"standalone_question"');
    expect(result).toContain('"author_scope"');
    expect(result).toContain("Respond ONLY with valid JSON");
  });

  it("does not duplicate the 'Follow Up Input: {question}' line", () => {
    const result = getCondenseTemplateWithAuthorScope(PLAIN_CONDENSE_TAIL);
    const occurrences = result.split("Follow Up Input: {question}").length - 1;

    expect(occurrences).toBe(1);
  });

  it("parses structured JSON output", () => {
    const result = parseRephraseWithAuthorScope(
      '{"standalone_question":"What did Asha teach about meditation?","author_scope":"broad"}',
      "fallback"
    );

    expect(result).toEqual({
      standaloneQuestion: "What did Asha teach about meditation?",
      authorScope: "broad",
    });
  });

  it("falls back to the original question when JSON parsing fails", () => {
    const result = parseRephraseWithAuthorScope('{"standalone_question": broken', "original follow-up");

    expect(result).toEqual({
      standaloneQuestion: "original follow-up",
      authorScope: "default",
    });
  });

  it("parses JSON wrapped in a ```json markdown fence", () => {
    const result = parseRephraseWithAuthorScope(
      '```json\n{"standalone_question":"What about her other books?","author_scope":"broad"}\n```',
      "fallback"
    );

    expect(result).toEqual({
      standaloneQuestion: "What about her other books?",
      authorScope: "broad",
    });
  });

  it("parses JSON wrapped in a bare ``` fence", () => {
    const result = parseRephraseWithAuthorScope(
      '```\n{"standalone_question":"What is Kriya?","author_scope":"default"}\n```',
      "fallback"
    );

    expect(result).toEqual({
      standaloneQuestion: "What is Kriya?",
      authorScope: "default",
    });
  });

  it("falls back to the original question for prose-only output", () => {
    const result = parseRephraseWithAuthorScope("What is meditation?", "original follow-up");

    expect(result).toEqual({
      standaloneQuestion: "original follow-up",
      authorScope: "default",
    });
  });

  it("does not corrupt prompt fill when values contain $ replacement patterns", async () => {
    let capturedPrompt = "";
    const model = {
      invoke: jest.fn().mockImplementation((prompt: string) => {
        capturedPrompt = prompt;
        return Promise.resolve({ content: '{"standalone_question":"ok","author_scope":"default"}' });
      }),
    } as unknown as BaseLanguageModel;

    const trickyQuestion = "What does $& and $1 and $` mean?";
    await invokeRephraseWithAuthorScope(
      model,
      { chat_history: "", question: trickyQuestion },
      "Follow Up Input: {question}\nStandalone question:",
      trickyQuestion
    );

    expect(capturedPrompt).toContain(trickyQuestion);
  });
});
