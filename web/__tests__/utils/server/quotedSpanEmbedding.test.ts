/** @jest-environment node */

import type { TitleCatalogLookupEntry } from "@/types/titleScope";
import {
  appendQuoteRoleGuidance,
  coerceSearchMoreSourcesQuery,
  extractQuotedSpanForEmbedding,
  formatQuoteRoleAnswerGuidance,
  looksLikeSentencePassage,
  resolveEmbeddingQuery,
  resolveQuoteRole,
  searchQueryForQuoteRole,
} from "@/utils/server/quotedSpanEmbedding";

function catalogEntry(overrides: Partial<TitleCatalogLookupEntry> = {}): TitleCatalogLookupEntry {
  return {
    canonicalPrefix: "Art and Science of Raja Yoga",
    normalizedPrefix: "art and science of raja yoga",
    normalizedSearchText: "art and science of raja yoga",
    normalizedLevels: ["art and science of raja yoga"],
    depth: 1,
    terminalSegment: "Art and Science of Raja Yoga",
    normalizedTerminalSegment: "art and science of raja yoga",
    fullTitleCount: 4,
    vectorCount: 40,
    availability: {
      libraries: ["Ananda Library"],
      mediaTypes: ["text"],
      collectionsWithVectors: ["whole_library"],
    },
    ...overrides,
  };
}

const rajaCatalog = {
  catalogEntries: [catalogEntry()],
  catalogStatus: "available" as const,
};

const autobiographyCatalog = {
  catalogEntries: [
    catalogEntry({
      canonicalPrefix: "Autobiography of a Yogi",
      normalizedPrefix: "autobiography of a yogi",
      normalizedSearchText: "autobiography of a yogi",
      normalizedLevels: ["autobiography of a yogi"],
      terminalSegment: "Autobiography of a Yogi",
      normalizedTerminalSegment: "autobiography of a yogi",
    }),
  ],
  catalogStatus: "available" as const,
};

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

  it("does not treat the site/library name as a quoted span", () => {
    expect(extractQuotedSpanForEmbedding('What is "the Ananda Libraries"?')).toBeNull();
    expect(extractQuotedSpanForEmbedding('What sources are in "Ananda Libraries"?')).toBeNull();
    expect(extractQuotedSpanForEmbedding('What is “Ananda Library”?')).toBeNull();
    expect(
      extractQuotedSpanForEmbedding('Find this line: "Walk quietly toward the inner light when restlessness rises."')
    ).toBe("Walk quietly toward the inner light when restlessness rises.");
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

  it("keeps the fallback query when the only quoted span is the site/library name", () => {
    const fallback = "What sources do you use for your answers?";

    expect(resolveEmbeddingQuery('What is "the Ananda Libraries"?', fallback)).toBe(fallback);
  });

  it("embeds the full original question for a quoted book title plus topic (Vayu)", () => {
    const question = 'What did Swamiji write in "Art and Science of Raja Yoga" about vikrasana?';

    expect(resolveEmbeddingQuery(question, question, rajaCatalog)).toBe(question);
  });

  it("embeds the full original question for a curly-quoted Vayu title plus topic", () => {
    const question =
      "What did Swamiji write in \u201cArt and Science of Raja Yoga\u201d about vikrasana?";

    expect(resolveEmbeddingQuery(question, question, rajaCatalog)).toBe(question);
  });
});

describe("resolveQuoteRole", () => {
  it("uses the original question for a recognized title plus topic", () => {
    const question = 'What did Swamiji write in "Art and Science of Raja Yoga" about vikrasana?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
    expect(role.titleSpans).toEqual(["Art and Science of Raja Yoga"]);
    expect(role.skipQuoteOnlyCondense).toBe(false);
  });

  it("does not skip condense for a follow-up that quotes a title", () => {
    const question = 'What does "Synthetic Dawn Manual" say about that?';
    const role = resolveQuoteRole(question, question, {
      catalogStatus: "available",
      catalogEntries: [
        catalogEntry({
          canonicalPrefix: "Synthetic Dawn Manual",
          normalizedPrefix: "synthetic dawn manual",
          normalizedSearchText: "synthetic dawn manual",
          normalizedLevels: ["synthetic dawn manual"],
          terminalSegment: "Synthetic Dawn Manual",
          normalizedTerminalSegment: "synthetic dawn manual",
        }),
      ],
    });

    expect(role.kind).toBe("full_question");
    expect(role.skipQuoteOnlyCondense).toBe(false);
  });

  it("uses the original question for Autobiography of a Yogi plus a topic", () => {
    const question = 'What does "Autobiography of a Yogi" say about the guru-disciple relationship?';
    const role = resolveQuoteRole(question, question, autobiographyCatalog);

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("uses the original question for a known title-only question", () => {
    const question = 'Tell me about "Art and Science of Raja Yoga"';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("uses the original question for an unknown title plus topic", () => {
    const question = 'What does "Synthetic Dawn Manual" say about morning stillness?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("uses the original question for an unknown title-only question", () => {
    const question = 'What is in "Synthetic Dawn Manual"?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
  });

  it("embeds a genuine synthetic passage and keeps exact-quote miss wording", () => {
    const question =
      'Can you find me this quotation: "Walk quietly toward the inner light when restlessness rises."';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("Walk quietly toward the inner light when restlessness rises.");
    expect(role.applyExactQuoteMissInstruction).toBe(true);
  });

  it("omits a recognized title from literal lookup on an exact-quotation request", () => {
    const question =
      'Find this quotation in "Synthetic Dawn Manual": "Keep the heart open when the mind is busy with plans"';
    const role = resolveQuoteRole(question, question, {
      catalogStatus: "available",
      catalogEntries: [
        catalogEntry({
          canonicalPrefix: "Synthetic Dawn Manual",
          normalizedPrefix: "synthetic dawn manual",
          normalizedSearchText: "synthetic dawn manual",
          normalizedLevels: ["synthetic dawn manual"],
          terminalSegment: "Synthetic Dawn Manual",
          normalizedTerminalSegment: "synthetic dawn manual",
        }),
      ],
    });

    expect(role.kind).toBe("passage");
    expect(role.titleSpans).toEqual(["Synthetic Dawn Manual"]);
    expect(role.passageSpans).toEqual(["Keep the heart open when the mind is busy with plans"]);
    expect(role.embeddingQuery).toBe("Keep the heart open when the mind is busy with plans");
    expect(role.embeddingQuery).not.toContain("Synthetic Dawn Manual");
  });

  it("treats an exact-quote request that quotes only a known title as a full question", () => {
    const question = 'Find this quotation: "Art and Science of Raja Yoga"';
    const role = resolveQuoteRole(question, question, rajaCatalog);
    const guidance = formatQuoteRoleAnswerGuidance(role);

    expect(role.kind).toBe("full_question");
    expect(role.applyExactQuoteMissInstruction).toBe(false);
    expect(guidance).not.toContain("exact-passage lookup");
    expect(guidance).not.toMatch(/say so in one sentence/i);
  });

  it("lets the passage control lookup when a title and a passage are both quoted", () => {
    const question =
      'In "Art and Science of Raja Yoga" find "Keep the spine upright during vikrasana practice."';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("Keep the spine upright during vikrasana practice.");
    expect(role.titleSpans).toEqual(["Art and Science of Raja Yoga"]);
    expect(role.applyExactQuoteMissInstruction).toBe(true);
  });

  it("lets a curly-quoted passage control lookup beside a title", () => {
    const question =
      "In \u201cArt and Science of Raja Yoga\u201d find \u201cKeep the spine upright during vikrasana practice.\u201d";
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("Keep the spine upright during vikrasana practice.");
  });

  it("treats ambiguous exact catalog matches as uncertain full-question", () => {
    const question = 'What is in "Shared Synthetic Title"?';
    const role = resolveQuoteRole(question, question, {
      catalogStatus: "available",
      catalogEntries: [
        catalogEntry({
          canonicalPrefix: "Shared Synthetic Title",
          normalizedPrefix: "shared synthetic title",
        }),
        catalogEntry({
          canonicalPrefix: "Shared Synthetic Title: Alternate Edition",
          normalizedPrefix: "shared synthetic title",
        }),
      ],
    });

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("does not treat a contains-only catalog hit as a title", () => {
    const question = 'What did they write in "Science of Raja Yoga" about breath?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.titleSpans).toEqual([]);
    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
  });

  it("does not let a longer title beat a shorter quoted passage", () => {
    const question =
      'Look in "Art and Science of Raja Yoga" for "Breathe now in stillness here."';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("Breathe now in stillness here.");
  });

  it("joins multiple explicit passages in appearance order", () => {
    const question =
      'Find "First synthetic passage about stillness." and also "Second synthetic passage about devotion."';
    const role = resolveQuoteRole(question, question);

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe(
      "First synthetic passage about stillness. Second synthetic passage about devotion."
    );
    expect(role.passageSpans).toEqual([
      "First synthetic passage about stillness.",
      "Second synthetic passage about devotion.",
    ]);
  });

  it("keeps literal lookup when the catalog is unavailable and the user asked for an exact quotation", () => {
    const question =
      'Find this quotation: "Walk quietly toward the inner light when restlessness rises."';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "unavailable",
    });

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("Walk quietly toward the inner light when restlessness rises.");
    expect(role.applyExactQuoteMissInstruction).toBe(true);
  });

  it("uses the original question when the catalog is empty and the quote is topical", () => {
    const question = 'What did Swamiji write in "Art and Science of Raja Yoga" about vikrasana?';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "empty",
    });

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("does not treat a long unknown unpunctuated title as a passage when catalog is down", () => {
    const question =
      'What does "The Purple Lantern Field Manual for Quiet Mountain Practice" say about patience?';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "unavailable",
    });

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("does not treat a curly-quoted long unknown title as a passage when catalog is empty", () => {
    const question =
      "What does \u201cThe Purple Lantern Field Manual for Quiet Mountain Practice\u201d say about patience?";
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "empty",
    });

    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("keeps literal lookup for an explicit exact quotation of a long unpunctuated span without catalog", () => {
    const question =
      'Find this quotation: "The Purple Lantern Field Manual for Quiet Mountain Practice"';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "unavailable",
    });

    expect(role.kind).toBe("passage");
    expect(role.embeddingQuery).toBe("The Purple Lantern Field Manual for Quiet Mountain Practice");
    expect(role.applyExactQuoteMissInstruction).toBe(true);
  });

  it("does not treat a trailing question-mark title as a sentence passage", () => {
    const question = 'What does "Who am I beyond this restless thought?" say about identity?';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "unavailable",
    });

    expect(looksLikeSentencePassage("Who am I?")).toBe(false);
    expect(looksLikeSentencePassage("Who am I beyond this restless thought?")).toBe(false);
    expect(role.kind).toBe("full_question");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("does not treat an internal abbreviation period as a sentence passage", () => {
    const question = 'What does "St. Teresa of Avila" say about prayer?';
    const role = resolveQuoteRole(question, question, {
      catalogEntries: [],
      catalogStatus: "unavailable",
    });

    expect(looksLikeSentencePassage("St. Teresa of Avila")).toBe(false);
    expect(role.kind).toBe("full_question");
    expect(role.applyExactQuoteMissInstruction).toBe(false);
  });

  it("does not apply exact-quote miss wording to unquoted topical questions", () => {
    const question = "What did the teachers write about morning practice?";
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("none");
    expect(role.embeddingQuery).toBe(question);
    expect(role.applyExactQuoteMissInstruction).toBe(false);
    expect(role.skipQuoteOnlyCondense).toBe(false);
  });

  it("ignores the site library name as a quoted span", () => {
    const question = 'What sources are in "Ananda Libraries"?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(role.kind).toBe("none");
    expect(role.embeddingQuery).toBe(question);
  });
});

describe("formatQuoteRoleAnswerGuidance", () => {
  const unavailable = { catalogEntries: [], catalogStatus: "unavailable" as const };

  it("tells the model not to treat a long unknown title plus topic as an exact-quote miss", () => {
    const question =
      'What does "The Purple Lantern Field Manual for Quiet Mountain Practice" say about patience?';
    const role = resolveQuoteRole(question, question, unavailable);
    const guidance = formatQuoteRoleAnswerGuidance(role);

    expect(guidance).toContain("topical question");
    expect(guidance).toContain("Do not treat the quoted text as a missing exact passage");
    expect(guidance).not.toContain("exact-passage lookup");
    expect(appendQuoteRoleGuidance("Whole library", role)).toContain(guidance);
  });

  it("keeps exact-quote miss wording for an explicit literal counterpart", () => {
    const question =
      'Find this quotation: "The Purple Lantern Field Manual for Quiet Mountain Practice"';
    const role = resolveQuoteRole(question, question, unavailable);
    const guidance = formatQuoteRoleAnswerGuidance(role);

    expect(guidance).toContain("exact-passage lookup");
    expect(guidance).toContain("say so in one sentence");
    expect(appendQuoteRoleGuidance("Whole library", role)).toContain(guidance);
  });

  it("adds no quote-role line when there is no quoted span", () => {
    const role = resolveQuoteRole("What did the teachers write about morning practice?", "What did the teachers write about morning practice?");
    expect(formatQuoteRoleAnswerGuidance(role)).toBe("");
    expect(appendQuoteRoleGuidance("Whole library", role)).toBe("Whole library");
  });
});

describe("searchQueryForQuoteRole", () => {
  it("uses the restated question when the quote role is none", () => {
    const original = "Tell me more about that.";
    const restated = "Tell me more about practicing patience.";
    const role = resolveQuoteRole(original, original);

    expect(role.kind).toBe("none");
    expect(searchQueryForQuoteRole(role, restated)).toBe(restated);
  });

  it("uses the restated question when the quote role is full_question", () => {
    const original = 'What does "Synthetic Dawn Manual" say about that?';
    const restated = "What does Synthetic Dawn Manual say about practicing patience?";
    const role = resolveQuoteRole(original, original, {
      catalogStatus: "available",
      catalogEntries: [
        catalogEntry({
          canonicalPrefix: "Synthetic Dawn Manual",
          normalizedPrefix: "synthetic dawn manual",
          normalizedSearchText: "synthetic dawn manual",
          normalizedLevels: ["synthetic dawn manual"],
          terminalSegment: "Synthetic Dawn Manual",
          normalizedTerminalSegment: "synthetic dawn manual",
        }),
      ],
    });

    expect(role.kind).toBe("full_question");
    expect(searchQueryForQuoteRole(role, restated)).toBe(restated);
  });

  it("keeps the extracted passage when the quote role is passage", () => {
    const original =
      'Find this quotation: "Walk quietly toward the inner light when restlessness rises."';
    const restated = "Walk quietly toward the inner light when restlessness rises.";
    const role = resolveQuoteRole(original, original, rajaCatalog);
    const passage = "Walk quietly toward the inner light when restlessness rises.";

    expect(role.kind).toBe("passage");
    expect(searchQueryForQuoteRole(role, restated)).toBe(passage);
  });
});

describe("coerceSearchMoreSourcesQuery", () => {
  it("replaces a recognized title-only tool query with the shared embedding query", () => {
    const question = 'What did Swamiji write in "Art and Science of Raja Yoga" about vikrasana?';
    const role = resolveQuoteRole(question, question, rajaCatalog);

    expect(coerceSearchMoreSourcesQuery("Art and Science of Raja Yoga", role)).toBe(question);
  });

  it("replaces a title-only tool query with the restated question for full_question", () => {
    const original = 'What does "Synthetic Dawn Manual" say about that?';
    const restated = "What does Synthetic Dawn Manual say about practicing patience?";
    const role = resolveQuoteRole(original, original, {
      catalogStatus: "available",
      catalogEntries: [
        catalogEntry({
          canonicalPrefix: "Synthetic Dawn Manual",
          normalizedPrefix: "synthetic dawn manual",
          normalizedSearchText: "synthetic dawn manual",
          normalizedLevels: ["synthetic dawn manual"],
          terminalSegment: "Synthetic Dawn Manual",
          normalizedTerminalSegment: "synthetic dawn manual",
        }),
      ],
    });

    expect(coerceSearchMoreSourcesQuery("Synthetic Dawn Manual", role, restated)).toBe(restated);
  });

  it("keeps a passage tool query unchanged", () => {
    const question =
      'Find this quotation: "Walk quietly toward the inner light when restlessness rises."';
    const role = resolveQuoteRole(question, question, rajaCatalog);
    const passage = "Walk quietly toward the inner light when restlessness rises.";

    expect(coerceSearchMoreSourcesQuery(passage, role)).toBe(passage);
  });
});








