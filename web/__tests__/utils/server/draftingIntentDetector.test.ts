/** @jest-environment node */

import { isDraftingOrTranslationQuery } from "@/utils/server/draftingIntentDetector";

describe("isDraftingOrTranslationQuery", () => {
  it("detects a translate-this request", () => {
    expect(isDraftingOrTranslationQuery("Please translate this into Italian: Buona festa.")).toBe(true);
  });

  it("detects a Guna Chart translation request", () => {
    expect(isDraftingOrTranslationQuery("Translate the Guna Chart into Italian")).toBe(true);
  });

  it("detects email rewrite and reply requests that mention an author", () => {
    expect(
      isDraftingOrTranslationQuery("Rewrite this email from Asha Nayaswami about the festival schedule")
    ).toBe(true);
    expect(isDraftingOrTranslationQuery("Please reply to this email: Dear Asha, can you come Tuesday?")).toBe(
      true
    );
  });

  it("detects invitation and birthday-line drafts", () => {
    expect(isDraftingOrTranslationQuery("Draft an invitation to the Portland center gathering")).toBe(true);
    expect(isDraftingOrTranslationQuery("Write a birthday line for Devi")).toBe(true);
  });

  it("does not treat library questions about writings or translations as drafts", () => {
    expect(isDraftingOrTranslationQuery("What did Yogananda write about devotion?")).toBe(false);
    expect(isDraftingOrTranslationQuery("Did SK write about Kriya yoga?")).toBe(false);
    expect(isDraftingOrTranslationQuery("How did Yogananda translate the Bhagavad Gita?")).toBe(false);
    expect(isDraftingOrTranslationQuery("What is meditation?")).toBe(false);
    expect(isDraftingOrTranslationQuery("Write a class outline about kriya")).toBe(false);
    expect(isDraftingOrTranslationQuery("Where is the nearest Ananda center?")).toBe(false);
  });
});
