import { generateEmailContent, createEmailParams } from "@/utils/server/emailTemplates";

// Mock loadSiteConfigSync
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({
    name: "Test Site",
    shortname: "TestSite",
    emailGreeting: "Hello there!",
    loginImage: "test-logo.png",
  })),
}));

// Mock environment variables
const originalEnv = process.env;
beforeEach(() => {
  process.env = {
    ...originalEnv,
    NEXT_PUBLIC_BASE_URL: "https://test.example.com",
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe("emailTemplates", () => {
  describe("generateEmailContent", () => {
    it("should generate HTML and text versions with default values", () => {
      const result = generateEmailContent({
        message: "This is a test message.\n\nWith multiple lines.",
      });

      expect(result.text).toContain("Hello there!");
      expect(result.text).toContain("This is a test message.");

      expect(result.html).toContain("Hello there!");
      expect(result.html).toContain("This is a test message.");
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("test-logo.png");
    });

    it("should use custom greeting when provided", () => {
      const result = generateEmailContent({
        greeting: "Custom greeting!",
        message: "Test message",
      });

      expect(result.text).toContain("Custom greeting!");
      expect(result.html).toContain("Custom greeting!");
    });

    it("should include login image when configured", () => {
      const result = generateEmailContent({
        message: "Test message",
        baseUrl: "https://custom.example.com",
      });

      expect(result.html).toContain("https://custom.example.com/test-logo.png");
      expect(result.html).toContain('<img src="https://custom.example.com/test-logo.png"');
    });

    it("should not include login image when loginImageUrl is null", () => {
      const result = generateEmailContent({
        message: "Test message",
        loginImageUrl: null,
      });

      expect(result.html).not.toContain("<img src=");
      expect(result.html).not.toContain("login-image");
    });

    it("should handle multiline messages correctly", () => {
      const message = "Line 1\n\nLine 2\nLine 3";
      const result = generateEmailContent({ message });

      expect(result.text).toContain("Line 1\n\nLine 2\nLine 3");
      expect(result.html).toContain("Line 1\n\nLine 2\nLine 3");
    });

    it("should include one-click unsubscribe link and settings link when unsubscribeUrl is provided", () => {
      const result = generateEmailContent({
        message: "Test message",
        unsubscribeUrl: "https://example.com/unsubscribe?token=abc123",
      });

      // Check HTML version
      expect(result.html).toContain("One-click unsubscribe");
      expect(result.html).toContain('href="https://example.com/unsubscribe?token=abc123"');
      expect(result.html).toContain("manage all email preferences");
      expect(result.html).toContain('href="https://test.example.com/settings"');

      // Check text version
      expect(result.text).toContain("One-click unsubscribe: https://example.com/unsubscribe?token=abc123");
      expect(result.text).toContain("(or manage all email preferences: https://test.example.com/settings)");
    });

    it("should not include unsubscribe section when unsubscribeUrl is not provided", () => {
      const result = generateEmailContent({
        message: "Test message",
      });

      expect(result.html).not.toContain("One-click unsubscribe");
      expect(result.html).not.toContain("manage all email preferences");
      expect(result.text).not.toContain("One-click unsubscribe");
    });
  });

  describe("createEmailParams", () => {
    it("should create proper SES email parameters", () => {
      const params = createEmailParams("from@example.com", "to@example.com", "Test Subject", {
        message: "Test message content",
      });

      expect(params.Source).toBe("from@example.com");
      expect(params.Destination.ToAddresses).toEqual(["to@example.com"]);
      expect(params.Message.Subject.Data).toBe("Test Subject");
      expect(params.Message.Body.Html?.Data).toContain("Test message content");
      expect(params.Message.Body.Text?.Data).toContain("Test message content");
    });
  });
});
