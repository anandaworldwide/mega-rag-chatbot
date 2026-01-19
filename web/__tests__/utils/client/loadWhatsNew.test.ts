/**
 * Tests for loadWhatsNew utility functions
 */

import { loadSiteWhatsNew, isWhatsNewAvailable } from "@/utils/client/loadWhatsNew";
import { SiteConfig } from "@/types/siteConfig";

// Mock fetch globally
global.fetch = jest.fn();

describe("loadWhatsNew", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "ananda",
    shortname: "Luca",
    name: "Luca, The Ananda Devotee Chatbot",
    tagline: "Test tagline",
    greeting: "Test greeting",
    parent_site_url: "https://example.com",
    parent_site_name: "Example",
    help_url: "",
    help_text: "",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "visitors",
    loginImage: null,
    header: { logo: "logo.png", navItems: [] },
    footer: { links: [] },
    requireLogin: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    queriesPerUserPerDay: 200,
    showSourceContent: true,
    showVoting: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("loadSiteWhatsNew", () => {
    it("should load What's New content successfully", async () => {
      const mockWhatsNewData = {
        version: 2,
        wikiUrl: "https://anandafamily.notion.site/whats-new",
        entries: [
          {
            date: "2026-01-19",
            title: "Task Wizard",
            description: "New structured task wizards help you create comprehensive research queries.",
          },
        ],
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockWhatsNewData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/whats-new.json");
      expect(result).toEqual(mockWhatsNewData);
    });

    it("should return null when What's New file doesn't exist", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/whats-new.json");
      expect(result).toBeNull();
    });

    it("should return null when siteConfig is null", async () => {
      const result = await loadSiteWhatsNew(null);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should return null when siteId is missing", async () => {
      const configWithoutSiteId = { ...mockSiteConfig, siteId: "" };
      const result = await loadSiteWhatsNew(configWithoutSiteId);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should handle fetch errors gracefully", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      (fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to load What's New for site ananda:",
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it("should return null for invalid data structure - missing version", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const invalidData = {
        wikiUrl: "https://anandafamily.notion.site/whats-new",
        entries: [],
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invalidData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Invalid What's New format for site ananda"
      );

      consoleErrorSpy.mockRestore();
    });

    it("should return null for invalid data structure - missing wikiUrl", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const invalidData = {
        version: 1,
        entries: [],
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invalidData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Invalid What's New format for site ananda"
      );

      consoleErrorSpy.mockRestore();
    });

    it("should return null for invalid data structure - missing entries array", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const invalidData = {
        version: 1,
        wikiUrl: "https://anandafamily.notion.site/whats-new",
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invalidData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Invalid What's New format for site ananda"
      );

      consoleErrorSpy.mockRestore();
    });

    it("should return null for invalid data structure - entries not an array", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const invalidData = {
        version: 1,
        wikiUrl: "https://anandafamily.notion.site/whats-new",
        entries: "not an array",
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invalidData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Invalid What's New format for site ananda"
      );

      consoleErrorSpy.mockRestore();
    });

    it("should handle valid data with multiple entries", async () => {
      const mockWhatsNewData = {
        version: 3,
        wikiUrl: "https://anandafamily.notion.site/whats-new",
        entries: [
          {
            date: "2026-01-19",
            title: "Task Wizard",
            description: "New structured task wizards.",
          },
          {
            date: "2026-01-18",
            title: "AI Model Selection",
            description: "Choose different AI models.",
          },
        ],
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockWhatsNewData),
      });

      const result = await loadSiteWhatsNew(mockSiteConfig);

      expect(result).toEqual(mockWhatsNewData);
      expect(result?.entries).toHaveLength(2);
    });
  });

  describe("isWhatsNewAvailable", () => {
    it("should return true when What's New file exists", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      const result = await isWhatsNewAvailable(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/whats-new.json", { method: "HEAD" });
      expect(result).toBe(true);
    });

    it("should return false when What's New file doesn't exist", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await isWhatsNewAvailable(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/whats-new.json", { method: "HEAD" });
      expect(result).toBe(false);
    });

    it("should return false when siteConfig is null", async () => {
      const result = await isWhatsNewAvailable(null);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("should return false when siteId is missing", async () => {
      const configWithoutSiteId = { ...mockSiteConfig, siteId: "" };
      const result = await isWhatsNewAvailable(configWithoutSiteId);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("should return false on fetch errors", async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const result = await isWhatsNewAvailable(mockSiteConfig);

      expect(result).toBe(false);
    });
  });
});
