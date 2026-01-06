/**
 * Tests for the NPS Survey API endpoint
 *
 * This file tests the functionality of the submitNpsSurvey API endpoint, including:
 * - Input validation (UUID, score range, feedback length)
 * - Rate limiting for recent submissions
 * - Error handling for Google Sheets API interactions
 * - Environment variable validation
 */

// Mock Firebase directly before anything else is imported
jest.mock("@/services/firebase", () => {
  const mockCollection = jest.fn().mockReturnThis();
  const mockDoc = jest.fn().mockReturnThis();
  const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => null });

  return {
    db: {
      collection: mockCollection,
      doc: mockDoc,
      get: mockGet,
    },
  };
});

// Mock genericRateLimiter before it gets imported
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
}));

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Need to mock JWT auth before importing the handler
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
}));

// Mock the googleapis module using jest.mock
// The syntax with mock at the top level and outside of the function is required by Jest
const mockGetFn = jest.fn();
const mockAppendFn = jest.fn();

// Use automatic mock and then manually define the implementation

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({
        getClient: jest.fn().mockResolvedValue({}),
      })),
    },
    sheets: jest.fn().mockImplementation(() => ({
      spreadsheets: {
        values: {
          get: mockGetFn,
          append: mockAppendFn,
        },
      },
    })),
  },
}));

// Import the handler after all mocks are set up
import handler from "@/pages/api/submitNpsSurvey";

// Mock JSON.parse to handle credentials
const originalJsonParse = JSON.parse;
global.JSON.parse = jest.fn().mockImplementation((text) => {
  if (typeof text === "string" && text === process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      type: "service_account",
      project_id: "test-project",
      private_key_id: "test-key-id",
      private_key: "test-private-key",
      client_email: "test@example.com",
      client_id: "test-client-id",
    };
  }
  return originalJsonParse(text);
});

describe("NPS Survey API", () => {
  // Set up environment variables before each test
  beforeEach(() => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "test-credentials";
    process.env.NPS_SURVEY_GOOGLE_SHEET_ID = "test-sheet-id";
    jest.clearAllMocks();
    // Reset mock implementations to ensure clean state for each test
    mockGetFn.mockReset();
    mockAppendFn.mockReset();
  });

  // Clean up environment variables after each test
  afterEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.NPS_SURVEY_GOOGLE_SHEET_ID;
  });

  it("should return 405 for non-POST/non-GET requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PUT",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({
      error: "Method Not Allowed",
      code: "VALIDATION_ERROR",
    });
  });

  it("should validate UUID", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "invalid-uuid",
        score: 8,
        feedback: "Great service!",
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Invalid UUID",
      code: "VALIDATION_ERROR",
    });
  });

  it("should validate score range", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 11, // Invalid score
        feedback: "Great service!",
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Score must be an integer between 0 and 10",
      code: "VALIDATION_ERROR",
    });
  });

  it("should validate feedback length", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "a".repeat(1001), // Too long
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Feedback must be 1000 characters or less",
      code: "VALIDATION_ERROR",
    });
  });

  it("should validate additionalComments length", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        additionalComments: "a".repeat(1001), // Too long
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Additional comments must be 1000 characters or less",
      code: "VALIDATION_ERROR",
    });
  });

  it("should validate timestamp format", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        timestamp: "invalid-date",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Invalid timestamp",
      code: "VALIDATION_ERROR",
    });
  });

  it("should check for recent submissions and return 429 if found", async () => {
    // Mock the Google Sheets API to return a recent submission
    const now = new Date();
    mockGetFn.mockResolvedValueOnce({
      data: {
        values: [
          // Recent submission from the same user (within last month)
          [now.toISOString(), "123e4567-e89b-12d3-a456-426614174000"],
        ],
      },
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        timestamp: now.toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(429);
    expect(res._getJSONData()).toEqual({
      error: "You can only submit one survey per month",
      code: "RATE_LIMIT_EXCEEDED",
    });
  });

  it("should submit survey successfully if no recent submission", async () => {
    // Mock the Google Sheets API to return no recent submissions
    // First call: check for recent submissions (range A:B)
    mockGetFn
      .mockResolvedValueOnce({
        data: {
          values: [
            // No matching UUID - ensure timestamp is old enough (> 1 month ago)
            [new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString(), "different-uuid"],
          ],
        },
      })
      // Second call: check for duplicates (range A:B) - called after idempotency key generation
      .mockResolvedValueOnce({
        data: {
          values: [], // No existing data rows
        },
      });

    // Mock the append function to return success
    mockAppendFn.mockResolvedValueOnce({
      data: { updates: { updatedCells: 5 } },
    });

    const timestamp = new Date().toISOString();
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        additionalComments: "Additional feedback",
        timestamp,
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "Survey submitted successfully",
    });
  });

  it("should handle Google Sheets API errors", async () => {
    // Mock the Google Sheets API to return no recent submissions
    mockGetFn
      .mockResolvedValueOnce({
        data: {
          values: [], // No recent submissions
        },
      })
      // Second call: check for duplicates
      .mockResolvedValueOnce({
        data: {
          values: [], // No duplicates
        },
      });

    // Mock the append function to throw an error
    mockAppendFn.mockRejectedValueOnce(new Error("API error"));

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const response = res._getJSONData();
    expect(response).toHaveProperty("error");
    expect(response).toHaveProperty("code", "INTERNAL_ERROR");
    expect(response.error).toContain("Error submitting survey");
  });

  it("should handle missing Google credentials", async () => {
    // Remove Google credentials
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({
      error: "Missing Google credentials",
      code: "CONFIGURATION_ERROR",
    });
  });

  it("should handle missing Google Sheet ID", async () => {
    // Remove Google Sheet ID
    delete process.env.NPS_SURVEY_GOOGLE_SHEET_ID;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        score: 8,
        feedback: "Great service!",
        timestamp: new Date().toISOString(),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({
      error: "Missing Google Sheet ID",
      code: "CONFIGURATION_ERROR",
    });
  });
});
