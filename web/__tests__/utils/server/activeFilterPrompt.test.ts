/** @jest-environment node */

import { buildActiveFilterPromptData, extractMediaTypeFilter } from "@/utils/server/activeFilterPrompt";

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
});
