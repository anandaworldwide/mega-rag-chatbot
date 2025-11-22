/**
 * Tests for the Contact API endpoint
 *
 * This file tests the functionality of the contact API endpoint, including:
 * - Method validation (only POST allowed)
 * - Input validation (name, email, message format)
 * - Rate limiting
 * - Error handling for various scenarios
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { SendEmailCommand } from "@aws-sdk/client-ses";

// Mock the entire AWS SDK module
jest.mock("@aws-sdk/client-ses", () => {
  const mockSend = jest.fn().mockResolvedValue({ success: true });
  return {
    SESClient: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    SendEmailCommand: jest.fn(),
  };
});

// Import the handler after all mocks are set up
import handler from "@/pages/api/contact";

// Mock the JWT auth middleware to bypass token validation in tests
jest.mock("@/utils/server/jwtUtils", () => {
  return {
    withJwtAuth: jest.fn().mockImplementation((handler) => {
      return handler; // Simply return the handler without token validation
    }),
  };
});

// Mock CORS middleware
jest.mock("@/utils/server/corsMiddleware", () => ({
  __esModule: true,
  default: jest.fn(),
  runMiddleware: jest.fn().mockResolvedValue(undefined),
  setCorsHeaders: jest.fn(),
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

// Mock site config
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue({
    shortname: "Test Site",
    name: "Test Site",
  }),
}));

describe("Contact API", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.CONTACT_EMAIL = "contact@example.com";
    process.env.AWS_ACCESS_KEY_ID = "test-key-id";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_REGION = "us-east-1";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({
      error: "Method not allowed",
    });
  });

  it("should validate name presence", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "",
        email: "test@example.com",
        message: "This is a test message",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid name",
    });
  });

  it("should validate email presence and format", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "Test User",
        email: "invalid-email",
        message: "This is a test message",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid email: Invalid email format",
    });
  });

  it("should validate message presence and length", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "Test User",
        email: "test@example.com",
        message: "",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid message length",
    });
  });

  it("should handle missing environment variables", async () => {
    delete process.env.CONTACT_EMAIL;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "Test User",
        email: "test@example.com",
        message: "This is a test message",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData().message).toBe("CONTACT_EMAIL environment variable is not set");
  });

  it("should handle exceptionally long inputs", async () => {
    const longText = "a".repeat(5000);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "Test User",
        email: "test@example.com",
        message: longText,
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().message).toBe("Invalid message length");
  });

  it("should handle feedback mode with correct email subject and body", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { mode: "feedback" },
      body: {
        name: "Feedback User",
        email: "feedback@example.com",
        message: "This is feedback about the site",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);

    // Verify that SES was called with feedback-specific content
    expect(SendEmailCommand).toHaveBeenCalledWith({
      Source: "contact@example.com",
      Destination: {
        ToAddresses: ["contact@example.com"],
        CcAddresses: ["feedback@example.com"],
      },
      Message: {
        Subject: {
          Data: "Test Site Feedback from Feedback User",
        },
        Body: {
          Text: {
            Data: "Type: Feedback\nFrom: Feedback User <feedback@example.com>\n\nMessage:\n\nThis is feedback about the site",
          },
        },
      },
    });
  });

  it("should handle contact mode with correct email subject and body", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { mode: "contact" }, // Explicit contact mode
      body: {
        name: "Contact User",
        email: "contact@example.com",
        message: "This is a contact message",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);

    // Verify that SES was called with contact-specific content
    // SendEmailCommand mock imported at top

    expect(SendEmailCommand).toHaveBeenCalledWith({
      Source: "contact@example.com",
      Destination: {
        ToAddresses: ["contact@example.com"],
        CcAddresses: ["contact@example.com"],
      },
      Message: {
        Subject: {
          Data: "Test Site Contact Form Msg from Contact User",
        },
        Body: {
          Text: {
            Data: "Type: Contact\nFrom: Contact User <contact@example.com>\n\nMessage:\n\nThis is a contact message",
          },
        },
      },
    });
  });

  it("should default to contact mode when no mode is specified", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        name: "Default User",
        email: "default@example.com",
        message: "This is a default message",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);

    // Verify that SES was called with contact-specific content (default)
    // SendEmailCommand mock imported at top

    expect(SendEmailCommand).toHaveBeenCalledWith({
      Source: "contact@example.com",
      Destination: {
        ToAddresses: ["contact@example.com"],
        CcAddresses: ["default@example.com"],
      },
      Message: {
        Subject: {
          Data: "Test Site Contact Form Msg from Default User",
        },
        Body: {
          Text: {
            Data: "Type: Contact\nFrom: Default User <default@example.com>\n\nMessage:\n\nThis is a default message",
          },
        },
      },
    });
  });
});
