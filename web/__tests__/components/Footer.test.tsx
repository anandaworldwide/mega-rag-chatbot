/**
 * Footer Component Tests
 *
 * Tests for the Footer component including admin section visibility,
 * role-based rendering, footer links, and token initialization handling.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { useRouter } from "next/router";
import Footer from "@/components/Footer";
import { initializeTokenManager, isAuthenticated } from "@/utils/client/tokenManager";
import { useSudo } from "@/contexts/SudoContext";

// Mock dependencies
jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("next/link", () => {
  return ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href} data-testid="next-link">
      {children}
    </a>
  );
});

jest.mock("@/contexts/SudoContext", () => ({
  useSudo: jest.fn(),
}));

jest.mock("@/utils/client/tokenManager", () => ({
  initializeTokenManager: jest.fn(),
  isAuthenticated: jest.fn(),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe("Footer", () => {
  const mockRouter = {
    asPath: "/",
    isReady: true,
  };

  const baseSiteConfig = {
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
    footer: {
      links: [
        { label: "Help", url: "/help" },
        { label: "Contact", url: "https://example.com/contact" },
      ],
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue(mockRouter);
    (useSudo as jest.Mock).mockReturnValue({ isSudoUser: false });
    (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
    (isAuthenticated as jest.Mock).mockReturnValue(false);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ role: "user" }),
    });

    // Clear sessionStorage
    sessionStorage.clear();
  });

  describe("Footer Links Rendering", () => {
    it("renders footer links from config", async () => {
      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Help")).toBeInTheDocument();
        expect(screen.getByText("Contact")).toBeInTheDocument();
      });
    });

    it("renders internal links using Next Link", async () => {
      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        const helpLink = screen.getByText("Help").closest("a");
        expect(helpLink).toHaveAttribute("href", "/help");
        expect(helpLink).toHaveAttribute("data-testid", "next-link");
      });
    });

    it("renders external links as anchor tags", async () => {
      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        const contactLink = screen.getByText("Contact").closest("a");
        expect(contactLink).toHaveAttribute("href", "https://example.com/contact");
      });
    });

    it("renders non-clickable text when no URL provided", async () => {
      const configWithTextOnly = {
        ...baseSiteConfig,
        footer: {
          links: [{ label: "Version 1.0" }],
        },
      };

      render(<Footer siteConfig={configWithTextOnly} />);

      await waitFor(() => {
        const textElement = screen.getByText("Version 1.0");
        expect(textElement.tagName.toLowerCase()).toBe("span");
      });
    });

    it("applies default icons based on label", async () => {
      const configWithLabels = {
        ...baseSiteConfig,
        footer: {
          links: [
            { label: "Help", url: "/help" },
            { label: "Contact", url: "/contact" },
            { label: "Open Source", url: "/oss" },
            { label: "Compare AI Models", url: "/compare" },
          ],
        },
      };

      render(<Footer siteConfig={configWithLabels} />);

      await waitFor(() => {
        expect(screen.getByText("help_outline")).toBeInTheDocument();
        expect(screen.getByText("mail_outline")).toBeInTheDocument();
        expect(screen.getByText("code")).toBeInTheDocument();
        expect(screen.getByText("compare")).toBeInTheDocument();
      });
    });

    it("uses custom icon when provided in config", async () => {
      const configWithCustomIcon = {
        ...baseSiteConfig,
        footer: {
          links: [{ label: "Custom", url: "/custom", icon: "custom_icon" }],
        },
      };

      render(<Footer siteConfig={configWithCustomIcon} />);

      await waitFor(() => {
        expect(screen.getByText("custom_icon")).toBeInTheDocument();
      });
    });

    it("renders empty footer when no links configured", async () => {
      const configWithNoLinks = {
        ...baseSiteConfig,
        footer: { links: [] },
      };

      render(<Footer siteConfig={configWithNoLinks} />);

      // Footer element should still exist
      await waitFor(() => {
        expect(screen.getByRole("contentinfo")).toBeInTheDocument();
      });
    });

    it("renders default footer when siteConfig is null", async () => {
      render(<Footer siteConfig={null} />);

      // Should render without crashing
      await waitFor(() => {
        expect(screen.getByRole("contentinfo")).toBeInTheDocument();
      });
    });
  });

  describe("Admin Section Visibility - Login Required Sites", () => {
    it("shows admin section for admin users", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });
    });

    it("shows admin section for superuser users", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "superuser" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
        expect(screen.getByText("View all answers")).toBeInTheDocument();
      });
    });

    it("does not show admin section for regular users", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "user" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for role check to complete
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/profile", { credentials: "include" });
      });

      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    });

    it("does not show admin section when user not authenticated", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(false);

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for initial render to settle
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
      // Should not call profile API when not authenticated
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("shows View all answers link only for superusers (not admins)", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });

      // Admin should NOT see View all answers
      expect(screen.queryByText("View all answers")).not.toBeInTheDocument();
    });
  });

  describe("Admin Section Visibility - No Login Required Sites", () => {
    const noLoginSiteConfig = { ...baseSiteConfig, requireLogin: false };

    it("shows admin section for sudo users when site does not require login", async () => {
      (useSudo as jest.Mock).mockReturnValue({ isSudoUser: true });

      render(<Footer siteConfig={noLoginSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
        expect(screen.getByText("View all answers")).toBeInTheDocument();
      });
    });

    it("does not show admin section when not sudo user on no-login site", async () => {
      (useSudo as jest.Mock).mockReturnValue({ isSudoUser: false });

      render(<Footer siteConfig={noLoginSiteConfig} />);

      // Wait for initial render
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    });

    it("does not call profile API when site does not require login", async () => {
      (useSudo as jest.Mock).mockReturnValue({ isSudoUser: false });

      render(<Footer siteConfig={noLoginSiteConfig} />);

      // Wait for initial render
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(initializeTokenManager).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("Token Initialization Race Condition Fix", () => {
    it("waits for initializeTokenManager before checking authentication", async () => {
      let tokenInitialized = false;
      (initializeTokenManager as jest.Mock).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        tokenInitialized = true;
      });
      (isAuthenticated as jest.Mock).mockImplementation(() => tokenInitialized);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      // Should not show admin section immediately
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();

      // After token initialization completes
      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });

      expect(initializeTokenManager).toHaveBeenCalled();
    });

    it("handles token initialization failure gracefully", async () => {
      (initializeTokenManager as jest.Mock).mockRejectedValue(new Error("Token fetch failed"));

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for initialization attempt
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Should not crash and should not show admin section
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    });
  });

  describe("Session Storage Caching", () => {
    it("uses cached role when valid", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);

      // Pre-populate cache with admin role
      sessionStorage.setItem(
        "userRole",
        JSON.stringify({
          role: "admin",
          timestamp: Date.now(),
        })
      );

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });

      // Should NOT call fetch API when cache is valid
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("fetches fresh role when cache is expired", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      // Pre-populate cache with expired timestamp (2 minutes ago)
      sessionStorage.setItem(
        "userRole",
        JSON.stringify({
          role: "user",
          timestamp: Date.now() - 2 * 60 * 1000,
        })
      );

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/profile", { credentials: "include" });
      });
    });

    it("clears cache when user is not authenticated", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(false);

      // Pre-populate cache
      sessionStorage.setItem(
        "userRole",
        JSON.stringify({
          role: "admin",
          timestamp: Date.now(),
        })
      );

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for initial check
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Cache should be cleared
      expect(sessionStorage.getItem("userRole")).toBeNull();
    });

    it("caches role after successful API fetch", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "superuser" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });

      // Check cache was set
      const cached = JSON.parse(sessionStorage.getItem("userRole") || "{}");
      expect(cached.role).toBe("superuser");
      expect(cached.timestamp).toBeDefined();
    });
  });

  describe("API Error Handling", () => {
    it("handles profile API failure gracefully", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for API call
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });

      // Should not show admin section on API failure
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
      // Footer should still render
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    });

    it("handles network error gracefully", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for API call attempt
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Should not show admin section
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
      // Footer should still render
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    });
  });

  describe("Storage Event Listener", () => {
    it("re-checks role when userRole storage changes", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "user" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      // Wait for initial render - user role means no admin section
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();

      // Clear cache and update mock to return admin
      sessionStorage.clear();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      // Simulate storage event from another tab
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "userRole",
            newValue: JSON.stringify({ role: "admin", timestamp: Date.now() }),
          })
        );
      });

      // Should re-check role and show admin section
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });
    });

    it("ignores storage events for other keys", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      // Simulate storage event for a different key
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "otherKey",
            newValue: "some value",
          })
        );
      });

      // Wait a tick
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Should NOT have made another API call
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("Route Change Behavior", () => {
    it("re-checks role when route changes and cache is expired", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      const { rerender } = render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      // Clear the cache that was set by first render (simulating expiration)
      sessionStorage.clear();

      // Simulate route change by updating the router mock
      (useRouter as jest.Mock).mockReturnValue({ ...mockRouter, asPath: "/new-page" });

      rerender(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });
    });

    it("uses cached role on route change when cache is still valid", async () => {
      (initializeTokenManager as jest.Mock).mockResolvedValue(undefined);
      (isAuthenticated as jest.Mock).mockReturnValue(true);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ role: "admin" }),
      });

      const { rerender } = render(<Footer siteConfig={baseSiteConfig} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      // Cache should still be valid - do NOT clear it

      // Simulate route change
      (useRouter as jest.Mock).mockReturnValue({ ...mockRouter, asPath: "/new-page" });

      rerender(<Footer siteConfig={baseSiteConfig} />);

      // Should still show admin from cache, NOT make another API call
      await waitFor(() => {
        expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
      });

      // Still only 1 call because cache was used
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
