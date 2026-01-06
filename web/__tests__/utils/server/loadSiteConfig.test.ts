import { loadSiteConfig, loadSiteConfigSync } from "../../../src/utils/server/loadSiteConfig";

describe("loadSiteConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe("loadSiteConfig", () => {
    it("should load config for the given site ID", async () => {
      // Setup mock environment variable
      process.env.SITE_CONFIG = JSON.stringify({
        "test-site": {
          name: "Test Site",
          shortname: "Test",
          tagline: "Test tagline",
          greeting: "Hello",
          parent_site_url: "https://example.com",
          parent_site_name: "Example",
          help_url: "https://example.com/help",
          help_text: "Need help?",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "Welcome",
          other_visitors_reference: "Others",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          enableModelComparison: true,
          includedLibraries: ["lib1", "lib2"],
          header: {
            logo: "logo.png",
            navItems: [{ label: "Home", path: "/" }],
          },
          footer: {
            links: [{ label: "About", url: "/about" }],
          },
        },
      });

      const config = await loadSiteConfig("test-site");

      expect(config).not.toBeNull();
      expect(config).toEqual({
        siteId: "test-site",
        name: "Test Site",
        shortname: "Test",
        tagline: "Test tagline",
        greeting: "Hello",
        parent_site_url: "https://example.com",
        parent_site_name: "Example",
        help_url: "https://example.com/help",
        help_text: "Need help?",
        collectionConfig: {},
        libraryMappings: {},
        enableSuggestedQueries: false,
        enableMediaTypeSelection: false,
        enableAuthorSelection: false,
        welcome_popup_heading: "Welcome",
        other_visitors_reference: "Others",
        loginImage: null,
        requireLogin: false,
        allowTemporarySessions: true,
        allowAllAnswersPage: true,
        queriesPerUserPerDay: 10,
        enableModelComparison: true,
        includedLibraries: ["lib1", "lib2"],
        chatPlaceholder: "Ask a question...",
        header: {
          logo: "logo.png",
          navItems: [{ label: "Home", path: "/" }],
        },
        footer: {
          links: [{ label: "About", url: "/about" }],
        },
      });
    });

    it("should use process.env.SITE_ID when no siteId is provided", async () => {
      process.env.SITE_ID = "env-site";
      process.env.SITE_CONFIG = JSON.stringify({
        "env-site": {
          name: "Env Site",
          shortname: "Env",
          tagline: "Env tagline",
          greeting: "Hello",
          parent_site_url: "https://example.com",
          parent_site_name: "Example",
          help_url: "https://example.com/help",
          help_text: "Need help?",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "Welcome",
          other_visitors_reference: "Others",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          header: {
            logo: "logo.png",
            navItems: [],
          },
          footer: {
            links: [],
          },
        },
      });

      const config = await loadSiteConfig();

      expect(config).not.toBeNull();
      expect(config?.name).toBe("Env Site");
      expect(config?.siteId).toBe("env-site");
    });

    it('should use "default" when no siteId is provided and no process.env.SITE_ID', async () => {
      delete process.env.SITE_ID;
      process.env.SITE_CONFIG = JSON.stringify({
        default: {
          name: "Default Site",
          shortname: "Default",
          tagline: "Default tagline",
          greeting: "Hello",
          parent_site_url: "https://example.com",
          parent_site_name: "Example",
          help_url: "https://example.com/help",
          help_text: "Need help?",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "Welcome",
          other_visitors_reference: "Others",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          header: {
            logo: "logo.png",
            navItems: [],
          },
          footer: {
            links: [],
          },
        },
      });

      const config = await loadSiteConfig();

      expect(config).not.toBeNull();
      expect(config?.name).toBe("Default Site");
      expect(config?.siteId).toBe("default");
    });

    it("should return null if site config not found for the given ID", async () => {
      process.env.SITE_CONFIG = JSON.stringify({
        site1: { name: "Site 1" },
      });

      const config = await loadSiteConfig("nonexistent");

      expect(config).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });

    it("should return null if SITE_CONFIG is not valid JSON", async () => {
      process.env.SITE_CONFIG = "invalid json";

      const config = await loadSiteConfig("test-site");

      expect(config).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });

    it("should return null if SITE_CONFIG is not set", async () => {
      delete process.env.SITE_CONFIG;

      const config = await loadSiteConfig("test-site");

      expect(config).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("loadSiteConfigSync", () => {
    it("should synchronously load config for the given site ID", () => {
      process.env.SITE_CONFIG = JSON.stringify({
        "test-site": {
          name: "Test Site",
          shortname: "Test",
          tagline: "Test tagline",
          greeting: "Hello",
          parent_site_url: "https://example.com",
          parent_site_name: "Example",
          help_url: "https://example.com/help",
          help_text: "Need help?",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "Welcome",
          other_visitors_reference: "Others",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          header: {
            logo: "logo.png",
            navItems: [],
          },
          footer: {
            links: [],
          },
        },
      });

      const config = loadSiteConfigSync("test-site");

      expect(config).not.toBeNull();
      expect(config?.name).toBe("Test Site");
    });

    it("should use process.env.SITE_ID when no siteId is provided", () => {
      process.env.SITE_ID = "env-site";
      process.env.SITE_CONFIG = JSON.stringify({
        "env-site": {
          name: "Env Site",
          shortname: "Env",
          tagline: "Env tagline",
          greeting: "Hello",
          parent_site_url: "https://example.com",
          parent_site_name: "Example",
          help_url: "https://example.com/help",
          help_text: "Need help?",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "Welcome",
          other_visitors_reference: "Others",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          header: {
            logo: "logo.png",
            navItems: [],
          },
          footer: {
            links: [],
          },
        },
      });

      const config = loadSiteConfigSync();

      expect(config).not.toBeNull();
      expect(config?.name).toBe("Env Site");
      expect(config?.siteId).toBe("env-site");
    });

    it("should return null if site config not found for the given ID", () => {
      process.env.SITE_CONFIG = JSON.stringify({
        site1: { name: "Site 1" },
      });

      const config = loadSiteConfigSync("nonexistent");

      expect(config).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });
});
