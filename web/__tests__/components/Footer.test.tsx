/**
 * Footer Component Tests
 *
 * Tests for the Footer component including footer links rendering.
 * Note: Admin section has been moved to ChatHistorySidebar (for admin dashboard)
 * and AdminLayout (for view all answers).
 */

import { render, screen, waitFor } from "@testing-library/react";
import Footer from "@/components/Footer";

// Mock dependencies
jest.mock("next/link", () => {
  return ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href} data-testid="next-link">
      {children}
    </a>
  );
});

describe("Footer", () => {
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
});
