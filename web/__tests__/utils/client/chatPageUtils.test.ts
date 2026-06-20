import {
  buildFilterExplicitnessPayload,
  formatTimingMetricsDisplay,
  generateChatPageTitle,
  getAutoAppliedSourceFocusAction,
  getQueriesForCollection,
  getRepairAllLibrariesSelection,
  shouldShowSuggestions,
  shouldUsePinnedChatShell,
} from "@/utils/client/chatPageUtils";
import type { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import type { TitleScopeFilterConflictPayload } from "@/types/titleScope";

describe("getRepairAllLibrariesSelection", () => {
  it("falls back to default libraries when action omits libraries", () => {
    expect(getRepairAllLibrariesSelection(undefined, [])).toEqual([]);
    expect(getRepairAllLibrariesSelection(undefined, ["Default Library"])).toEqual(["Default Library"]);
  });

  it("uses action libraries when provided", () => {
    expect(getRepairAllLibrariesSelection(["Repair Library"], ["Default Library"])).toEqual(["Repair Library"]);
  });
});

describe("getAutoAppliedSourceFocusAction", () => {
  const basePayload: TitleScopeFilterConflictPayload = {
    type: "filter_conflict",
    titleScopeLabel: "Whispers from Eternity",
    summaryMessage: "Conflict",
    reasons: ["author mismatch"],
    actions: [
      { kind: "setLibraries", label: "Switch author" },
      { kind: "setCollection", label: "Use whole library", collection: "whole_library" },
    ],
  };

  it("returns whole_library setCollection action when present", () => {
    const action = getAutoAppliedSourceFocusAction(basePayload);
    expect(action?.kind).toBe("setCollection");
    expect(action?.collection).toBe("whole_library");
  });

  it("returns null when no whole_library action exists", () => {
    const payload = { ...basePayload, actions: [{ kind: "setLibraries" as const, label: "Switch" }] };
    expect(getAutoAppliedSourceFocusAction(payload)).toBeNull();
  });
});

describe("shouldShowSuggestions", () => {
  it("shows suggestions when there are no messages", () => {
    expect(shouldShowSuggestions([])).toBe(true);
  });

  it("shows suggestions when only api messages exist", () => {
    const messages: ExtendedAIMessage[] = [{ type: "apiMessage", message: "Hello" }];
    expect(shouldShowSuggestions(messages)).toBe(true);
  });

  it("hides suggestions after the first user message", () => {
    const messages: ExtendedAIMessage[] = [
      { type: "apiMessage", message: "Hello" },
      { type: "userMessage", message: "Question?" },
    ];
    expect(shouldShowSuggestions(messages)).toBe(false);
  });
});

describe("getQueriesForCollection", () => {
  const queries = {
    master_swami: ["Query A"],
    whole_library: ["Query B", "Query C"],
  };

  it("returns queries for the selected collection", () => {
    expect(getQueriesForCollection("whole_library", queries)).toEqual(["Query B", "Query C"]);
  });

  it("falls back to the first available collection", () => {
    expect(getQueriesForCollection("missing", queries)).toEqual(["Query A"]);
  });

  it("maps auto collection to master_swami queries when configured", () => {
    const autoQueries = {
      auto: ["(Suggested queries not set up yet)"],
      master_swami: ["Query A", "Query B"],
    };
    const collectionConfig = {
      auto: "Auto (recommended)",
      master_swami: "Master and Swami",
      whole_library: "All authors",
    };

    expect(getQueriesForCollection("auto", autoQueries, collectionConfig)).toEqual(["Query A", "Query B"]);
  });

  it("returns empty array when no collections exist", () => {
    expect(getQueriesForCollection("missing", {})).toEqual([]);
  });
});

describe("buildFilterExplicitnessPayload", () => {
  it("returns undefined when title scope selection is disabled", () => {
    expect(buildFilterExplicitnessPayload(false, true, true, true)).toBeUndefined();
  });

  it("returns explicitness flags when title scope selection is enabled", () => {
    expect(buildFilterExplicitnessPayload(true, true, false, true)).toEqual({
      collection: true,
      libraries: false,
      mediaTypes: true,
    });
  });
});

describe("formatTimingMetricsDisplay", () => {
  it("formats complete timing metrics", () => {
    expect(formatTimingMetricsDisplay({ ttfb: 1500, tokensPerSecond: 50 })).toBe(
      "1.50 secs to first character, then 50 chars/sec streamed"
    );
  });

  it("returns null for missing or incomplete data", () => {
    expect(formatTimingMetricsDisplay(null)).toBeNull();
    expect(formatTimingMetricsDisplay({ ttfb: 1000 })).toBeNull();
  });
});

describe("generateChatPageTitle", () => {
  it("uses conversation title when set", () => {
    expect(generateChatPageTitle("My Chat", "Luca")).toBe("My Chat - Luca");
  });

  it("uses site name alone on home", () => {
    expect(generateChatPageTitle(null, "Luca")).toBe("Luca");
  });
});

describe("shouldUsePinnedChatShell", () => {
  it("is true for login-required sites", () => {
    expect(shouldUsePinnedChatShell(true, 1)).toBe(true);
  });

  it("is true when more than one message exists", () => {
    expect(shouldUsePinnedChatShell(false, 2)).toBe(true);
  });

  it("is false for anonymous single-message chats", () => {
    expect(shouldUsePinnedChatShell(false, 1)).toBe(false);
  });
});
