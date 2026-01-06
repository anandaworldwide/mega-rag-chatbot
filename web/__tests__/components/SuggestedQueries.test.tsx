import React from "react";
import { render, screen } from "@testing-library/react";
import SuggestedQueries from "@/components/SuggestedQueries";
import { SiteConfig } from "@/types/siteConfig";

// Mock dependencies
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue("test-uuid"),
}));

import { fetchWithAuth } from "@/utils/client/tokenManager";

describe("SuggestedQueries", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "test",
    name: "Test Site",
    shortname: "Test",
    tagline: "Test Tagline",
    greeting: "Test Greeting",
    parent_site_url: "",
    parent_site_name: "",
    help_url: "",
    help_text: "",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "",
    other_visitors_reference: "",
    loginImage: null,
    header: { logo: "", navItems: [] },
    footer: { links: [] },
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: false,
    queriesPerUserPerDay: 100,
    showSourceContent: true,
    showVoting: true,
  };

  const defaultProps = {
    queries: [
      "How can I meditate?",
      "What is yoga?",
      "Tell me about spirituality",
      "What is karma?",
      "What is dharma?",
    ],
    onQueryClick: jest.fn(),
    isLoading: false,
    shuffleQueries: jest.fn(),
    isMobile: false,
    siteConfig: mockSiteConfig,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock successful API response for AI suggestions
    (fetchWithAuth as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hasEnoughHistory: true,
          suggestions: [
            "How can I improve my meditation?",
            "What is the purpose of life?",
            "How do I find inner peace?",
          ],
        }),
    });
  });

  it("renders suggested queries", async () => {
    render(<SuggestedQueries {...defaultProps} />);

    // Verify some queries are displayed (one is used as placeholder, so only 2-3 may show)
    // We check that at least some queries from the list appear
    const allQueries = defaultProps.queries;
    const displayedQueries = allQueries.filter((q) => screen.queryByText(q) !== null);
    // Should have at least 2 displayed (since one is placeholder)
    expect(displayedQueries.length).toBeGreaterThanOrEqual(2);
  });

  it("shows queries when provided", async () => {
    render(<SuggestedQueries {...defaultProps} />);

    // Verify some queries are displayed
    const allQueries = defaultProps.queries;
    const displayedQueries = allQueries.filter((q) => screen.queryByText(q) !== null);
    expect(displayedQueries.length).toBeGreaterThanOrEqual(2);
  });

  it("shows queries for sites that don't require login", async () => {
    const noLoginSiteConfig = { ...mockSiteConfig, requireLogin: false };
    const props = { ...defaultProps, siteConfig: noLoginSiteConfig };

    render(<SuggestedQueries {...props} />);

    // Verify some queries are displayed
    const allQueries = defaultProps.queries;
    const displayedQueries = allQueries.filter((q) => screen.queryByText(q) !== null);
    expect(displayedQueries.length).toBeGreaterThanOrEqual(2);
  });
});
