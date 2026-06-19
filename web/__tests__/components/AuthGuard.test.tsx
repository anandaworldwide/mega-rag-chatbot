/**
 * AuthGuard Component Tests
 *
 * Tests for the AuthGuard component that prevents content flash during authentication checks
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { useRouter } from "next/router";
import AuthGuard from "@/components/AuthGuard";
import { isPublicPage } from "@/utils/client/authConfig";
import { initializeTokenManager, isAuthenticated, AuthenticationError } from "@/utils/client/tokenManager";

// Mock dependencies
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/utils/client/authConfig", () => ({
  isPublicPage: jest.fn(),
}));

jest.mock("@/utils/client/tokenManager", () => {
  const actual = jest.requireActual("@/utils/client/tokenManager");
  return {
    initializeTokenManager: jest.fn(),
    isAuthenticated: jest.fn(),
    // Export the real AuthenticationError class so instanceof checks work
    AuthenticationError: actual.AuthenticationError,
  };
});

// Mock fetch globally
global.fetch = jest.fn();

describe("AuthGuard", () => {
  const mockPush = jest.fn();
  const mockReplace = jest.fn();
  const mockRouter = {
    asPath: "/",
    isReady: true,
    push: mockPush,
    replace: mockReplace,
  };

  const mockSiteConfig = {
    siteId: "test",
    shortname: "Test",
    name: "Test Site",
    tagline: "Test tagline",
    greeting: "Test greeting",
    requireLogin: true,
    parent_site_url: "https://example.com",
    parent_site_name: "Example",
    help_url: "https://example.com/help",
    help_text: "Help",
    enableGeoAwareness: false,
    excludedAccessLevels: [],
    accessLevelPathMap: {},
    pineconeNamespace: "test",
    systemPromptFile: "test.txt",
    systemPromptData: {},
    enableChatHistory: true,
    enableRelatedQuestions: true,
    enableSourceCitations: true,
    enableAudioPlayer: false,
    enableDownloadPdf: false,
    enableNPS: false,
    enableFeedback: true,
    maxTokens: 1000,
    temperature: 0.7,
    topP: 1.0,
    enableReranking: false,
    rerankingModel: null,
    enableCrossEncoder: false,
    crossEncoderModel: null,
    crossEncoderTopK: 10,
    enableUserLogin: true,
    enableSelfProvision: false,
    enableSelfProvisionAdmin: false,
    enableSelfProvisionAdminCode: false,
    enableMagicLogin: true,
    enablePasswordLogin: false,
    enableSharedPassword: false,
    sharedPassword: null,
    enableGoogleAuth: false,
    googleClientId: null,
    enableFacebookAuth: false,
    facebookAppId: null,
    enableTwitterAuth: false,
    twitterApiKey: null,
    enableLinkedInAuth: false,
    linkedInClientId: null,
    enableGitHubAuth: false,
    gitHubClientId: null,
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
    (isPublicPage as jest.Mock).mockReturnValue(false);

    // Default to successful authentication
    (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
    (isAuthenticated as jest.Mock).mockReturnValue(true);

    // Default to successful fetch response (for backwards compatibility)
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });
  });

  const TestComponent = () => <div>Protected Content</div>;

  it("shows nothing initially, then loading spinner after 2 seconds", async () => {
    jest.useFakeTimers();

    // Mock fetch to never resolve (simulating slow auth)
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    // Initially should show nothing (blank)
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();

    // Fast-forward 2 seconds and flush updates
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // Now should show loading spinner
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();

    jest.useRealTimers();
  });

  it("renders children for public pages without auth check", async () => {
    (isPublicPage as jest.Mock).mockReturnValue(true);

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });

    // Should not have called fetch for authentication
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("renders children when site does not require login", async () => {
    const noLoginSiteConfig = { ...mockSiteConfig, requireLogin: false };

    render(
      <AuthGuard siteConfig={noLoginSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });

    // Should not have called fetch for authentication
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("renders children when authentication succeeds", async () => {
    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });

    expect(initializeTokenManager).toHaveBeenCalled();
    expect(isAuthenticated).toHaveBeenCalled();
  });

  it("redirects to login when authentication fails with 401", async () => {
    // Mock authentication failure - isAuthenticated returns false
    (isAuthenticated as jest.Mock).mockReturnValue(false);
    (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
    mockRouter.asPath = "/protected-page?param=value";

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/login?redirect=%2Fprotected-page%3Fparam%3Dvalue");
    });

    // Should not render children during redirect (may or may not show loading)
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
  });

  it("redirects to login when token fetch throws AuthenticationError", async () => {
    // Use fake timers to control async delays
    jest.useFakeTimers();

    // Mock token fetch throwing AuthenticationError on all attempts
    const authError = new AuthenticationError("Session expired", 401, true);
    (initializeTokenManager as jest.Mock).mockRejectedValue(authError);
    mockRouter.asPath = "/protected-page?param=value";

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    // Run through all the async operations and timers
    // Each retry has a delay: 500ms, 1000ms for attempts 1 and 2
    await act(async () => {
      // First attempt and its delay
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });

    await act(async () => {
      // Second attempt and its delay
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
    });

    await act(async () => {
      // Third attempt (no delay, should redirect)
      await Promise.resolve();
      jest.advanceTimersByTime(100);
    });

    // Check that redirect was called
    expect(mockReplace).toHaveBeenCalledWith("/login?redirect=%2Fprotected-page%3Fparam%3Dvalue");
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();

    jest.useRealTimers();
  });

  it("handles network errors gracefully", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    await waitFor(() => {
      // Should not render children on network error
      expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    });
  });

  it("waits for router to be ready before checking auth", () => {
    const mockRouterNotReady = { ...mockRouter, isReady: false };
    (useRouter as jest.Mock).mockReturnValue(mockRouterNotReady);

    render(
      <AuthGuard siteConfig={mockSiteConfig}>
        <TestComponent />
      </AuthGuard>
    );

    // Should show nothing initially when router not ready and not call fetch
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("waits for siteConfig before checking auth", () => {
    render(
      <AuthGuard siteConfig={null}>
        <TestComponent />
      </AuthGuard>
    );

    // Should show nothing initially and not call fetch
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe("Browser Session Restoration", () => {
    let originalCookie: string;

    beforeEach(() => {
      // Save original cookie
      originalCookie = document.cookie;
    });

    afterEach(() => {
      // Restore original cookie
      Object.defineProperty(document, "cookie", {
        writable: true,
        value: originalCookie,
      });
    });

    it("handles browser session restoration with authToken cookie", async () => {
      // Mock successful token refresh after retries
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(false); // Initial check
      (isAuthenticated as jest.Mock).mockReturnValueOnce(true); // After refresh

      // Set up auth cookies by directly setting document.cookie
      document.cookie = "authToken=mock-jwt-token";

      render(
        <AuthGuard siteConfig={mockSiteConfig}>
          <TestComponent />
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeInTheDocument();
      });

      // Should have attempted token refresh multiple times
      expect(initializeTokenManager).toHaveBeenCalled();
    });

    it("handles browser session restoration with authToken cookie", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(false);
      (isAuthenticated as jest.Mock).mockReturnValueOnce(true);

      document.cookie = "authToken=valid-jwt-token";

      render(
        <AuthGuard siteConfig={mockSiteConfig}>
          <TestComponent />
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeInTheDocument();
      });

      expect(initializeTokenManager).toHaveBeenCalled();
    });

    it("handles browser session restoration with hasSession cookie", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(false);
      (isAuthenticated as jest.Mock).mockReturnValueOnce(true);

      document.cookie = "hasSession=1";

      render(
        <AuthGuard siteConfig={mockSiteConfig}>
          <TestComponent />
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeInTheDocument();
      });

      expect(initializeTokenManager).toHaveBeenCalled();
    });

    it("does not attempt restoration for public pages", async () => {
      (isPublicPage as jest.Mock).mockReturnValue(true);
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);

      document.cookie = "authToken=mock-jwt-token";

      render(
        <AuthGuard siteConfig={mockSiteConfig}>
          <TestComponent />
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeInTheDocument();
      });

      // For public pages, initializeTokenManager should not be called
      expect(initializeTokenManager).not.toHaveBeenCalled();
    });

    it("does not attempt restoration for sites without login requirement", async () => {
      const noLoginSiteConfig = { ...mockSiteConfig, requireLogin: false };

      document.cookie = "authToken=mock-jwt-token";

      render(
        <AuthGuard siteConfig={noLoginSiteConfig}>
          <TestComponent />
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeInTheDocument();
      });

      // For sites without login, initializeTokenManager should not be called
      expect(initializeTokenManager).not.toHaveBeenCalled();
    });
  });
});
