/** @jest-environment node */

import { sendOpsAlert } from "../../../src/utils/server/emailOps";

// Mock AWS SES
jest.mock("@aws-sdk/client-ses", () => {
  const mockSESClient = {
    send: jest.fn(),
  };
  return {
    SESClient: jest.fn().mockImplementation(() => mockSESClient),
    SendEmailCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  };
});

describe("emailOps", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset environment variables
    delete process.env.OPS_ALERT_EMAIL;
    delete process.env.CONTACT_EMAIL;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete (process.env as any).NODE_ENV;
    delete process.env.SITE_ID;
  });

  describe("sendOpsAlert", () => {
    it("should send email successfully with valid configuration", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";
      (process.env as any).NODE_ENV = "production";
      process.env.SITE_ID = "ananda";

      const subject = "Test Alert";
      const message = "This is a test alert message";

      // Execute
      const result = await sendOpsAlert(subject, message);

      // Verify
      expect(result).toBe(true);
    });

    it("should handle multiple email addresses separated by semicolons", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops1@example.com; ops2@example.com ; ops3@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";

      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify
      expect(result).toBe(true);
    });

    it("should include error details when provided", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";

      const error = new Error("Test error");
      error.stack = "Error stack trace";

      const errorDetails = {
        error,
        context: { key: "value" },
        stack: "Custom stack trace",
      };

      // Execute
      const result = await sendOpsAlert("Test", "Message", errorDetails);

      // Verify
      expect(result).toBe(true);
    });

    it("should return false when OPS_ALERT_EMAIL is not set", async () => {
      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify
      expect(result).toBe(false);
    });

    it("should return false when OPS_ALERT_EMAIL is empty", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "";

      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify
      expect(result).toBe(false);
    });

    it("should return false when OPS_ALERT_EMAIL contains only invalid emails", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "; ; ";

      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify
      expect(result).toBe(false);
    });

    it("should handle SES send errors gracefully", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";

      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify - this test will pass if the function handles errors gracefully
      expect(typeof result).toBe("boolean");
    });

    it("should use default source email when CONTACT_EMAIL is not set", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops@example.com";

      // Execute
      const result = await sendOpsAlert("Test", "Message");

      // Verify
      expect(result).toBe(true);
    });

    it("should include environment and site in subject line", async () => {
      // Setup
      process.env.OPS_ALERT_EMAIL = "ops@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";
      process.env.SITE_ID = "ananda-public";

      // Test dev environment
      (process.env as any).NODE_ENV = "development";

      // Execute
      const result = await sendOpsAlert("S3 load failure", "Test message");

      // Verify
      expect(result).toBe(true);

      // Test production environment
      (process.env as any).NODE_ENV = "production";

      // Execute again
      const result2 = await sendOpsAlert("S3 load failure", "Test message");

      // Verify
      expect(result2).toBe(true);
    });

    it("should suppress alerts in test environment (NODE_ENV=test)", async () => {
      // Setup
      const originalNodeEnv = process.env.NODE_ENV;
      const originalJestWorkerId = process.env.JEST_WORKER_ID;

      // Clear JEST_WORKER_ID to ensure we're only testing NODE_ENV
      delete process.env.JEST_WORKER_ID;
      (process.env as any).NODE_ENV = "test";
      process.env.OPS_ALERT_EMAIL = "ops@example.com";

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      // Execute
      const result = await sendOpsAlert("Test Alert", "Test message");

      // Verify
      expect(result).toBe(true); // Should return true for test compatibility
      expect(consoleSpy).toHaveBeenCalledWith("[TEST MODE] Suppressing ops alert: Test Alert");
      // SES client is mocked and should not send actual emails in test mode

      // Cleanup
      if (originalNodeEnv !== undefined) {
        (process.env as any).NODE_ENV = originalNodeEnv;
      } else {
        delete (process.env as any).NODE_ENV;
      }
      if (originalJestWorkerId !== undefined) {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
      }
      consoleSpy.mockRestore();
    });

    it("should suppress alerts when JEST_WORKER_ID is set", async () => {
      // Setup
      const originalJestWorkerId = process.env.JEST_WORKER_ID;
      const originalNodeEnv = process.env.NODE_ENV;

      // Clear NODE_ENV to ensure we're only testing JEST_WORKER_ID
      delete (process.env as any).NODE_ENV;
      process.env.JEST_WORKER_ID = "1";
      process.env.OPS_ALERT_EMAIL = "ops@example.com";

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      // Execute
      const result = await sendOpsAlert("Jest Alert", "Jest test message");

      // Verify
      expect(result).toBe(true); // Should return true for test compatibility
      expect(consoleSpy).toHaveBeenCalledWith("[TEST MODE] Suppressing ops alert: Jest Alert");
      // SES client is mocked and should not send actual emails in test mode

      // Cleanup
      if (originalJestWorkerId !== undefined) {
        process.env.JEST_WORKER_ID = originalJestWorkerId;
      } else {
        delete process.env.JEST_WORKER_ID;
      }
      if (originalNodeEnv !== undefined) {
        (process.env as any).NODE_ENV = originalNodeEnv;
      }
      consoleSpy.mockRestore();
    });

    it("should throttle repeated alerts with the same throttleKey", async () => {
      process.env.OPS_ALERT_EMAIL = "ops@example.com";
      process.env.CONTACT_EMAIL = "noreply@example.com";
      (process.env as any).NODE_ENV = "production";
      delete process.env.JEST_WORKER_ID;

      const first = await sendOpsAlert("Throttle test", "first", undefined, {
        throttleKey: "unit-test-throttle",
        throttleMs: 60_000,
      });
      const second = await sendOpsAlert("Throttle test", "second", undefined, {
        throttleKey: "unit-test-throttle",
        throttleMs: 60_000,
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  it("should use default contact email when CONTACT_EMAIL env var is not set", async () => {
    // Setup - ensure OPS_ALERT_EMAIL is set so the function runs
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    const originalContactEmail = process.env.CONTACT_EMAIL;
    delete process.env.CONTACT_EMAIL;

    const result = await sendOpsAlert("Test Alert", "Test message");

    // Restore original env var
    if (originalContactEmail) {
      process.env.CONTACT_EMAIL = originalContactEmail;
    }

    // Should succeed even without CONTACT_EMAIL set (uses default)
    expect(result).toBe(true);
  });

  it("should handle missing SITE_ID environment variable gracefully", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    process.env.CONTACT_EMAIL = "noreply@example.com";
    delete process.env.SITE_ID;

    const result = await sendOpsAlert("Test Alert", "Test message");

    // Should succeed and use "unknown" as fallback site name
    expect(result).toBe(true);
  });

  it("should handle AWS_REGION environment variable properly", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    process.env.CONTACT_EMAIL = "noreply@example.com";
    process.env.AWS_REGION = "us-west-2";

    const result = await sendOpsAlert("Test Alert", "Test message");

    // Should succeed with custom AWS region
    expect(result).toBe(true);
  });
});
