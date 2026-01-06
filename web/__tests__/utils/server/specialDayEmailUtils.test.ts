/** @jest-environment node */
/**
 * Test suite for special day email utilities
 *
 * Tests cover:
 * 1. loadSpecialDayTemplate - loading templates from filesystem
 * 2. renderSpecialDayEmail - rendering templates with user data
 * 3. sendSpecialDayEmail - sending special day emails
 * 4. Campaign ID generation
 */

import {
  loadSpecialDayTemplate,
  renderSpecialDayEmail,
  sendSpecialDayEmail,
} from "@/utils/server/specialDayEmailUtils";
import { User } from "@/types/user";
import { sendEmail } from "@/utils/server/emailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { generateCampaignId } from "@/config/specialDays";

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
jest.mock("@/utils/server/onboardingEmailUtils", () => ({
  selectRandomExampleQuestions: jest.fn((questions: string[], count: number) => questions.slice(0, count)),
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
  loadTemplateFile: jest.fn(),
  TemplateDirectoryConfig: {},
}));

// Mock fs module for testing file operations
jest.mock("fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
    readdir: jest.fn(),
  },
}));
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("specialDayEmailUtils", () => {
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

  describe("loadSpecialDayTemplate", () => {
    it("should load site-specific template when it exists", async () => {
      const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValueOnce({
        specialDayId: "masters-birthday",
        subject: "Tomorrow is Master's Birthday",
        greeting: "Dear {{firstName}},",
        body: "Body text",
        exampleQuestionPool: ["Question 1", "Question 2"],
        exampleQuestionCount: 3,
      });

      const result = await loadSpecialDayTemplate("masters-birthday", "ananda");

      expect(result).not.toBeNull();
      expect(result?.specialDayId).toBe("masters-birthday");
      expect(result?.subject).toBe("Tomorrow is Master's Birthday");
    });

    it("should return null for invalid siteId", async () => {
      const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(false);

      const result = await loadSpecialDayTemplate("masters-birthday", "invalid-site");

      expect(result).toBeNull();
    });

    it("should return null for invalid specialDayId", async () => {
      const result = await loadSpecialDayTemplate("../etc/passwd", "ananda");

      expect(result).toBeNull();
    });

    it("should return null when template file does not exist", async () => {
      const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValueOnce(null);

      const result = await loadSpecialDayTemplate("nonexistent-holyday", "ananda");

      expect(result).toBeNull();
    });
  });

  describe("renderSpecialDayEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
      emailPreferences: {
        newsletters: true,
        onboarding: true,
        reengagement: true,
        specialDay: true,
      },
    };

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
        shortname: "Ananda",
      } as any);
    });

    it("should render email with user data and template variables", async () => {
      const template = {
        specialDayId: "masters-birthday",
        subject: "Tomorrow is Master's Birthday \u2013 Prepare with Luca",
        greeting: "Dear {{firstName}},",
        body: "Body text for {{siteName}}",
        exampleQuestionPool: ["Question 1", "Question 2", "Question 3"],
        exampleQuestionCount: 3,
        ctaUrl: "{{baseUrl}}",
        ctaText: "Prepare for Master's Birthday with Luca",
      };

      const result = await renderSpecialDayEmail(template, mockUser, "ananda", "https://test.example.com", 2026);

      expect(result.subject).toContain("Master's Birthday");
      expect(result.html).toContain("John");
      expect(result.html).toContain("Ananda");
      expect(result.text).toContain("John");
    });

    it("should generate campaign ID correctly", async () => {
      const template = {
        specialDayId: "masters-birthday",
        subject: "Test",
        greeting: "Hi {{firstName}},",
        body: "Body",
        exampleQuestionPool: ["Q1"],
        exampleQuestionCount: 3,
      };

      await renderSpecialDayEmail(template, mockUser, "ananda", "https://test.example.com", 2026);

      // Campaign ID should be masters-birthday-2026
      const campaignId = generateCampaignId("masters-birthday", 2026);
      expect(campaignId).toBe("masters-birthday-2026");
    });
  });

  describe("sendSpecialDayEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
      emailPreferences: {
        newsletters: true,
        onboarding: true,
        reengagement: true,
        specialDay: true,
      },
    };

    // Get the mocked emailTemplateLoader
    const mockEmailTemplateLoader = jest.requireMock("@/utils/server/emailTemplateLoader");

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
      } as any);

      // Mock emailTemplateLoader to return a valid template
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValue(true);
      mockEmailTemplateLoader.loadTemplateFile.mockResolvedValue({
        specialDayId: "masters-birthday",
        subject: "Tomorrow is Master's Birthday",
        greeting: "Dear {{firstName}},",
        body: "Body text",
        exampleQuestionPool: ["Question 1", "Question 2"],
        exampleQuestionCount: 3,
      });
    });

    it("should send email successfully", async () => {
      mockSendEmail.mockResolvedValue(true);

      const result = await sendSpecialDayEmail(
        mockUser,
        "masters-birthday",
        "ananda",
        "https://test.example.com",
        2026
      );

      expect(result).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "test@example.com",
          subject: expect.stringContaining("Master's Birthday"),
        })
      );
    });

    it("should return false when template not found", async () => {
      // Mock template not found
      mockEmailTemplateLoader.isValidSiteId.mockResolvedValueOnce(false);

      const result = await sendSpecialDayEmail(mockUser, "nonexistent", "ananda", "https://test.example.com", 2026);

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should return false when email sending fails", async () => {
      mockSendEmail.mockResolvedValue(false);

      const result = await sendSpecialDayEmail(
        mockUser,
        "masters-birthday",
        "ananda",
        "https://test.example.com",
        2026
      );

      expect(result).toBe(false);
    });
  });
});
