/** @jest-environment node */
/**
 * Test suite for re-engagement email utilities
 *
 * Tests cover:
 * 1. loadReengagementTemplate - loading templates from filesystem
 * 2. selectRandomPrompt - random prompt selection
 * 3. generateUnsubscribeToken - creating category-specific unsubscribe tokens
 * 4. renderReengagementEmail - rendering templates with user data
 * 5. sendReengagementEmail - sending re-engagement emails
 */

import * as fs from "fs";
import * as path from "path";
import jwt from "jsonwebtoken";
import {
  loadReengagementTemplate,
  selectRandomPrompt,
  renderReengagementEmail,
  sendReengagementEmail,
} from "@/utils/server/reengagementEmailUtils";
import { generateUnsubscribeToken } from "@/utils/server/emailTokenUtils";
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
}));

// Mock fs module for testing file operations (including fs.promises for async ops)
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

const mockFs = fs as jest.Mocked<typeof fs>;
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("reengagementEmailUtils", () => {
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

  describe("loadReengagementTemplate", () => {
    it("should load site-specific template when it exists", async () => {
      const templateContent = JSON.stringify({
        campaignId: "reengagement-21-nudge",
        subject: "We miss you, {{firstName}}!",
        greeting: "Hi {{firstName}}, it's been a while...",
        leadIn: "If you're not sure what to ask, start here.",
        prompts: {
          meditationSupport: ["Question 1"],
          dailyLife: ["Question 2"],
          inspiration: ["Question 3"],
        },
        ctaCategories: ["meditationSupport"],
        secondaryCta: {
          label: "Return to Luca",
          url: "{{baseUrl}}",
        },
      });

      const templatesDir = path.join("/test/cwd", "site-config", "reengagement-templates");
      const templatePath = path.join(templatesDir, "ananda.json");

      // Mock fs.promises.access - resolve for existing paths, reject for non-existing
      (mockFs.promises.access as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      // Mock fs.promises.readdir for getting valid site IDs
      (mockFs.promises.readdir as jest.Mock).mockResolvedValue([
        { name: "ananda.json", isFile: () => true, isDirectory: () => false } as fs.Dirent,
      ]);

      // Mock fs.promises.readFile for template content
      (mockFs.promises.readFile as jest.Mock).mockResolvedValue(templateContent);

      const template = await loadReengagementTemplate("ananda");

      expect(template).not.toBeNull();
      expect(template?.campaignId).toBe("reengagement-21-nudge");
      expect(template?.subject).toBe("We miss you, {{firstName}}!");
    });

    it("should return null when template does not exist", async () => {
      const templatesDir = path.join("/test/cwd", "site-config", "reengagement-templates");

      // Mock fs.promises.access - templates dir exists, but ananda.json doesn't
      (mockFs.promises.access as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === templatesDir) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      // Mock readdir - only jairam.json exists
      (mockFs.promises.readdir as jest.Mock).mockResolvedValue([
        { name: "jairam.json", isFile: () => true, isDirectory: () => false } as fs.Dirent,
      ]);

      const template = await loadReengagementTemplate("ananda");

      expect(template).toBeNull();
    });

    it("should reject invalid site IDs (path traversal protection)", async () => {
      const template = await loadReengagementTemplate("../etc/passwd");

      expect(template).toBeNull();
    });

    it("should handle file read errors gracefully", async () => {
      const templatesDir = path.join("/test/cwd", "site-config", "reengagement-templates");
      const templatePath = path.join(templatesDir, "ananda.json");

      // Mock fs.promises.access - both paths exist
      (mockFs.promises.access as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      (mockFs.promises.readdir as jest.Mock).mockResolvedValue([
        { name: "ananda.json", isFile: () => true, isDirectory: () => false } as fs.Dirent,
      ]);

      // Mock readFile to throw error
      (mockFs.promises.readFile as jest.Mock).mockRejectedValue(new Error("File read error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const template = await loadReengagementTemplate("ananda");

      expect(template).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("selectRandomPrompt", () => {
    it("should select a prompt from the array", () => {
      const prompts = ["Prompt 1", "Prompt 2", "Prompt 3"];
      const selected = selectRandomPrompt(prompts);

      expect(prompts).toContain(selected);
    });

    it("should return empty string for empty array", () => {
      const selected = selectRandomPrompt([]);
      expect(selected).toBe("");
    });

    it("should return the only prompt when array has one item", () => {
      const prompts = ["Only prompt"];
      const selected = selectRandomPrompt(prompts);
      expect(selected).toBe("Only prompt");
    });
  });

  describe("generateUnsubscribeToken", () => {
    it("should generate a valid JWT token", () => {
      const token = generateUnsubscribeToken("test@example.com", "reengagement");

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      // Verify token can be decoded
      const decoded = jwt.verify(token, "test-secret-token") as any;
      expect(decoded.email).toBe("test@example.com");
      expect(decoded.purpose).toBe("email_unsubscribe");
      expect(decoded.category).toBe("reengagement");
    });

    it("should lowercase email addresses", () => {
      const token = generateUnsubscribeToken("Test@Example.COM", "reengagement");
      const decoded = jwt.verify(token, "test-secret-token") as any;
      expect(decoded.email).toBe("test@example.com");
    });

    it("should throw error when SECURE_TOKEN is not configured", () => {
      delete process.env.SECURE_TOKEN;

      expect(() => {
        generateUnsubscribeToken("test@example.com", "reengagement");
      }).toThrow("SECURE_TOKEN not configured");
    });
  });

  describe("renderReengagementEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
      lastName: "Doe",
    };

    const mockTemplate = {
      campaignId: "reengagement-21-nudge",
      subject: "We miss you, {{firstName}}!",
      greeting: "Hi {{firstName}}, it's been a while...",
      leadIn: "If you're not sure what to ask, start here.",
      prompts: {
        meditationSupport: ["Meditation question 1", "Meditation question 2"],
        dailyLife: ["Daily life question 1"],
        inspiration: ["Inspiration question 1"],
      },
      ctaCategories: ["meditationSupport", "dailyLife", "inspiration"],
      secondaryCta: {
        label: "Return to Luca",
        url: "{{baseUrl}}",
      },
    };

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
        shortname: "Luca",
      } as any);
    });

    it("should render email with user data", async () => {
      const result = await renderReengagementEmail(mockTemplate, mockUser, "ananda", "https://test.example.com");

      expect(result.subject).toBe("We miss you, John!");
      expect(result.html).toContain("Hi John, it's been a while...");
      expect(result.html).toContain("If you're not sure what to ask, start here.");
      expect(result.text).toContain("Hi John, it's been a while...");
    });

    it("should include tracking pixel in HTML", async () => {
      const result = await renderReengagementEmail(mockTemplate, mockUser, "ananda", "https://test.example.com");

      expect(result.html).toContain('<img src="/api/email/open?token=test-token"');
    });

    it("should throw error when user email is missing", async () => {
      const userWithoutEmail = { ...mockUser, id: undefined };

      await expect(
        renderReengagementEmail(mockTemplate, userWithoutEmail, "ananda", "https://test.example.com")
      ).rejects.toThrow("User email not found");
    });
  });

  describe("sendReengagementEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
      } as any);

      // Mock template loading with async fs.promises
      const templatesDir = path.join("/test/cwd", "site-config", "reengagement-templates");
      const templatePath = path.join(templatesDir, "ananda.json");

      (mockFs.promises.access as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      (mockFs.promises.readdir as jest.Mock).mockResolvedValue([
        { name: "ananda.json", isFile: () => true, isDirectory: () => false } as fs.Dirent,
      ]);

      (mockFs.promises.readFile as jest.Mock).mockResolvedValue(
        JSON.stringify({
          campaignId: "reengagement-21-nudge",
          subject: "We miss you, {{firstName}}!",
          greeting: "Hi {{firstName}}, it's been a while...",
          leadIn: "If you're not sure what to ask, start here.",
          prompts: {
            meditationSupport: ["Question 1"],
            dailyLife: ["Question 2"],
            inspiration: ["Question 3"],
          },
          ctaCategories: ["meditationSupport"],
          secondaryCta: {
            label: "Return to Luca",
            url: "{{baseUrl}}",
          },
        })
      );

      mockSendEmail.mockResolvedValue(true);
    });

    it("should send email successfully", async () => {
      const result = await sendReengagementEmail(mockUser, "ananda", "https://test.example.com");

      expect(result).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "test@example.com",
          subject: expect.stringContaining("We miss you"),
        })
      );
    });

    it("should return false when template not found", async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await sendReengagementEmail(mockUser, "nonexistent", "https://test.example.com");

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should return false when user email is missing", async () => {
      const userWithoutEmail = { ...mockUser, id: undefined };

      const result = await sendReengagementEmail(userWithoutEmail, "ananda", "https://test.example.com");

      expect(result).toBe(false);
    });

    it("should return false when email sending fails", async () => {
      mockSendEmail.mockResolvedValue(false);

      const result = await sendReengagementEmail(mockUser, "ananda", "https://test.example.com");

      expect(result).toBe(false);
    });
  });
});
