/** @jest-environment node */

import fs from "fs";
import path from "path";
import {
  AUTOMATIC_AUTHOR_RANKING_LINE,
  buildActiveFilterPromptData,
  buildActiveFiltersSummaryForGeneration,
  EMPTY_RETRIEVAL_FILTER_HINT,
  EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT,
  extractMediaTypeFilter,
  formatAuthorScopeDebugLog,
  formatInferredAuthorFocusLine,
} from "@/utils/server/activeFilterPrompt";

const mockSiteConfig = {
  siteId: "ananda",
  shortname: "Luca",
  name: "Ananda",
  tagline: "Test",
  greeting: "Hi",
  parent_site_url: "",
  parent_site_name: "",
  help_url: "",
  help_text: "",
  collectionConfig: {
    master_swami: "Master and Swami",
    whole_library: "All authors",
    bible: "Bible",
  },
  libraryMappings: {},
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  welcome_popup_heading: "",
  other_visitors_reference: "",
  loginImage: null,
  header: { logo: "", navItems: [] },
  footer: { links: [] },
  requireLogin: false,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: true,
  includedLibraries: ["Ananda Library", "Crystal Clarity"],
  enabledMediaTypes: ["text", "audio", "youtube"] as const,
};

describe("extractMediaTypeFilter", () => {
  it("returns undefined when filter is missing", () => {
    expect(extractMediaTypeFilter(undefined)).toBeUndefined();
  });

  it("parses $and type clauses", () => {
    expect(extractMediaTypeFilter({ $and: [{ type: { $in: ["text"] } }] })).toEqual({ text: true });
  });
});

describe("buildActiveFilterPromptData", () => {
  it("returns no restrictive filters for whole_library with all libraries and all media", () => {
    const result = buildActiveFilterPromptData(
      mockSiteConfig as any,
      { $and: [{ type: { $in: ["text", "audio", "youtube"] } }] },
      "whole_library",
      ["Ananda Library", "Crystal Clarity"]
    );

    expect(result.hasRestrictiveFilters).toBe(false);
    expect(result.activeFiltersSummary).toContain("No restrictive filters are active");
  });

  it("includes a collection label when a restrictive collection is active", () => {
    const result = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "bible");

    expect(result.hasRestrictiveFilters).toBe(true);
    expect(result.collectionLabel).toBe("Bible");
    expect(result.activeFiltersSummary).toContain("- Collection: Bible");
  });

  it("includes selected title scope as a restrictive filter", () => {
    const result = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "whole_library",
      ["Ananda Library", "Crystal Clarity"],
      "Whispers from Eternity"
    );

    expect(result.titleScopeLabel).toBe("Whispers from Eternity");
    expect(result.activeFiltersSummary).toContain("- Source scope: Only Whispers from Eternity");
  });

  it("describes automatic author scope for auto collection", () => {
    const autoSiteConfig = {
      ...mockSiteConfig,
      collectionConfig: {
        auto: "Auto (recommended)",
        master_swami: "Master and Swami",
        whole_library: "All authors",
      },
    };

    const result = buildActiveFilterPromptData(autoSiteConfig as any, undefined, "auto");

    expect(result.activeFiltersSummary).toContain(`- ${AUTOMATIC_AUTHOR_RANKING_LINE}`);
    expect(result.activeFiltersSummary).not.toContain("- Collection:");
  });

  it("treats auto author scope alone as non-restrictive (it is the broadest setting)", () => {
    const result = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "auto");

    expect(result.activeFiltersSummary).toContain(`- ${AUTOMATIC_AUTHOR_RANKING_LINE}`);
    expect(result.hasRestrictiveFilters).toBe(false);
  });

  it("labels query-inferred author focus and does not treat it as a user-set filter", () => {
    const result = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "auto",
      undefined,
      undefined,
      "Asha Nayaswami"
    );

    expect(result.activeFiltersSummary).toContain(`- ${formatInferredAuthorFocusLine("Asha Nayaswami")}`);
    expect(result.activeFiltersSummary).not.toContain("Focused author:");
    expect(result.activeFiltersSummary).not.toContain(AUTOMATIC_AUTHOR_RANKING_LINE);
    expect(result.hasRestrictiveFilters).toBe(false);
    expect(result.inferredAuthor).toBe("Asha Nayaswami");
  });

  it("keeps a user-set Collection line when query-inferred author focus is also present", () => {
    const result = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "bible",
      undefined,
      undefined,
      "Asha Nayaswami"
    );

    expect(result.collectionLabel).toBe("Bible");
    expect(result.activeFiltersSummary).toContain("- Collection: Bible");
    expect(result.activeFiltersSummary).toContain(`- ${formatInferredAuthorFocusLine("Asha Nayaswami")}`);
    expect(result.hasRestrictiveFilters).toBe(true);
    expect(result.inferredAuthor).toBe("Asha Nayaswami");
  });
});

describe("buildActiveFiltersSummaryForGeneration", () => {
  it("appends the empty-retrieval hint when restrictive filters return no documents", () => {
    const data = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "bible");
    expect(data.hasRestrictiveFilters).toBe(true);

    const summary = buildActiveFiltersSummaryForGeneration(data, true);

    expect(summary).toContain("- Collection: Bible");
    expect(summary).toContain(`- ${EMPTY_RETRIEVAL_FILTER_HINT}`);
    expect(EMPTY_RETRIEVAL_FILTER_HINT).toContain("fully answer from information in this system prompt");
    expect(EMPTY_RETRIEVAL_FILTER_HINT).toContain("do NOT mention the empty retrieval");
    expect(EMPTY_RETRIEVAL_FILTER_HINT).toContain("user-set filter");
  });

  it("does not append the hint when documents were retrieved", () => {
    const data = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "bible");

    const summary = buildActiveFiltersSummaryForGeneration(data, false);

    expect(summary).toBe(data.activeFiltersSummary);
    expect(summary).not.toContain(EMPTY_RETRIEVAL_FILTER_HINT);
  });

  it("does not append the hint when no restrictive filters are active", () => {
    const data = buildActiveFilterPromptData(
      mockSiteConfig as any,
      { $and: [{ type: { $in: ["text", "audio", "youtube"] } }] },
      "whole_library",
      ["Ananda Library", "Crystal Clarity"]
    );
    expect(data.hasRestrictiveFilters).toBe(false);

    const summary = buildActiveFiltersSummaryForGeneration(data, true);

    expect(summary).toBe(data.activeFiltersSummary);
    expect(summary).not.toContain(EMPTY_RETRIEVAL_FILTER_HINT);
  });

  it("does not append the hint for auto author scope when retrieval is empty", () => {
    const data = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "auto");
    expect(data.hasRestrictiveFilters).toBe(false);

    const summary = buildActiveFiltersSummaryForGeneration(data, true);

    expect(summary).toBe(data.activeFiltersSummary);
    expect(summary).not.toContain(EMPTY_RETRIEVAL_FILTER_HINT);
  });

  it("appends the inferred-author empty hint instead of the user-set filter hint", () => {
    const data = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "auto",
      undefined,
      undefined,
      "Asha Nayaswami"
    );
    expect(data.hasRestrictiveFilters).toBe(false);
    expect(data.inferredAuthor).toBe("Asha Nayaswami");

    const summary = buildActiveFiltersSummaryForGeneration(data, true);

    expect(summary).toContain(EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT);
    expect(summary).not.toContain(EMPTY_RETRIEVAL_FILTER_HINT);
    expect(EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT).toContain("user did not set a chat filter");
  });

  it("prefers the user-set filter empty hint when Collection and inferred author both apply", () => {
    const data = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "bible",
      undefined,
      undefined,
      "Asha Nayaswami"
    );
    expect(data.hasRestrictiveFilters).toBe(true);

    const summary = buildActiveFiltersSummaryForGeneration(data, true);

    expect(summary).toContain("- Collection: Bible");
    expect(summary).toContain(EMPTY_RETRIEVAL_FILTER_HINT);
    expect(summary).not.toContain(EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT);
  });
});

describe("formatAuthorScopeDebugLog", () => {
  it("includes retrieval decision and active filter prompt lines", () => {
    const activeFilterPromptData = buildActiveFilterPromptData(
      mockSiteConfig as any,
      undefined,
      "auto",
      undefined,
      undefined,
      "Asha Nayaswami"
    );

    const message = formatAuthorScopeDebugLog({
      question: "Tell me about Lightbearer",
      selectedCollectionKey: "auto",
      collectionMode: "auto",
      scopeHint: "broad",
      scopeDescriptor: { kind: "named", author: "Asha Nayaswami" },
      activeFilterPromptData,
      blendRetrieval: undefined,
    });

    expect(message).toContain("[AuthorScope]");
    expect(message).toContain('UI collection key: auto');
    expect(message).toContain('LLM scope hint: broad');
    expect(message).toContain('named author "Asha Nayaswami"');
    expect(message).toContain(`- ${formatInferredAuthorFocusLine("Asha Nayaswami")}`);
  });

  it("logs the author-match utterance when it differs from the retrieval query", () => {
    const activeFilterPromptData = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "auto");

    const message = formatAuthorScopeDebugLog({
      question: "How does Kundalini relate to music according to Paramhansa Yogananda and Swami Kriyananda?",
      authorMatchQuestion: "How does Kundalini relate to music?",
      selectedCollectionKey: "auto",
      collectionMode: "auto",
      scopeHint: "default",
      scopeDescriptor: { kind: "blend", masterSwamiBoost: 0.2 },
      activeFilterPromptData,
    });

    expect(message).toContain('author match utterance: "How does Kundalini relate to music?"');
    expect(message).not.toContain("named author");
  });

  it("includes blend boost and ranked source scores when provided", () => {
    const activeFilterPromptData = buildActiveFilterPromptData(mockSiteConfig as any, undefined, "auto");

    const message = formatAuthorScopeDebugLog({
      question: "What is the Inner Renewal Retreat?",
      selectedCollectionKey: "auto",
      collectionMode: "auto",
      scopeHint: "default",
      scopeDescriptor: { kind: "blend", masterSwamiBoost: 0.2 },
      activeFilterPromptData,
      blendRetrieval: {
        masterSwamiBoost: 0.2,
        fetchCount: 12,
        rankedSamples: [
          {
            author: undefined,
            library: "ananda.org",
            rawScore: 0.84,
            boostedScore: 0.84,
          },
          {
            author: "Swami Kriyananda",
            library: "Treasures",
            rawScore: 0.55,
            boostedScore: 0.66,
          },
        ],
      },
    });

    expect(message).toContain('resolved retrieval: blend (Master/Swami score boost δ=0.2)');
    expect(message).toContain("blend fetch window: 12");
    expect(message).toContain("ananda.org");
    expect(message).toContain("0.8400 → 0.8400");
  });
});

describe("ananda-base author-scope filter labels", () => {
  it("teaches Automatic vs query-inferred vs user-set filters", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("Author ranking: Automatic");
    expect(prompt).toContain("Query-inferred author focus (not a UI filter)");
    expect(prompt).toContain("NEVER call this a focused-author filter");
    expect(prompt).toContain("NEVER say they set a focused-author filter");
    expect(prompt).not.toContain("a `Focused author`");
  });
});
