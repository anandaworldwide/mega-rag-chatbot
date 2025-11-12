/**
 * Test suite for the Manifest API route
 *
 * Tests cover:
 * 1. Successful manifest generation with site config
 * 2. Method validation (only GET allowed)
 * 3. Error handling when site config fails to load
 * 4. Proper headers (Content-Type, Cache-Control)
 * 5. Manifest structure validation
 * 6. Site-specific values from config
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/manifest.json";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { SiteConfig } from "@/types/siteConfig";

// Mock loadSiteConfigSync
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

describe("API Route: /api/manifest.json", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "ananda",
    shortname: "Luca",
    name: "Luca, The Ananda Devotee Chatbot",
    tagline: "Explore, Discover, Learn – Uncover the treasures of our path.",
    greeting: "Hi GuruBuddy! I'm Luca. How can I help you today?",
    emailGreeting: "Hi GuruBuddy!",
    welcome_popup_heading: "Welcome, Gurubhai!",
    other_visitors_reference: "your Gurubhais",
    chatPlaceholder: "Send a message",
    parent_site_url: "https://www.ananda.org",
    parent_site_name: "Ananda",
    help_url: "",
    help_text: "Help",
    collectionConfig: {
      master_swami: "Master and Swami",
      whole_library: "All authors",
    },
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    loginImage: "luca.png",
    header: {
      logo: "ananda-logo.png",
      navItems: [],
    },
    footer: {
      links: [],
    },
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    npsSurveyFrequencyDays: 90,
    queriesPerUserPerDay: 200,
    enableModelComparison: true,
    showSourceCountSelector: true,
    showSourceContent: true,
    showVoting: true,
    includedLibraries: ["Ananda Library"],
    enabledMediaTypes: ["text", "audio", "youtube"],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default to successful site config load
    mockLoadSiteConfigSync.mockReturnValue(mockSiteConfig);
  });

  describe("Successful manifest generation", () => {
    it("returns 200 with valid manifest structure for GET request", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);

      const manifest = JSON.parse(res._getData());

      // Verify manifest structure
      expect(manifest).toHaveProperty("name");
      expect(manifest).toHaveProperty("short_name");
      expect(manifest).toHaveProperty("description");
      expect(manifest).toHaveProperty("start_url");
      expect(manifest).toHaveProperty("display");
      expect(manifest).toHaveProperty("background_color");
      expect(manifest).toHaveProperty("theme_color");
      expect(manifest).toHaveProperty("orientation");
      expect(manifest).toHaveProperty("icons");
      expect(Array.isArray(manifest.icons)).toBe(true);
    });

    it("uses site config values for manifest fields", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.name).toBe("Luca, The Ananda Devotee Chatbot");
      expect(manifest.short_name).toBe("Luca");
      expect(manifest.description).toBe("Explore, Discover, Learn – Uncover the treasures of our path.");
    });

    it("uses default values when site config fields are missing", async () => {
      const partialConfig: Partial<SiteConfig> = {
        ...mockSiteConfig,
        name: undefined,
        shortname: undefined,
        tagline: undefined,
      };

      mockLoadSiteConfigSync.mockReturnValue(partialConfig as SiteConfig);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.name).toBe("Mega Chatbot");
      expect(manifest.short_name).toBe("Chatbot");
      expect(manifest.description).toBe("Explore, Discover, Learn");
    });

    it("includes correct icon configuration", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.icons).toHaveLength(2);
      expect(manifest.icons[0]).toEqual({
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any maskable",
      });
      expect(manifest.icons[1]).toEqual({
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      });
    });

    it("sets correct Content-Type header", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      // Spy on setHeader to verify it's called
      const setHeaderSpy = jest.spyOn(res, "setHeader");

      await handler(req, res);

      // Verify setHeader was called with Content-Type
      expect(setHeaderSpy).toHaveBeenCalledWith("Content-Type", "application/manifest+json");

      setHeaderSpy.mockRestore();
    });

    it("sets correct Cache-Control header", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.getHeader("Cache-Control")).toBe("public, max-age=3600, s-maxage=3600");
    });

    it("has correct PWA manifest properties", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.start_url).toBe("/");
      expect(manifest.display).toBe("standalone");
      expect(manifest.background_color).toBe("#ffffff");
      expect(manifest.theme_color).toBe("#ff6b35");
      expect(manifest.orientation).toBe("portrait-primary");
    });
  });

  describe("Method validation", () => {
    it("returns 405 for POST requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Method not allowed",
      });
    });

    it("returns 405 for PUT requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PUT",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Method not allowed",
      });
    });

    it("returns 405 for DELETE requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Method not allowed",
      });
    });
  });

  describe("Error handling", () => {
    it("returns 500 when site config fails to load", async () => {
      mockLoadSiteConfigSync.mockReturnValue(null);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Failed to load site configuration",
      });
    });

    it("calls loadSiteConfigSync", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(mockLoadSiteConfigSync).toHaveBeenCalledTimes(1);
      expect(mockLoadSiteConfigSync).toHaveBeenCalledWith();
    });
  });

  describe("Site-specific configurations", () => {
    it("generates manifest for different site configs", async () => {
      const crystalConfig: SiteConfig = {
        ...mockSiteConfig,
        siteId: "crystal",
        shortname: "Library Magic",
        name: "Crystal Clarity Library Magic",
        tagline: "Explore the Crystal Clarity Library",
      };

      mockLoadSiteConfigSync.mockReturnValue(crystalConfig);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.name).toBe("Crystal Clarity Library Magic");
      expect(manifest.short_name).toBe("Library Magic");
      expect(manifest.description).toBe("Explore the Crystal Clarity Library");
    });

    it("generates manifest for ananda-public site", async () => {
      const anandaPublicConfig: SiteConfig = {
        ...mockSiteConfig,
        siteId: "ananda-public",
        shortname: "Vivek",
        name: "Vivek, The Ananda.org Chatbot",
        tagline: "Explore, Discover, Learn – Uncover the treasures of our path.",
      };

      mockLoadSiteConfigSync.mockReturnValue(anandaPublicConfig);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const manifest = JSON.parse(res._getData());

      expect(manifest.name).toBe("Vivek, The Ananda.org Chatbot");
      expect(manifest.short_name).toBe("Vivek");
    });
  });
});
