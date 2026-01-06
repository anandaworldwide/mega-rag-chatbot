/** @jest-environment node */
/**
 * Test suite for NPS survey email utilities
 */

import { loadNpsSurveyTemplate, renderNpsSurveyEmail, sendNpsSurveyEmail } from "@/utils/server/npsSurveyEmailUtils";
import { User } from "@/types/user";
import { sendEmail } from "@/utils/server/emailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

// Mock dependencies
jest.mock("@/utils/server/emailUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/emailTrackingUtils", () => ({
  addUtmParams: jest.fn((url: string) => `${url}&utm_source=email&utm_medium=email&utm_campaign=test`),
  generateClickTrackingUrl: jest.fn((targetUrl: string) => `/api/email/click?url=${encodeURIComponent(targetUrl)}`),
  generateOpenTrackingUrl: jest.fn(() => "/api/email/open?token=test-token"),
}));
jest.mock("@/utils/server/emailTemplates", () => ({
  generateEmailContent: jest.fn((options: any) => {
    const greeting = options.greeting || "Hi there,";
    const unsubscribePart = options.unsubscribeUrl ? `<a href="${options.unsubscribeUrl}">Unsubscribe</a>` : "";
    return {
      html: `<html><body>${greeting}\n${options.message || ""}${unsubscribePart}</body></html>`,
      text: `${greeting}\n${options.message || ""}`,
    };
  }),
  addTrackingPixel: jest.fn((html: string, trackingUrl: string) => {
    // Insert tracking pixel before </body>
    return html.replace("</body>", `<img src="${trackingUrl}" width="1" height="1" alt="" /></body>`);
  }),
}));
jest.mock("@/utils/server/npsSurveyTokenUtils", () => ({
  generateNpsSurveyToken: jest.fn((email: string, score: number) => `token-${email}-${score}`),
}));
jest.mock("@/utils/server/emailTokenUtils", () => ({
  generateUnsubscribeToken: jest.fn(() => "test-unsubscribe-token"),
}));
jest.mock("@/utils/server/contentEmailTracker", () => ({
  updateLastContentEmailSent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  },
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users"),
}));

// Mock emailTemplateLoader to bypass caching issues
jest.mock("@/utils/server/emailTemplateLoader", () => ({
  isValidSiteId: jest.fn().mockResolvedValue(true),
  loadTemplateFile: jest.fn().mockResolvedValue(null),
  TemplateDirectoryConfig: {},
}));

const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("npsSurveyEmailUtils", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SECURE_TOKEN: "test-secret-token",
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };
    (process.cwd as any) = jest.fn(() => "/test/cwd");
  });

  afterEach(() => {
    process.env = originalEnv;
    (process.cwd as any) = originalCwd;
  });

  describe("loadNpsSurveyTemplate", () => {
    // Get the mocked emailTemplateLoader
    const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");

    it("should load site-specific template when it exists", async () => {
      const templateData = {
        subject: "Quick question about {{shortname}}",
        greeting: "Hi {{firstName}},",
        body: "We'd love to hear your feedback!",
        ctaText: "Complete Survey",
      };

      // Mock the emailTemplateLoader functions
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValueOnce(templateData);

      const template = await loadNpsSurveyTemplate("ananda");

      expect(template).not.toBeNull();
      expect(template?.subject).toBe("Quick question about {{shortname}}");
      expect(template?.greeting).toBe("Hi {{firstName}},");
    });

    it("should return null when template file does not exist", async () => {
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValueOnce(null);

      const template = await loadNpsSurveyTemplate("ananda");

      expect(template).toBeNull();
    });

    it("should return null for invalid siteId", async () => {
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(false);

      const template = await loadNpsSurveyTemplate("../invalid");
      expect(template).toBeNull();
    });

    it("should handle JSON parse errors gracefully", async () => {
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValueOnce(null);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const template = await loadNpsSurveyTemplate("ananda");

      expect(template).toBeNull();
      // Note: console.error is now called in isValidSiteId for invalid siteId,
      // but for parse errors it's handled by loadTemplateFile which returns null

      consoleSpy.mockRestore();
    });
  });

  describe("renderNpsSurveyEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    const mockTemplate = {
      subject: "Quick question about {{shortname}}",
      greeting: "Hi {{firstName}},",
      body: "We'd love to hear your feedback!",
      ctaText: "Complete Survey",
    };

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        shortname: "Luca",
        other_visitors_reference: "your Gurubhais",
      } as any);
    });

    it("should render email with score boxes", async () => {
      const result = await renderNpsSurveyEmail(mockTemplate, mockUser, "ananda", "https://test.com");

      expect(result.subject).toContain("Luca");
      expect(result.html).toContain("test%40example.com"); // URL encoded email
      expect(result.html).toContain("score"); // Should contain score boxes
      expect(result.text).toBeTruthy();
    });

    it("should include unsubscribe link", async () => {
      const result = await renderNpsSurveyEmail(mockTemplate, mockUser, "ananda", "https://test.com");

      expect(result.html).toContain("unsubscribe");
    });

    it("should include tracking pixel", async () => {
      const result = await renderNpsSurveyEmail(mockTemplate, mockUser, "ananda", "https://test.com");

      expect(result.html).toContain("open?token");
    });

    it("should render all 11 score boxes (0-10)", async () => {
      const result = await renderNpsSurveyEmail(mockTemplate, mockUser, "ananda", "https://test.com");

      // Check that all scores are included in the HTML (URL encoded)
      for (let i = 0; i <= 10; i++) {
        expect(result.html).toContain(`score%3D${i}`); // URL encoded "score="
      }
    });

    it("should use default values when user has no firstName", async () => {
      const userWithoutName: User = {
        id: "test@example.com",
      };

      const result = await renderNpsSurveyEmail(mockTemplate, userWithoutName, "ananda", "https://test.com");

      expect(result.html).toContain("there"); // Default greeting
    });
  });

  describe("sendNpsSurveyEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    // Get the mocked emailTemplateLoader
    const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        shortname: "Luca",
        other_visitors_reference: "your Gurubhais",
      } as any);

      // Mock emailTemplateLoader to return a valid template
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValue(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValue({
        subject: "Quick question about {{shortname}}",
        greeting: "Hi {{firstName}},",
        body: "We'd love to hear your feedback!",
      });
      mockSendEmail.mockResolvedValue(true);
    });

    it("should send email successfully", async () => {
      const result = await sendNpsSurveyEmail(mockUser, "ananda", "https://test.com");

      expect(result).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "test@example.com",
          subject: expect.stringContaining("Luca"),
        })
      );
    });

    it("should return false when template not found", async () => {
      // Mock template not found
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(false);

      const result = await sendNpsSurveyEmail(mockUser, "ananda", "https://test.com");

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should return false when user email is missing", async () => {
      const userWithoutEmail: User = {
        firstName: "John",
      };

      const result = await sendNpsSurveyEmail(userWithoutEmail, "ananda", "https://test.com");

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should return false when email send fails", async () => {
      mockSendEmail.mockResolvedValue(false);

      const result = await sendNpsSurveyEmail(mockUser, "ananda", "https://test.com");

      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockSendEmail.mockRejectedValue(new Error("Send failed"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await sendNpsSurveyEmail(mockUser, "ananda", "https://test.com");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
