/** @jest-environment node */

import {
  detectLocationIntentAfterEnglishRestatement,
  extractModelText,
  hasNonAsciiLetter,
  looksLikeNonEnglish,
  normalizeRestatedQuestion,
  resolveEnglishLocationAndFirstRetrievalQuery,
  restateQuestionInEnglish,
  shouldAlsoCheckOriginalForLocationIntent,
} from "@/utils/server/englishRetrievalQuery";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

describe("looksLikeNonEnglish", () => {
  it("detects the Italian article 'il' that used to match Israel", () => {
    expect(looksLikeNonEnglish("Che dice il Maestro sugli angeli?")).toBe(true);
  });

  it("detects German singing questions", () => {
    expect(looksLikeNonEnglish("Wie kann ich besser singen?")).toBe(true);
  });

  it("detects Spanish questions with diacritics", () => {
    expect(looksLikeNonEnglish("¿Cómo meditar por la mañana?")).toBe(true);
  });

  it("treats ordinary English library questions as English", () => {
    expect(looksLikeNonEnglish("What is the meaning of meditation?")).toBe(false);
    expect(looksLikeNonEnglish("What did SK say about devotion?")).toBe(false);
    expect(looksLikeNonEnglish("Where is the nearest Ananda center?")).toBe(false);
    expect(looksLikeNonEnglish("How do I practice Hong-Sau?")).toBe(false);
    expect(looksLikeNonEnglish("What did Yogananda say about “AUM”?")).toBe(false);
  });

  it("detects the Hindi nearest-center query via Devanagari letters", () => {
    const hindiNearestCenter = "सबसे नजदीकी केंद्र कहाँ है?";
    expect(hasNonAsciiLetter(hindiNearestCenter)).toBe(true);
    expect(looksLikeNonEnglish(hindiNearestCenter)).toBe(true);
  });

  it("does not treat ASCII Italian or curly-quoted English as non-ASCII letters", () => {
    expect(hasNonAsciiLetter("Che dice il Maestro sugli angeli?")).toBe(false);
    expect(hasNonAsciiLetter("What did Yogananda say about “AUM”?")).toBe(false);
  });
});

describe("detectLocationIntentAfterEnglishRestatement", () => {
  const hindiNearestCenter = "सबसे नजदीकी केंद्र कहाँ है?";

  it("falls back to the Hindi original when the English restatement misses geo", async () => {
    const hasLocationIntent = jest.fn(async (query: string) => query === hindiNearestCenter);

    await expect(
      detectLocationIntentAfterEnglishRestatement(
        hasLocationIntent,
        hindiNearestCenter,
        "Please tell me about local Ananda groups"
      )
    ).resolves.toBe(true);
    expect(hasLocationIntent).toHaveBeenCalledWith("Please tell me about local Ananda groups");
    expect(hasLocationIntent).toHaveBeenCalledWith(hindiNearestCenter);
    expect(shouldAlsoCheckOriginalForLocationIntent(hindiNearestCenter, "Please tell me about local Ananda groups")).toBe(
      true
    );
  });

  it("does not re-check ASCII Italian originals after an English restatement", async () => {
    const hasLocationIntent = jest.fn(async () => false);

    await expect(
      detectLocationIntentAfterEnglishRestatement(
        hasLocationIntent,
        "Che dice il Maestro sugli angeli?",
        "What does the Master say about angels?"
      )
    ).resolves.toBe(false);
    expect(hasLocationIntent).toHaveBeenCalledTimes(1);
    expect(hasLocationIntent).toHaveBeenCalledWith("What does the Master say about angels?");
    expect(
      shouldAlsoCheckOriginalForLocationIntent(
        "Che dice il Maestro sugli angeli?",
        "What does the Master say about angels?"
      )
    ).toBe(false);
  });
});

describe("extractModelText and normalizeRestatedQuestion", () => {
  it("reads string or message content and keeps the first clean line", () => {
    expect(extractModelText("What are angels?", "fallback")).toBe("What are angels?");
    expect(extractModelText({ content: "What are angels?" }, "fallback")).toBe("What are angels?");
    expect(extractModelText({ content: ["What ", "are angels?"] }, "fallback")).toBe("What are angels?");
    expect(extractModelText({}, "fallback")).toBe("fallback");
    expect(normalizeRestatedQuestion('"What are angels?"\nextra', "fallback")).toBe("What are angels?");
    expect(normalizeRestatedQuestion("   ", "fallback")).toBe("fallback");
  });
});

describe("restateQuestionInEnglish", () => {
  it("returns the model English restatement", async () => {
    const model = {
      invoke: jest.fn().mockResolvedValue({ content: "What does the Master say about angels?" }),
    } as unknown as BaseLanguageModel;

    await expect(restateQuestionInEnglish(model, "Che dice il Maestro sugli angeli?")).resolves.toBe(
      "What does the Master say about angels?"
    );
    expect(model.invoke).toHaveBeenCalled();
  });

  it("falls back to the original question when the model fails", async () => {
    const model = {
      invoke: jest.fn().mockRejectedValue(new Error("boom")),
    } as unknown as BaseLanguageModel;

    await expect(restateQuestionInEnglish(model, "Wie kann ich besser singen?")).resolves.toBe(
      "Wie kann ich besser singen?"
    );
  });
});

describe("resolveEnglishLocationAndFirstRetrievalQuery", () => {
  it("skips the model for English first questions", async () => {
    const model = {
      invoke: jest.fn(),
    } as unknown as BaseLanguageModel;

    await expect(
      resolveEnglishLocationAndFirstRetrievalQuery(model, "What is meditation?")
    ).resolves.toBe("What is meditation?");
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it("restates non-English first questions before location and retrieval", async () => {
    const model = {
      invoke: jest.fn().mockResolvedValue({ content: "How can I sing better?" }),
    } as unknown as BaseLanguageModel;

    await expect(
      resolveEnglishLocationAndFirstRetrievalQuery(model, "Wie kann ich besser singen?")
    ).resolves.toBe("How can I sing better?");
    expect(model.invoke).toHaveBeenCalled();
  });
});
