/** @jest-environment node */

import {
  extractQuotedSpanForEmbedding,
  resolveEmbeddingQuery,
} from "@/utils/server/quotedSpanEmbedding";

describe("extractQuotedSpanForEmbedding", () => {
  it("returns the quoted phrase and ignores the request wrapper", () => {
    const question =
      'Can you find me this quotation: "Walk quietly toward the inner light when restlessness rises."';

    expect(extractQuotedSpanForEmbedding(question)).toBe(
      "Walk quietly toward the inner light when restlessness rises."
    );
  });

  it("extracts curly-quoted spans", () => {
    const question =
      "Where does this appear: \u201cSit with a quiet mind before you act.\u201d";

    expect(extractQuotedSpanForEmbedding(question)).toBe("Sit with a quiet mind before you act.");
  });

  it("prefers the longest usable quoted span", () => {
    const question =
      'Look in "Training Notes" for "Keep the heart open when the mind is busy with plans."';

    expect(extractQuotedSpanForEmbedding(question)).toBe(
      "Keep the heart open when the mind is busy with plans."
    );
  });

  it("ignores short quoted titles and single-word emphasis", () => {
    expect(extractQuotedSpanForEmbedding('What does "Kriya" mean?')).toBeNull();
    expect(extractQuotedSpanForEmbedding('Open the book "Training Notes"')).toBeNull();
  });

  it("returns null when the message has no quoted span", () => {
    expect(
      extractQuotedSpanForEmbedding("Can you provide more direct quotes from the two main teachers?")
    ).toBeNull();
  });

  it("does not treat apostrophes as quotation marks", () => {
    expect(
      extractQuotedSpanForEmbedding("What is the teacher's advice about morning practice?")
    ).toBeNull();
  });
});

describe("resolveEmbeddingQuery", () => {
  it("embeds the quoted span instead of a condensed request", () => {
    const userQuestion =
      'Looking for this line: "Keep the heart open when the mind is busy with plans."';
    const condensedRequest = "Can you provide more direct quotes from the two main teachers?";

    expect(resolveEmbeddingQuery(userQuestion, condensedRequest)).toBe(
      "Keep the heart open when the mind is busy with plans."
    );
  });

  it("keeps the fallback query when no usable quoted span exists", () => {
    const fallback = "What did the teachers write about morning practice?";

    expect(resolveEmbeddingQuery("Please give more direct quotes", fallback)).toBe(fallback);
  });

  it("uses a quoted span from the fallback query when the utterance has none", () => {
    const fallback =
      'Find this line: "Sit with a quiet mind before you act."';

    expect(resolveEmbeddingQuery("What is the exact first sentence?", fallback)).toBe(
      "Sit with a quiet mind before you act."
    );
  });
});








