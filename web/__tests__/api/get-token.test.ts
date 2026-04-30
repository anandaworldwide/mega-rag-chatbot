/**
 * Tests for the Token API Endpoint
 *
 * This file tests the functionality of the token issuance endpoint, including:
 * - Method validation (only POST allowed)
 * - Authentication methods (web frontend and WordPress)
 * - Token generation with JWT
 * - Error handling
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
import jwt from "jsonwebtoken";
import crypto from "crypto";
import handler from "@/pages/api/get-token";

// Mock the jsonwebtoken module
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock-jwt-token"),
}));

// Mock crypto
jest.mock("crypto", () => {
  return {
    createHash: jest.fn((_algorithm: string) => {
      // Return a mock hash object that tracks the input
      let inputString = "";
      const mockDigest = {
        substring: jest.fn((_start: number, _end?: number) => {
          // Determine token based on accumulated input
          if (inputString.includes("mobile-")) {
            return "mobile-token";
          } else if (inputString.includes("wordpress-")) {
            return "wordpress-token";
          }
          return "wordpress-token"; // default
        }),
      };

      const mockUpdate = {
        digest: jest.fn((_encoding: string) => {
          return mockDigest;
        }),
      };

      return {
        update: jest.fn((data: string) => {
          inputString = data.toString();
          return mockUpdate;
        }),
      };
    }),
  };
});

describe("Get Token API", () => {
  const originalEnv = process.env;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence console logs in tests
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();

    // Setup environment variables
    process.env = { ...originalEnv };
    process.env.SECURE_TOKEN = "test-secure-token";
    process.env.SECURE_TOKEN_HASH = "test-secure-token-hash";
    process.env.SITE_ID = "default"; // Explicitly set to default for these tests or a relevant one

    // Ensure SITE_CONFIG is also set for these tests
    const mockSiteConfigForTest = {
      default: {
        siteId: "default",
        name: "Default Test Site for GetToken",
        allowedFrontEndDomains: ["localhost", "127.0.0.1"], // Add relevant domains
        // Add other minimal required fields for SiteConfig that get-token API or its middleware might use
        requireLogin: false, // Example, adjust as needed
        firebaseConfig: { apiKey: "test" }, // Minimal example
        collections: [], // Minimal example
      },
      // Add other site configs if tests specifically target them via x-site-id header
    };
    process.env.SITE_CONFIG = JSON.stringify(mockSiteConfigForTest);

    // Reset mock return values if needed
    jest.mocked(crypto.createHash).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({ error: "Method Not Allowed" });
  });

  it("should return 403 when no secret is provided", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {},
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "No secret provided" });
  });

  it("should return 500 when environment variables are missing", async () => {
    delete process.env.SECURE_TOKEN;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "any-secret" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "Server configuration error" });
  });

  it("should generate a token for web frontend with correct secret in header", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: {
        "x-shared-secret": "test-secure-token",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "web" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should generate a token for web frontend with correct secret in body", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "test-secure-token" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "web" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should generate a token for WordPress with derived token", async () => {
    // Test will now use the mocked crypto functions from the jest.mock setup

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "wordpress-token" },
    });

    await handler(req, res);

    expect(crypto.createHash).toHaveBeenCalledWith("sha256");
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "wordpress" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should generate a token for mobile with derived token", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "mobile-token" },
    });

    await handler(req, res);

    expect(crypto.createHash).toHaveBeenCalledWith("sha256");
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "mobile" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should generate a token for mobile with correct expectedSiteId", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "mobile-token",
        expectedSiteId: "default",
      },
    });

    await handler(req, res);

    expect(crypto.createHash).toHaveBeenCalledWith("sha256");
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "mobile" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should return 403 for invalid secret", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "invalid-secret" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Invalid secret", code: "INVALID_SECRET" });
  });

  it("should handle errors during token generation", async () => {
    (jwt.sign as jest.Mock).mockImplementationOnce(() => {
      throw new Error("JWT error");
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { secret: "test-secure-token" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "Internal Server Error" });
    expect(console.error).toHaveBeenCalled();
  });

  // New tests for site ID validation

  it("should validate site ID when expectedSiteId is provided", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "test-secure-token",
        expectedSiteId: "default",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "web" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should return 403 when expectedSiteId does not match actual site ID", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "test-secure-token",
        expectedSiteId: "wrong-site",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: 'Site mismatch: You\'re trying to connect to "wrong-site" but this is "default"',
      code: "SITE_MISMATCH",
    });
  });

  it("should handle WordPress token with correct expectedSiteId", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "wordpress-token",
        expectedSiteId: "default",
      },
    });

    await handler(req, res);

    expect(crypto.createHash).toHaveBeenCalledWith("sha256");
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ client: "wordpress" }),
      "test-secure-token",
      expect.objectContaining({ expiresIn: "15m" })
    );
  });

  it("should work without expectedSiteId if site validation is not needed", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "test-secure-token",
        // No expectedSiteId provided
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ token: "mock-jwt-token" });
  });

  it("should handle missing SITE_ID environment variable gracefully", async () => {
    // Delete the SITE_ID environment variable
    delete process.env.SITE_ID;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        secret: "test-secure-token",
        expectedSiteId: "any-site", // This should still work as SITE_ID defaults to 'unknown'
      },
    });

    await handler(req, res);

    // Since SITE_ID is 'unknown' and expectedSiteId is 'any-site', it should mismatch
    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: 'Site mismatch: You\'re trying to connect to "any-site" but this is "unknown"',
      code: "SITE_MISMATCH",
    });
  });
});
