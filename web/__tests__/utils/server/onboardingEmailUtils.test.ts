/** @jest-environment node */
/**
 * Test suite for onboarding email utilities
 *
 * Tests cover:
 * 1. loadOnboardingTemplate - loading templates from filesystem
 * 2. generateUnsubscribeToken - creating category-specific unsubscribe tokens
 * 3. renderOnboardingEmail - rendering templates with user data
 * 4. sendOnboardingEmail - sending onboarding emails
 */

import * as fs from "fs";
import * as path from "path";
import jwt from "jsonwebtoken";
import {
  loadOnboardingTemplate,
  renderOnboardingEmail,
  sendOnboardingEmail,
  selectRandomExampleQuestions,
} from "@/utils/server/onboardingEmailUtils";
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

const mockFs = fs as jest.Mocked<typeof fs> & {
  promises: {
    access: jest.Mock;
    readFile: jest.Mock;
    readdir: jest.Mock;
  };
};
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("onboardingEmailUtils", () => {
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

  describe("loadOnboardingTemplate", () => {
    it("should load site-specific template when it exists", async () => {
      const templateContent = JSON.stringify({
        day: 1,
        subject: "Welcome",
        greeting: "Hi {{firstName}},",
        body: "Welcome message",
        exampleQuestionPool: ["Question 1"],
      });

      const templatesDir = path.join("/test/cwd", "site-config", "onboarding-templates");
      const templatePath = path.join(templatesDir, "ananda", "day1.json");

      // Mock fs.promises.access - resolve for existing paths
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      // Mock fs.promises.readdir for getting valid site IDs
      mockFs.promises.readdir.mockResolvedValue([
        { name: "ananda", isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      // Mock fs.promises.readFile for template content
      mockFs.promises.readFile.mockResolvedValue(templateContent);

      const template = await loadOnboardingTemplate(1, "ananda");

      expect(template).not.toBeNull();
      expect(template?.day).toBe(1);
      expect(template?.subject).toBe("Welcome");
    });

    it("should return null when template does not exist", async () => {
      const templatesDir = path.join("/test/cwd", "site-config", "onboarding-templates");

      // Mock fs.promises.access - templates dir exists, but template file doesn't
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      mockFs.promises.readdir.mockResolvedValue([
        { name: "ananda", isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      const template = await loadOnboardingTemplate(1, "ananda");

      expect(template).toBeNull();
    });

    it("should handle file read errors gracefully", async () => {
      const templatesDir = path.join("/test/cwd", "site-config", "onboarding-templates");
      const templatePath = path.join(templatesDir, "ananda", "day1.json");

      // Mock fs.promises.access - both paths exist
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      mockFs.promises.readdir.mockResolvedValue([
        { name: "ananda", isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      mockFs.promises.readFile.mockRejectedValue(new Error("File read error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const template = await loadOnboardingTemplate(1, "ananda");

      expect(template).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("generateUnsubscribeToken", () => {
    it("should generate a valid JWT token with email and category", () => {
      const email = "test@example.com";
      const category = "onboarding";

      const token = generateUnsubscribeToken(email, category);

      expect(token).toBeTruthy();
      const decoded = jwt.verify(token, "test-secret-token") as any;
      expect(decoded.email).toBe(email.toLowerCase());
      expect(decoded.category).toBe(category);
      expect(decoded.purpose).toBe("email_unsubscribe");
    });

    it("should throw error when SECURE_TOKEN is not configured", () => {
      process.env.SECURE_TOKEN = "";

      expect(() => {
        generateUnsubscribeToken("test@example.com", "onboarding");
      }).toThrow("SECURE_TOKEN not configured");
    });

    it("should lowercase email address in token", () => {
      const token = generateUnsubscribeToken("Test@Example.COM", "onboarding");
      const decoded = jwt.verify(token, "test-secret-token") as any;

      expect(decoded.email).toBe("test@example.com");
    });

    it("should select random example questions from pool", () => {
      const allQuestions = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"];
      const selected = selectRandomExampleQuestions(allQuestions, 3);

      expect(selected).toHaveLength(3);
      expect(allQuestions).toContain(selected[0]);
      expect(allQuestions).toContain(selected[1]);
      expect(allQuestions).toContain(selected[2]);
    });

    it("should not exceed available questions when pool is smaller than requested count", () => {
      const allQuestions = ["Q1", "Q2"];
      const selected = selectRandomExampleQuestions(allQuestions, 5);

      expect(selected).toHaveLength(2);
      expect(selected).toEqual(expect.arrayContaining(["Q1", "Q2"]));
    });
  });

  describe("renderOnboardingEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    const mockTemplate = {
      day: 1,
      subject: "Welcome to {{siteName}}!",
      greeting: "Hi {{firstName}},",
      body: "Welcome message for {{firstName}} at {{siteName}}.\n{{exampleQuestions}}",
      exampleQuestions: ["Question 1", "Question 2"],
      ctaUrl: "{{baseUrl}}",
      ctaText: "Start Exploring",
    };

    beforeEach(() => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
        shortname: "Ananda",
      } as any);
    });

    it("should render template with user data and variables", async () => {
      const result = await renderOnboardingEmail(mockTemplate, mockUser, "ananda", "https://test.example.com");

      expect(result.subject).toBe("Welcome to Ananda!");
      expect(result.html).toContain("Welcome message for John at Ananda");
      expect(result.text).toContain("Welcome message for John at Ananda");
      // HTML version should have clickable links with tracking URLs
      expect(result.html).toContain("/api/email/click");
      expect(result.html).toContain("Question 1</a>");
      expect(result.html).toContain("Question 2</a>");
      // Text version should have plain bullets
      expect(result.text).toContain("• Question 1");
      expect(result.text).toContain("• Question 2");
      // Should include tracking pixel for email opens
      expect(result.html).toContain("/api/email/open");
    });

    it("should use default firstName when not provided", async () => {
      const userWithoutName: User = {
        id: "test@example.com",
      };
      const result = await renderOnboardingEmail(mockTemplate, userWithoutName, "ananda", "https://test.example.com");

      expect(result.html).toContain("Hi there,");
      expect(result.text).toContain("Hi there,");
    });

    it("should generate unsubscribe URL with token and tracking", async () => {
      const result = await renderOnboardingEmail(mockTemplate, mockUser, "ananda", "https://test.example.com");

      // Check that unsubscribe URL is included in the email content with tracking
      expect(result.html).toContain("/api/email/click");
      // The tracking URL should contain the unsubscribe endpoint (encoded in the URL)
      expect(result.html).toContain(encodeURIComponent("/api/unsubscribe"));
    });

    it("should throw error when user email is missing", async () => {
      const userWithoutEmail: User = {
        firstName: "John",
      };

      await expect(
        renderOnboardingEmail(mockTemplate, userWithoutEmail, "ananda", "https://test.example.com")
      ).rejects.toThrow("User email not found");
    });

    it("should render template with random questions from pool", async () => {
      const templateWithPool = {
        day: 1,
        subject: "Test Subject",
        greeting: "Hi {{firstName}},",
        body: "Questions: {{exampleQuestions}}",
        exampleQuestions: ["Default Q1"], // Fallback
        exampleQuestionPool: ["Pool Q1", "Pool Q2", "Pool Q3", "Pool Q4", "Pool Q5"],
        exampleQuestionCount: 3,
        ctaUrl: "{{baseUrl}}",
        ctaText: "Test CTA",
      };

      const result = await renderOnboardingEmail(templateWithPool, mockUser, "ananda", "https://test.example.com");

      // Should contain the rendered template with exactly 3 questions from the pool
      const textContent = result.text;

      // Count bullet points in the text
      const bulletCount = (textContent.match(/•/g) || []).length;
      expect(bulletCount).toBe(3);

      // Verify that questions from the pool are being used
      const poolQuestionsFound = templateWithPool.exampleQuestionPool.filter((q) => textContent.includes(q));
      expect(poolQuestionsFound.length).toBeGreaterThan(0);
    });
  });

  describe("sendOnboardingEmail", () => {
    const mockUser: User = {
      id: "test@example.com",
      firstName: "John",
    };

    beforeEach(() => {
      const templatesDir = path.join("/test/cwd", "site-config", "onboarding-templates");
      const templatePath = path.join(templatesDir, "ananda", "day1.json");

      // Mock fs.promises.access - both paths exist
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir || filePath === templatePath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      mockFs.promises.readdir.mockResolvedValue([
        { name: "ananda", isDirectory: () => true, isFile: () => false } as fs.Dirent,
      ]);

      mockFs.promises.readFile.mockResolvedValue(
        JSON.stringify({
          day: 1,
          subject: "Welcome",
          greeting: "Hi {{firstName}},",
          body: "Welcome message",
          exampleQuestionPool: ["Question 1"],
        })
      );
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Ananda",
      } as any);
      mockSendEmail.mockResolvedValue(true);
    });

    it("should send email successfully when template exists", async () => {
      const result = await sendOnboardingEmail(mockUser, 1, "ananda", "https://test.example.com");

      expect(result).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "test@example.com",
          subject: expect.any(String),
          html: expect.any(String),
          text: expect.any(String),
        })
      );
    });

    it("should return false when template does not exist", async () => {
      // Override the access mock to reject for template file
      const templatesDir = path.join("/test/cwd", "site-config", "onboarding-templates");
      mockFs.promises.access.mockImplementation((filePath: string) => {
        if (filePath === templatesDir) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const result = await sendOnboardingEmail(mockUser, 1, "ananda", "https://test.example.com");

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No template found"));

      consoleSpy.mockRestore();
    });

    it("should return false when user email is missing", async () => {
      const userWithoutEmail: User = {
        firstName: "John",
      };

      const result = await sendOnboardingEmail(userWithoutEmail, 1, "ananda", "https://test.example.com");

      expect(result).toBe(false);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("should return false when email sending fails", async () => {
      mockSendEmail.mockResolvedValue(false);

      const result = await sendOnboardingEmail(mockUser, 1, "ananda", "https://test.example.com");

      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockSendEmail.mockRejectedValue(new Error("SES error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const result = await sendOnboardingEmail(mockUser, 1, "ananda", "https://test.example.com");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
