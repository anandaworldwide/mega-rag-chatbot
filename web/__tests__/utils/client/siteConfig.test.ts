import {
  getSiteName,
  getShortname,
  getTagline,
  getParentSiteUrl,
  getParentSiteName,
  getGreeting,
  getLibraryMappings,
  getEnableSuggestedQueries,
  getEnableMediaTypeSelection,
  getEnableAuthorSelection,
  getWelcomePopupHeading,
  getOtherVisitorsReference,
  getLoginImage,
  getChatPlaceholder,
  getHeaderConfig,
  getFooterConfig,
  getRequireLogin,
  getAllowTemporarySessions,
  getAllowAllAnswersPage,
  getEnabledMediaTypes,
  getCollectionsConfig,
  getShowRelatedQuestions,
} from "@/utils/client/siteConfig";
import { SiteConfig } from "@/types/siteConfig";

describe("siteConfig utils", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "test-site",
    name: "Test Site",
    shortname: "Test",
    tagline: "Test Tagline",
    parent_site_url: "https://test.com",
    parent_site_name: "Parent Site",
    help_url: "https://help.test.com",
    help_text: "Get help here",
    greeting: "Test Greeting",
    collectionConfig: { test: "test" },
    libraryMappings: {
      test: {
        displayName: "Test Library",
        url: "https://library.test.com",
      },
    },
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "Test Welcome",
    other_visitors_reference: "test visitors",
    loginImage: "test.jpg",
    chatPlaceholder: "Test placeholder",
    header: {
      logo: "logo.png",
      navItems: [{ label: "Test", path: "/test" }],
    },
    footer: {
      links: [{ label: "Test", url: "/test" }],
    },
    requireLogin: false,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    queriesPerUserPerDay: 100,
    enabledMediaTypes: ["text", "audio"],
  };

  describe("with null config", () => {
    it("returns default values when config is null", () => {
      expect(getSiteName(null)).toBe("The AI Chatbot");
      expect(getShortname(null)).toBe("AI Chatbot");
      expect(getTagline(null)).toBe("Explore, Discover, Learn");
      expect(getParentSiteUrl(null)).toBe("");
      expect(getParentSiteName(null)).toBe("");
      expect(getGreeting(null)).toBe("Hello! How can I assist you today?");
      expect(getLibraryMappings(null)).toEqual({});
      expect(getEnableSuggestedQueries(null)).toBe(false);
      expect(getEnableMediaTypeSelection(null)).toBe(false);
      expect(getEnableAuthorSelection(null)).toBe(false);
      expect(getWelcomePopupHeading(null)).toBe("Welcome!");
      expect(getOtherVisitorsReference(null)).toBe("other visitors");
      expect(getLoginImage(null)).toBe(null);
      expect(getChatPlaceholder(null)).toBe("");
      expect(getHeaderConfig(null)).toEqual({ logo: "", navItems: [] });
      expect(getFooterConfig(null)).toEqual({ links: [] });
      expect(getRequireLogin(null)).toBe(true);
      expect(getAllowTemporarySessions(null)).toBe(false);
      expect(getAllowAllAnswersPage(null)).toBe(false);
      expect(getEnabledMediaTypes(null)).toEqual(["text", "audio", "youtube"]);
      expect(getCollectionsConfig(null)).toEqual({});
      expect(getShowRelatedQuestions(null)).toBe(true);
    });
  });

  describe("with valid config", () => {
    it("returns configured values when config is provided", () => {
      expect(getSiteName(mockSiteConfig)).toBe("Test Site");
      expect(getShortname(mockSiteConfig)).toBe("Test");
      expect(getTagline(mockSiteConfig)).toBe("Test Tagline");
      expect(getParentSiteUrl(mockSiteConfig)).toBe("https://test.com");
      expect(getParentSiteName(mockSiteConfig)).toBe("Parent Site");
      expect(getGreeting(mockSiteConfig)).toBe("Test Greeting");
      expect(getLibraryMappings(mockSiteConfig)).toEqual({
        test: {
          displayName: "Test Library",
          url: "https://library.test.com",
        },
      });
      expect(getEnableSuggestedQueries(mockSiteConfig)).toBe(true);
      expect(getEnableMediaTypeSelection(mockSiteConfig)).toBe(true);
      expect(getEnableAuthorSelection(mockSiteConfig)).toBe(true);
      expect(getWelcomePopupHeading(mockSiteConfig)).toBe("Test Welcome");
      expect(getOtherVisitorsReference(mockSiteConfig)).toBe("test visitors");
      expect(getLoginImage(mockSiteConfig)).toBe("test.jpg");
      expect(getChatPlaceholder(mockSiteConfig)).toBe("Test placeholder");
      expect(getHeaderConfig(mockSiteConfig)).toEqual({
        logo: "logo.png",
        navItems: [{ label: "Test", path: "/test" }],
      });
      expect(getFooterConfig(mockSiteConfig)).toEqual({
        links: [{ label: "Test", url: "/test" }],
      });
      expect(getRequireLogin(mockSiteConfig)).toBe(false);
      expect(getAllowTemporarySessions(mockSiteConfig)).toBe(true);
      expect(getAllowAllAnswersPage(mockSiteConfig)).toBe(true);
      expect(getEnabledMediaTypes(mockSiteConfig)).toEqual(["text", "audio"]);
      expect(getCollectionsConfig(mockSiteConfig)).toEqual({ test: "test" });
    });
  });

  describe("with partial config", () => {
    it("handles undefined properties gracefully", () => {
      const partialConfig: Partial<SiteConfig> = {
        siteId: "partial-site",
        name: "Partial Site",
      };

      expect(getSiteName(partialConfig as SiteConfig)).toBe("Partial Site");
      expect(getShortname(partialConfig as SiteConfig)).toBe("AI Chatbot");
      expect(getTagline(partialConfig as SiteConfig)).toBe("Explore, Discover, Learn");
      expect(getParentSiteUrl(partialConfig as SiteConfig)).toBe("");
      expect(getParentSiteName(partialConfig as SiteConfig)).toBe("");
      expect(getGreeting(partialConfig as SiteConfig)).toBe("Hello! How can I assist you today?");
      expect(getLibraryMappings(partialConfig as SiteConfig)).toEqual({});
      expect(getEnableSuggestedQueries(partialConfig as SiteConfig)).toBe(false);
      expect(getEnableMediaTypeSelection(partialConfig as SiteConfig)).toBe(false);
      expect(getEnableAuthorSelection(partialConfig as SiteConfig)).toBe(false);
      expect(getWelcomePopupHeading(partialConfig as SiteConfig)).toBe("Welcome!");
      expect(getOtherVisitorsReference(partialConfig as SiteConfig)).toBe("other visitors");
      expect(getLoginImage(partialConfig as SiteConfig)).toBe(null);
      expect(getChatPlaceholder(partialConfig as SiteConfig)).toBe("");
      expect(getHeaderConfig(partialConfig as SiteConfig)).toEqual({
        logo: "",
        navItems: [],
      });
      expect(getFooterConfig(partialConfig as SiteConfig)).toEqual({
        links: [],
      });
      expect(getRequireLogin(partialConfig as SiteConfig)).toBe(true);
      expect(getAllowTemporarySessions(partialConfig as SiteConfig)).toBe(false);
      expect(getAllowAllAnswersPage(partialConfig as SiteConfig)).toBe(false);
      expect(getEnabledMediaTypes(partialConfig as SiteConfig)).toEqual(["text", "audio", "youtube"]);
      expect(getCollectionsConfig(partialConfig as SiteConfig)).toEqual({});
    });
  });

  describe("edge cases", () => {
    it("handles empty strings properly", () => {
      const configWithEmptyStrings: Partial<SiteConfig> = {
        siteId: "empty-string-site",
        name: "",
        shortname: "",
        tagline: "",
        parent_site_url: "",
        parent_site_name: "",
        greeting: "",
        chatPlaceholder: "",
        welcome_popup_heading: "",
        other_visitors_reference: "",
      };

      expect(getSiteName(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getShortname(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getTagline(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getParentSiteUrl(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getParentSiteName(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getGreeting(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getWelcomePopupHeading(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getOtherVisitorsReference(configWithEmptyStrings as SiteConfig)).toBe("");
      expect(getChatPlaceholder(configWithEmptyStrings as SiteConfig)).toBe("");
    });

    it("handles empty arrays properly", () => {
      const configWithEmptyArrays: Partial<SiteConfig> = {
        siteId: "empty-arrays-site",
        enabledMediaTypes: [],
        header: { logo: "logo.png", navItems: [] },
        footer: { links: [] },
      };

      expect(getEnabledMediaTypes(configWithEmptyArrays as SiteConfig)).toEqual([]);
      expect(getHeaderConfig(configWithEmptyArrays as SiteConfig)).toEqual({
        logo: "logo.png",
        navItems: [],
      });
      expect(getFooterConfig(configWithEmptyArrays as SiteConfig)).toEqual({
        links: [],
      });
    });

    it("handles partial header and footer configs", () => {
      const partialHeaderFooter: Partial<SiteConfig> = {
        siteId: "partial-header-footer",
        header: { logo: "only-logo.png", navItems: [] },
        footer: { links: [] },
      };

      expect(getHeaderConfig(partialHeaderFooter as SiteConfig)).toEqual({
        logo: "only-logo.png",
        navItems: [],
      });
      expect(getFooterConfig(partialHeaderFooter as SiteConfig)).toEqual({
        links: [],
      });
    });
  });
});
