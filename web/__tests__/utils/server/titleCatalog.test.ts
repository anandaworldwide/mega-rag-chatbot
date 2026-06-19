/** @jest-environment node */

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn(),
}));

import {
  normalizeTitleScopeSegment,
  normalizeTitleScopeInput,
  rankTitleScopeSuggestions,
  getIncludedLibraryNames,
  computeTitleScopeFilterConflictPayload,
  clearTitleCatalogCache,
} from "@/utils/server/titleCatalog";
import type { TitleCatalogLookupEntry } from "@/types/titleScope";
import type { SiteConfig } from "@/types/siteConfig";

function makeEntry(overrides: Partial<TitleCatalogLookupEntry> = {}): TitleCatalogLookupEntry {
  return {
    canonicalPrefix: "Autobiography of a Yogi",
    normalizedPrefix: "autobiography of a yogi",
    normalizedSearchText: "autobiography of a yogi",
    depth: 1,
    fullTitleCount: 10,
    vectorCount: 100,
    availability: {
      libraries: ["Ananda Library"],
      mediaTypes: ["text"],
      collectionsWithVectors: ["whole_library"],
    },
    ...overrides,
  } as TitleCatalogLookupEntry;
}

const siteConfig = {
  collectionConfig: { whole_library: "All authors", master_swami: "Master and Swami" },
  includedLibraries: ["Ananda Library", "Treasures"],
  enabledMediaTypes: ["text", "audio", "youtube"],
} as unknown as SiteConfig;

describe("normalizeTitleScopeSegment", () => {
  it("strips accents, articles, and punctuation", () => {
    expect(normalizeTitleScopeSegment("The Autobiography!")).toBe("autobiography");
    expect(normalizeTitleScopeSegment("Crème Brûlée")).toBe("creme brulee");
  });
});

describe("normalizeTitleScopeInput", () => {
  it("normalizes multi-level :: input", () => {
    expect(normalizeTitleScopeInput("The Book :: A Chapter")).toBe("book :: chapter");
  });
});

describe("rankTitleScopeSuggestions", () => {
  it("returns an empty list for an empty query", () => {
    expect(rankTitleScopeSuggestions([makeEntry()], "")).toEqual([]);
  });

  it("ranks an exact match highest", () => {
    const results = rankTitleScopeSuggestions([makeEntry()], "Autobiography of a Yogi");
    expect(results[0].matchType).toBe("exact");
  });

  it("detects contains matches", () => {
    const results = rankTitleScopeSuggestions([makeEntry()], "Yogi");
    expect(results[0].matchType).toBe("contains");
  });

  it("detects ordered-token matches", () => {
    const entry = makeEntry({ normalizedSearchText: "autobiography great yogi master" });
    const results = rankTitleScopeSuggestions([entry], "autobiography yogi");
    expect(results[0].matchType).toBe("ordered_tokens");
  });

  it("dedupes by canonical prefix and respects the limit", () => {
    const entries = [makeEntry(), makeEntry(), makeEntry({ canonicalPrefix: "Other", normalizedPrefix: "other", normalizedSearchText: "other yogi" })];
    const results = rankTitleScopeSuggestions(entries, "yogi", 1);
    expect(results).toHaveLength(1);
  });

  it("ranks parent work above chapter prefixes for short substring queries", () => {
    const bookAndChapters: TitleCatalogLookupEntry[] = [
      makeEntry({
        canonicalPrefix: "Whispers from Eternity",
        normalizedPrefix: "whispers from eternity",
        normalizedSearchText: "whispers from eternity",
        normalizedLevels: ["whispers from eternity"],
        depth: 1,
        terminalSegment: "Whispers from Eternity",
        normalizedTerminalSegment: "whispers from eternity",
        fullTitleCount: 120,
        vectorCount: 5000,
      } as Partial<TitleCatalogLookupEntry>),
      makeEntry({
        canonicalPrefix: "Whispers from Eternity:: Chapter 3",
        normalizedPrefix: "whispers from eternity :: chapter 3",
        normalizedSearchText: "whispers from eternity chapter 3",
        normalizedLevels: ["whispers from eternity", "chapter 3"],
        depth: 2,
        terminalSegment: "Chapter 3",
        normalizedTerminalSegment: "chapter 3",
        fullTitleCount: 1,
        vectorCount: 80,
      } as Partial<TitleCatalogLookupEntry>),
    ];
    const suggestions = rankTitleScopeSuggestions(bookAndChapters, "whispers");
    expect(suggestions[0]?.canonicalPrefix).toBe("Whispers from Eternity");
    expect(suggestions[1]?.canonicalPrefix).toBe("Whispers from Eternity:: Chapter 3");
  });

  it("matches ordered tokens across hierarchy levels", () => {
    const entry = makeEntry({
      canonicalPrefix: "Bible:: Old Testament:: Book of Genesis",
      normalizedPrefix: "bible :: old testament :: book of genesis",
      normalizedSearchText: "bible old testament book of genesis",
      normalizedLevels: ["bible", "old testament", "book of genesis"],
      depth: 3,
      terminalSegment: "Book of Genesis",
      normalizedTerminalSegment: "book of genesis",
    } as Partial<TitleCatalogLookupEntry>);
    const suggestions = rankTitleScopeSuggestions([entry], "Bible Genesis");
    expect(suggestions[0]?.canonicalPrefix).toBe("Bible:: Old Testament:: Book of Genesis");
    expect(suggestions[0]?.matchType).toBe("ordered_tokens");
  });
});

describe("getIncludedLibraryNames", () => {
  it("handles string and object library entries", () => {
    expect(getIncludedLibraryNames(siteConfig)).toEqual(["Ananda Library", "Treasures"]);
    expect(
      getIncludedLibraryNames({ includedLibraries: [{ name: "Lib A" }, "Lib B"] } as unknown as SiteConfig)
    ).toEqual(["Lib A", "Lib B"]);
  });
});

describe("computeTitleScopeFilterConflictPayload", () => {
  it("returns null when filters are compatible", () => {
    const payload = computeTitleScopeFilterConflictPayload(makeEntry(), siteConfig, {
      collection: "whole_library",
      selectedLibraries: [],
      mediaTypes: undefined,
    });
    expect(payload).toBeNull();
  });

  it("flags a master_swami collection conflict", () => {
    const payload = computeTitleScopeFilterConflictPayload(makeEntry(), siteConfig, {
      collection: "master_swami",
      selectedLibraries: [],
      mediaTypes: undefined,
    });
    expect(payload).not.toBeNull();
    expect(payload?.actions.some((a) => a.kind === "setCollection")).toBe(true);
  });

  it("flags a library conflict when no selected library overlaps", () => {
    const payload = computeTitleScopeFilterConflictPayload(makeEntry(), siteConfig, {
      collection: "whole_library",
      selectedLibraries: ["Unrelated Library"],
      mediaTypes: undefined,
    });
    expect(payload?.actions.some((a) => a.kind === "setLibraries")).toBe(true);
  });

  it("flags a media type conflict", () => {
    const entry = makeEntry({
      availability: { libraries: ["Ananda Library"], mediaTypes: ["audio"], collectionsWithVectors: ["whole_library"] },
    });
    const payload = computeTitleScopeFilterConflictPayload(entry, siteConfig, {
      collection: "whole_library",
      selectedLibraries: [],
      mediaTypes: { text: true },
    });
    expect(payload?.actions.some((a) => a.kind === "setMediaTypes")).toBe(true);
    expect(payload?.actions.some((a) => a.kind === "clearTitleScope")).toBe(true);
  });
});

describe("clearTitleCatalogCache", () => {
  it("clears a single site and the whole cache without throwing", () => {
    expect(() => clearTitleCatalogCache("ananda")).not.toThrow();
    expect(() => clearTitleCatalogCache()).not.toThrow();
  });
});
