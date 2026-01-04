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

import * as fs from "fs";
import * as path from "path";
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
}));
jest.mock("@/utils/server/onboardingEmailUtils", () => ({
  selectRandomExampleQuestions: jest.fn((questions: string[], count: number) => questions.slice(0, count)),
}));
jest.mock("@/utils/server/emailTokenUtils", () => ({
  generateUnsubscribeToken: jest.fn(() => "test-unsubscribe-token"),
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

const mockFs = fs as jest.Mocked<typeof fs> & {
  promises: {
    access: jest.Mock;
    readFile: jest.Mock;
    readdir: jest.Mock;
  };
};
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
      const templateContent = JSON.stringify({
        specialDayId: "masters-birthday",
        subject: "Tomorrow is Master's Birthday",
        greeting: "Dear {{firstName}},",
        body: "Body text",
        exampleQuestionPool: ["Question 1", "Question 2"],
        exampleQuestionCount: 3,
      });

      const templatesDir = path.join("/test/cwd", "site-config", "specialday-templates");
      const templatePath = path.join(templatesDir, "ananda", "masters-birthday.json");

      // Mock directory exists
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("File not found"));
      });

      // Mock readdir to return site directories
      mockFs.promises.readdir.mockResolvedValue([{ name: "ananda", isDirectory: () => true }] as any);

      // Mock readFile to return template content
      mockFs.promises.readFile.mockResolvedValue(templateContent);

      const result = await loadSpecialDayTemplate("masters-birthday", "ananda");

      expect(result).not.toBeNull();
      expect(result?.specialDayId).toBe("masters-birthday");
      expect(result?.subject).toBe("Tomorrow is Master's Birthday");
    });

    it("should return null for invalid siteId", async () => {
      mockFs.promises.readdir.mockResolvedValue([]);

      const result = await loadSpecialDayTemplate("masters-birthday", "invalid-site");

      expect(result).toBeNull();
    });

    it("should return null for invalid specialDayId", async () => {
      const result = await loadSpecialDayTemplate("../etc/passwd", "ananda");

      expect(result).toBeNull();
    });

    it("should return null when template file does not exist", async () => {
      const templatesDir = path.join("/test/cwd", "site-config", "specialday-templates");

      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("File not found"));
      });

      mockFs.promises.readdir.mockResolvedValue([{ name: "ananda", isDirectory: () => true }] as any);

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

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
      } as any);

      // Mock template loading
      const templateContent = JSON.stringify({
        specialDayId: "masters-birthday",
        subject: "Tomorrow is Master's Birthday",
        greeting: "Dear {{firstName}},",
        body: "Body text",
        exampleQuestionPool: ["Question 1", "Question 2"],
        exampleQuestionCount: 3,
      });

      const templatesDir = path.join("/test/cwd", "site-config", "specialday-templates");
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath.includes("masters-birthday.json")) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("File not found"));
      });
      mockFs.promises.readdir.mockResolvedValue([{ name: "ananda", isDirectory: () => true }] as any);
      mockFs.promises.readFile.mockResolvedValue(templateContent);
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
      mockFs.promises.readFile.mockRejectedValue(new Error("File not found"));

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
