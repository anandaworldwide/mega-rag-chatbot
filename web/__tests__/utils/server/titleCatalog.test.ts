/** @jest-environment node */

import {
  computeTitleScopeFilterConflictPayload,
  normalizeTitleScopeInput,
  normalizeTitleScopeSegment,
  rankTitleScopeSuggestions,
} from "@/utils/server/titleCatalog";
import type { SiteConfig } from "@/types/siteConfig";
import { TitleCatalogLookupEntry } from "@/types/titleScope";

const dummyAvailability = {
  libraries: [] as string[],
  mediaTypes: ["text"] as const,
  collectionsWithVectors: ["whole_library"] as const,
};

describe("titleCatalog matching", () => {
  const entries: TitleCatalogLookupEntry[] = [
    {
      canonicalPrefix: "Lessons in Meditation",
      normalizedPrefix: "lessons in meditation",
      normalizedSearchText: "lessons in meditation",
      normalizedLevels: ["lessons in meditation"],
      depth: 1,
      terminalSegment: "Lessons in Meditation",
      normalizedTerminalSegment: "lessons in meditation",
      fullTitleCount: 12,
      vectorCount: 240,
      availability: { ...dummyAvailability, libraries: ["Ananda Library"] },
    },
    {
      canonicalPrefix: "The Essence of Bhagavad Gita",
      normalizedPrefix: "essence of bhagavad gita",
      normalizedSearchText: "essence of bhagavad gita",
      normalizedLevels: ["essence of bhagavad gita"],
      depth: 1,
      terminalSegment: "The Essence of Bhagavad Gita",
      normalizedTerminalSegment: "essence of bhagavad gita",
      fullTitleCount: 18,
      vectorCount: 360,
      availability: { ...dummyAvailability, libraries: ["Ananda Library"] },
    },
    {
      canonicalPrefix: "Bible:: Old Testament:: Book of Genesis",
      normalizedPrefix: "bible :: old testament :: book of genesis",
      normalizedSearchText: "bible old testament book of genesis",
      normalizedLevels: ["bible", "old testament", "book of genesis"],
      depth: 3,
      terminalSegment: "Book of Genesis",
      normalizedTerminalSegment: "book of genesis",
      fullTitleCount: 50,
      vectorCount: 1200,
      availability: { ...dummyAvailability, libraries: ["Ananda Library"] },
    },
  ];

  it("normalizes leading articles and punctuation", () => {
    expect(normalizeTitleScopeSegment("The Essence of Bhagavad Gita")).toBe("essence of bhagavad gita");
    expect(normalizeTitleScopeInput("Bible :: Genesis")).toBe("bible :: genesis");
  });

  it("matches partial book titles", () => {
    const suggestions = rankTitleScopeSuggestions(entries, "essence of Bhagavad Gita");
    expect(suggestions[0]?.canonicalPrefix).toBe("The Essence of Bhagavad Gita");
  });

  it("matches ordered tokens across hierarchy levels", () => {
    const suggestions = rankTitleScopeSuggestions(entries, "Bible Genesis");
    expect(suggestions[0]?.canonicalPrefix).toBe("Bible:: Old Testament:: Book of Genesis");
    expect(suggestions[0]?.matchType).toBe("ordered_tokens");
  });

  it("prefers exact matches when available", () => {
    const suggestions = rankTitleScopeSuggestions(entries, "Lessons in Meditation");
    expect(suggestions[0]?.canonicalPrefix).toBe("Lessons in Meditation");
    expect(suggestions[0]?.matchType).toBe("exact");
  });

  it("ranks parent work above chapter prefixes for short substring queries", () => {
    const bookAndChapters: TitleCatalogLookupEntry[] = [
      {
        canonicalPrefix: "Whispers from Eternity",
        normalizedPrefix: "whispers from eternity",
        normalizedSearchText: "whispers from eternity",
        normalizedLevels: ["whispers from eternity"],
        depth: 1,
        terminalSegment: "Whispers from Eternity",
        normalizedTerminalSegment: "whispers from eternity",
        fullTitleCount: 120,
        vectorCount: 5000,
        availability: { ...dummyAvailability, libraries: ["Ananda Library"] },
      },
      {
        canonicalPrefix: "Whispers from Eternity:: Chapter 3",
        normalizedPrefix: "whispers from eternity :: chapter 3",
        normalizedSearchText: "whispers from eternity chapter 3",
        normalizedLevels: ["whispers from eternity", "chapter 3"],
        depth: 2,
        terminalSegment: "Chapter 3",
        normalizedTerminalSegment: "chapter 3",
        fullTitleCount: 1,
        vectorCount: 80,
        availability: { ...dummyAvailability, libraries: ["Ananda Library"] },
      },
    ];
    const suggestions = rankTitleScopeSuggestions(bookAndChapters, "whispers");
    expect(suggestions[0]?.canonicalPrefix).toBe("Whispers from Eternity");
    expect(suggestions[1]?.canonicalPrefix).toBe("Whispers from Eternity:: Chapter 3");
  });
});

describe("computeTitleScopeFilterConflictPayload", () => {
  const baseSiteConfig = {
    siteId: "ananda",
    collectionConfig: {
      master_swami: "Master and Swami",
      whole_library: "All authors",
    },
    includedLibraries: [{ name: "Ananda Library" }, { name: "Crystal Clarity" }],
    enabledMediaTypes: ["text", "audio", "youtube"] as const,
  } as unknown as SiteConfig;

  const entryWithAvailability = {
    canonicalPrefix: "The Yugas",
    normalizedPrefix: "yugas",
    normalizedSearchText: "yugas",
    normalizedLevels: ["yugas"],
    depth: 1,
    terminalSegment: "The Yugas",
    normalizedTerminalSegment: "yugas",
    fullTitleCount: 1,
    vectorCount: 10,
    availability: {
      libraries: ["Crystal Clarity"],
      mediaTypes: ["text"],
      collectionsWithVectors: ["whole_library"],
    },
  };

  it("returns null when filters are compatible", () => {
    const result = computeTitleScopeFilterConflictPayload(entryWithAvailability, baseSiteConfig, {
      collection: "whole_library",
      selectedLibraries: ["Crystal Clarity"],
      mediaTypes: { text: true, audio: false, youtube: false },
    });
    expect(result).toBeNull();
  });

  it("detects master_swami vs non-master source", () => {
    const result = computeTitleScopeFilterConflictPayload(entryWithAvailability, baseSiteConfig, {
      collection: "master_swami",
      selectedLibraries: ["Crystal Clarity"],
      mediaTypes: { text: true, audio: true, youtube: true },
    });
    expect(result?.type).toBe("filter_conflict");
    expect(result?.reasons.some((r) => r.includes("Master and Swami"))).toBe(true);
    expect(result?.actions.find((a) => a.kind === "repairAll")).toBeDefined();
  });

  it("detects library mismatch", () => {
    const result = computeTitleScopeFilterConflictPayload(entryWithAvailability, baseSiteConfig, {
      collection: "whole_library",
      selectedLibraries: ["Ananda Library"],
      mediaTypes: { text: true, audio: true, youtube: true },
    });
    expect(result?.type).toBe("filter_conflict");
    expect(result?.reasons.some((r) => r.includes("libraries"))).toBe(true);
  });

  it("detects media type mismatch", () => {
    const result = computeTitleScopeFilterConflictPayload(entryWithAvailability, baseSiteConfig, {
      collection: "whole_library",
      selectedLibraries: ["Crystal Clarity"],
      mediaTypes: { text: false, audio: true, youtube: false },
    });
    expect(result?.type).toBe("filter_conflict");
    expect(result?.reasons.some((r) => r.toLowerCase().includes("media"))).toBe(true);
  });
});
