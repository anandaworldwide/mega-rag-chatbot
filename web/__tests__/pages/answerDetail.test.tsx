/**
 * Tests for the single answer page component
 *
 * This file tests the functionality of the answer detail page,
 * particularly focusing on the JWT auth issues.
 */

import { render, screen } from "@testing-library/react";
import SingleAnswer from "@/pages/answers/[answerId]";
import { SiteConfig } from "@/types/siteConfig";
import { useRouter } from "next/router";
import { useSudo } from "@/contexts/SudoContext";
import React from "react";

// Mock the components that use react-markdown to avoid ESM issues
jest.mock("@/components/TruncatedMarkdown", () => ({
  __esModule: true,
  default: ({ markdown }: { markdown: string }) => <div data-testid="mocked-markdown">{markdown.substring(0, 50)}</div>,
}));

jest.mock("@/components/SourcesList", () => ({
  __esModule: true,
  default: () => <div data-testid="mocked-sources">Mocked Sources</div>,
}));

jest.mock("@/components/CopyButton", () => ({
  __esModule: true,
  default: () => <button data-testid="mocked-copy-button">Copy</button>,
}));

// Mock the next/router
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

// Mock SudoContext
jest.mock("@/contexts/SudoContext", () => ({
  useSudo: jest.fn(),
}));

// Mock the reactQueryConfig module to simulate auth failure
jest.mock("@/utils/client/reactQueryConfig", () => ({
  queryFetch: jest.fn().mockImplementation(() => {
    throw new Error("(0 , _tokenManager.withAuth) is not a function");
  }),
  createQueryClient: jest.fn(),
}));

// Mock various parts of the app

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue("test-uuid"),
}));

describe("SingleAnswer page", () => {
  // Sample site config matching the actual type
  const mockSiteConfig = {
    siteId: "test",
    shortname: "Test",
    name: "Test Site",
    tagline: "Testing",
    greeting: "Hello",
    parent_site_url: "https://example.com",
    parent_site_name: "Example",
    help_url: "https://example.com/help",
    help_text: "Help",
    allowAllAnswersPage: true,
    header: {
      logo: "",
      navItems: [],
    },
    footer: {
      links: [],
    },
    requireLogin: false,
    allowTemporarySessions: true,
    queriesPerUserPerDay: 100,
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: false,
    enableMediaTypeSelection: false,
    enableAuthorSelection: false,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "Others",
    loginImage: null,
    showSourceCountSelector: false,
    temperature: 0.7,
    modelName: "gpt-3.5-turbo",
    enabledMediaTypes: ["text", "audio", "youtube"],
    defaultNumSources: 6,
    showRelatedQuestions: true,
    showSourceContent: true,
    showVoting: true,
    chatPlaceholder: "",
  } as SiteConfig;

  beforeEach(() => {
    // Mock router with all necessary methods
    (useRouter as jest.Mock).mockReturnValue({
      query: { answerId: "test-id" },
      replace: jest.fn(),
      push: jest.fn(),
      back: jest.fn(),
      asPath: "/share/test-id",
    });

    // Mock sudo context
    (useSudo as jest.Mock).mockReturnValue({
      isSudoUser: false,
      checkSudoStatus: jest.fn(),
    });
  });

  test("Shows redirect message when accessing answer detail page", async () => {
    // Render the component
    render(<SingleAnswer siteConfig={mockSiteConfig} />);

    // Verify redirect message appears
    const redirectElement = await screen.findByText("Redirecting...");
    expect(redirectElement).toBeInTheDocument();

    // Verify loading spinner is present
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });
});
