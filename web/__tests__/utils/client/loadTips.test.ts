/**
 * Tests for loadTips utility functions
 */

import { loadSiteTips, parseTipsContent, areTipsAvailable } from "@/utils/client/loadTips";
import { SiteConfig } from "@/types/siteConfig";

// Mock fetch globally
global.fetch = jest.fn();

describe("loadTips", () => {
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

  describe("loadSiteTips", () => {
    it("should load tips content successfully with default version", async () => {
      const mockTipsContent = "Getting Better Answers\n\nTurn off audio sources for clearer answers.";

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockTipsContent),
      });

      const result = await loadSiteTips(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/tips.txt");
      expect(result).toEqual({
        version: 1,
        content: mockTipsContent,
      });
    });

    it("should parse version from header", async () => {
      const mockTipsContent = "VERSION: 3\n\nGetting Better Answers\n\nTurn off audio sources for clearer answers.";

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockTipsContent),
      });

      const result = await loadSiteTips(mockSiteConfig);

      expect(result).toEqual({
        version: 3,
        content: "Getting Better Answers\n\nTurn off audio sources for clearer answers.",
      });
    });

    it("should return null when tips file doesn't exist", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await loadSiteTips(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/tips.txt");
      expect(result).toBeNull();
    });

    it("should return null when siteConfig is null", async () => {
      const result = await loadSiteTips(null);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should return null when siteId is missing", async () => {
      const configWithoutSiteId = { ...mockSiteConfig, siteId: "" };
      const result = await loadSiteTips(configWithoutSiteId);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should handle fetch errors gracefully", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      (fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const result = await loadSiteTips(mockSiteConfig);

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to load tips for site ananda:", expect.any(Error));

      consoleErrorSpy.mockRestore();
    });

    it("should trim whitespace from tips content", async () => {
      const mockTipsContent = "  \n  Tips content with whitespace  \n  ";

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockTipsContent),
      });

      const result = await loadSiteTips(mockSiteConfig);

      expect(result).toEqual({
        version: 1,
        content: "Tips content with whitespace",
      });
    });
  });

  describe("parseTipsContent", () => {
    it("should parse tips content into individual tip objects", () => {
      const content = `Getting Better Answers from Luca

If you're getting unclear or rambling answers that seem murky, try turning off audio and video sources in the Chat Options. Since these are transcriptions of talks, they may not be as crisp and focused as the written sources.

The written materials in our library have been carefully edited and structured, making them ideal for getting precise, clear answers to your spiritual questions.

You can access Chat Options by clicking the "Chat Options" button below the text input area, then uncheck "Audio" and "Video" to focus on written sources only.

---

Exploring Source Content

Click on any of the sources at the top of an answer to see the exact excerpt that matched your question. If the source has associated video or audio content, you'll see a media player that's automatically queued up to the moment of the match, so you can hear or watch the relevant portion directly.

---

Multilingual Support

You can ask questions in different languages - Luca understands and can respond in multiple languages to help make spiritual teachings accessible to everyone.

---

Better Questions

Ask complete questions rather than just search terms. Instead of "meditation techniques," try "What are some effective meditation techniques for beginners?" for more helpful and detailed responses.`;

      const result = parseTipsContent(content);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        title: "Getting Better Answers from Luca",
        content: `If you're getting unclear or rambling answers that seem murky, try turning off audio and video sources in the Chat Options. Since these are transcriptions of talks, they may not be as crisp and focused as the written sources.

The written materials in our library have been carefully edited and structured, making them ideal for getting precise, clear answers to your spiritual questions.

You can access Chat Options by clicking the "Chat Options" button below the text input area, then uncheck "Audio" and "Video" to focus on written sources only.`,
      });
      expect(result[1]).toEqual({
        title: "Exploring Source Content",
        content:
          "Click on any of the sources at the top of an answer to see the exact excerpt that matched your question. If the source has associated video or audio content, you'll see a media player that's automatically queued up to the moment of the match, so you can hear or watch the relevant portion directly.",
      });
      expect(result[2]).toEqual({
        title: "Multilingual Support",
        content:
          "You can ask questions in different languages - Luca understands and can respond in multiple languages to help make spiritual teachings accessible to everyone.",
      });
      expect(result[3]).toEqual({
        title: "Better Questions",
        content:
          'Ask complete questions rather than just search terms. Instead of "meditation techniques," try "What are some effective meditation techniques for beginners?" for more helpful and detailed responses.',
      });
    });

    it("should return empty array for empty content", () => {
      const result = parseTipsContent("");
      expect(result).toEqual([]);
    });

    it("should handle single tip without separator", () => {
      const content = `Single Tip

This is just one tip.`;
      const result = parseTipsContent(content);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        title: "Single Tip",
        content: "This is just one tip.",
      });
    });

    it("should remove trailing colon from titles", () => {
      const content = `Title with Colon:

Content here.`;
      const result = parseTipsContent(content);

      expect(result[0].title).toBe("Title with Colon");
    });
  });

  describe("areTipsAvailable", () => {
    it("should return true when tips file exists", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      const result = await areTipsAvailable(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/tips.txt", { method: "HEAD" });
      expect(result).toBe(true);
    });

    it("should return false when tips file doesn't exist", async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await areTipsAvailable(mockSiteConfig);

      expect(fetch).toHaveBeenCalledWith("/data/ananda/tips.txt", { method: "HEAD" });
      expect(result).toBe(false);
    });

    it("should return false when siteConfig is null", async () => {
      const result = await areTipsAvailable(null);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("should return false when siteId is missing", async () => {
      const configWithoutSiteId = { ...mockSiteConfig, siteId: "" };
      const result = await areTipsAvailable(configWithoutSiteId);

      expect(fetch).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("should return false on fetch errors", async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const result = await areTipsAvailable(mockSiteConfig);

      expect(result).toBe(false);
    });
  });
});
