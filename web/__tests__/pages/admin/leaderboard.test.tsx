import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import AdminLeaderboardPage from "@/pages/admin/leaderboard";
import { getToken } from "@/utils/client/tokenManager";

// Mock dependencies
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn(),
  initializeTokenManager: jest.fn().mockResolvedValue(undefined),
  isAuthenticated: jest.fn().mockReturnValue(true),
}));

// Mock the AdminLayout component to avoid complex dependency issues
jest.mock("@/components/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="admin-layout">{children}</div>,
}));

// Mock fetch globally
global.fetch = jest.fn();

const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;
const mockGetToken = getToken as jest.MockedFunction<typeof getToken>;
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

// Set up router mock implementation
mockUseRouter.mockReturnValue({
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  query: {},
  asPath: "/",
  events: {
    on: jest.fn(),
    off: jest.fn(),
  },
} as any);

const mockSiteConfig = {
  siteId: "ananda",
  shortname: "ananda",
  name: "Ananda Library",
  tagline: "Test tagline",
  greeting: "Test greeting",
  parent_site_url: "https://ananda.org",
  parent_site_name: "Ananda",
  help_url: "https://ananda.org/help",
  help_text: "Help text",
  collectionConfig: {},
  libraryMappings: {},
  enableSuggestedQueries: false,
  enableMediaTypeSelection: false,
  enableAuthorSelection: false,
  welcome_popup_heading: "Welcome",
  other_visitors_reference: "other visitors",
  loginImage: null,
  header: { logo: "ananda.png", navItems: [] },
  footer: { links: [] },
  requireLogin: true,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  npsSurveyFrequencyDays: 30,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: true,
};

// Helper function to render component (simplified since Layout is mocked)
const renderWithProviders = (component: React.ReactElement) => {
  return render(component);
};

const mockLeaderboardData = {
  users: [
    {
      email: "user1@example.com",
      firstName: "John",
      lastName: "Doe",
      uuid: "uuid-1",
      questionCount: 150,
      displayName: "John Doe",
    },
    {
      email: "user2@example.com",
      firstName: "Jane",
      lastName: "Smith",
      uuid: "uuid-2",
      questionCount: 120,
      displayName: "Jane Smith",
    },
    {
      email: "user3@example.com",
      firstName: null,
      lastName: null,
      uuid: "uuid-3",
      questionCount: 95,
      displayName: "user3@example.com",
    },
  ],
};

describe("AdminLeaderboardPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRouter.mockReturnValue({
      push: jest.fn(),
      replace: jest.fn(),
      back: jest.fn(),
      query: {},
      asPath: "/admin/leaderboard",
    } as any);
    mockGetToken.mockResolvedValue("valid-jwt-token");
  });

  it("should render loading state initially", () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    expect(screen.getByText("Loading leaderboard...")).toBeInTheDocument();
  });

  it("should render leaderboard with user data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockLeaderboardData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    // Wait for component to render
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "User Leaderboard" })).toBeInTheDocument();
    });

    // Verify that the fetch was called with correct parameters (defaults to 30days)
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/leaderboard?timePeriod=30days", {
      headers: {
        Authorization: "Bearer valid-jwt-token",
      },
    });
  });

  it("should render trophy icons for top 3 users", async () => {
    mockGetToken.mockResolvedValue("valid-jwt-token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockLeaderboardData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "User Leaderboard" })).toBeInTheDocument();
    });

    // Verify API call was made (defaults to 30days)
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/leaderboard?timePeriod=30days", expect.any(Object));
  });

  it("should render clickable user links", async () => {
    mockGetToken.mockResolvedValue("valid-jwt-token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockLeaderboardData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "User Leaderboard" })).toBeInTheDocument();
    });

    // Verify API call was made (defaults to 30days)
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/leaderboard?timePeriod=30days", expect.any(Object));
  });

  it("should handle empty leaderboard", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ users: [] }),
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByText("No users with questions found.")).toBeInTheDocument();
    });
  });

  it("should handle API errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch leaderboard: 500/)).toBeInTheDocument();
    });
  });

  it("should handle 403 forbidden errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByText("Access denied. Admin privileges required.")).toBeInTheDocument();
    });
  });

  it("should handle network errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("should not fetch data when no JWT token", () => {
    mockGetToken.mockRejectedValue(new Error("No token available"));

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText("Loading leaderboard...")).toBeInTheDocument();
  });

  it("should include JWT token in API request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockLeaderboardData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/admin/leaderboard?timePeriod=30days", {
        headers: {
          Authorization: "Bearer valid-jwt-token",
        },
      });
    });
  });

  it("should format question counts with locale string", async () => {
    const largeCountData = {
      users: [
        {
          email: "user@example.com",
          firstName: "John",
          lastName: "Doe",
          uuid: "uuid-1",
          questionCount: 1234,
          displayName: "John Doe",
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => largeCountData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      // Should format 1234 as "1,234"
      expect(screen.getByText("1,234")).toBeInTheDocument();
    });
  });

  it("should render page title and description", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockLeaderboardData,
    } as Response);

    renderWithProviders(<AdminLeaderboardPage siteConfig={mockSiteConfig} isSudoAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "User Leaderboard" })).toBeInTheDocument();
      expect(screen.getByText("Top 20 users by number of questions asked")).toBeInTheDocument();
    });
  });
});
