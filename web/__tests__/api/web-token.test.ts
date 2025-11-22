/**
 * Web Token API Tests
 *
 * These tests verify that the web token endpoint correctly issues JWT tokens
 * for the web frontend client.  The endpoint should:
 *
 * 1. Only respond to GET requests
 * 2. Require the SECURE_TOKEN environment variable
 * 3. Generate valid JWT tokens with proper client identification
 * 4. Handle errors gracefully
 * 5. Validate authentication cookies when login is required
 * 6. Skip authentication validation when login is not required
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

import { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/web-token";
import jwt from "jsonwebtoken";
import { Socket } from "net";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import * as passwordUtils from "@/utils/server/passwordUtils";
import CryptoJS from "crypto-js";

// Mock modules
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/passwordUtils");
jest.mock("crypto-js");
jest.mock("jsonwebtoken");

describe("/api/web-token", () => {
  // Mock request and response objects
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    // Reset mocks before each test
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    // Set up request and response objects
    req = {
      method: "GET",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" } as unknown as Socket,
      url: "/api/web-token",
      cookies: {},
    };

    res = {
      status: statusMock,
      json: jsonMock,
    };

    // Set up environment variables
    process.env.SECURE_TOKEN = "test-secure-token";
    process.env.SECURE_TOKEN_HASH = "hashed-secure-token";

    // Set up loadSiteConfigSync mock to return non-login required by default
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: false,
    });

    // Set up isTokenValid mock to return true by default
    (passwordUtils.isTokenValid as jest.Mock).mockReturnValue(true);

    // Set up CryptoJS.SHA256 mock
    (CryptoJS.SHA256 as jest.Mock).mockReturnValue({
      toString: () => "hashed-secure-token",
    });

    // Set up jwt.sign mock
    (jwt.sign as jest.Mock).mockImplementation(() => "test-jwt-token");

    jest.clearAllMocks();
  });

  it("should return 405 for non-GET requests", async () => {
    req.method = "POST";
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusMock).toHaveBeenCalledWith(405);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Method Not Allowed" });
  });

  it("should require SECURE_TOKEN environment variable", async () => {
    delete process.env.SECURE_TOKEN;
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Server configuration error",
    });
  });

  it("should create and return a valid JWT token", async () => {
    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        client: "web",
        iat: expect.any(Number),
      },
      "test-secure-token",
      { expiresIn: "15m" }
    );
  });

  it("should handle JWT signing errors", async () => {
    (jwt.sign as jest.Mock).mockImplementationOnce(() => {
      throw new Error("JWT signing failed");
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Failed to create token" });
  });

  // New tests for authentication validation

  it("should not validate authentication when login is not required", async () => {
    // Set site config to not require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: false,
    });

    // Make request with no cookies
    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should succeed without checking authentication
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(passwordUtils.isTokenValid).not.toHaveBeenCalled();
    expect(CryptoJS.SHA256).not.toHaveBeenCalled();
  });

  it("should require JWT auth cookie when login is required", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Make request with no cookies
    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should fail with authentication required
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Authentication required",
    });
  });

  it("should reject legacy siteAuth cookie when login is required", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Set legacy siteAuth cookie (should be rejected)
    req.cookies = { siteAuth: "token-value:12345678" };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should fail with authentication required (legacy cookies not accepted)
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Authentication required",
    });
    // Should not use legacy validation methods
    expect(CryptoJS.SHA256).not.toHaveBeenCalled();
    expect(passwordUtils.isTokenValid).not.toHaveBeenCalled();
  });

  it("should accept auth JWT cookie when login is required", async () => {
    // Site requires login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({ requireLogin: true });

    // Provide JWT cookie (legacy auth cookie)
    (req as any).cookies = { auth: "valid-jwt-cookie" };

    // jwt.verify should succeed
    (jwt.verify as unknown as jest.Mock).mockReturnValue({ client: "web", exp: Math.floor(Date.now() / 1000) + 900 });

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should issue a web token
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    // Should not require siteAuth path (skips hash/timestamp path)
    expect(CryptoJS.SHA256).not.toHaveBeenCalled();
    expect(passwordUtils.isTokenValid).not.toHaveBeenCalled();
  });

  // Tests for public JWT-only endpoints

  it("should issue token for contact form requests without auth cookie", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Setup request from contact form
    req.cookies = {}; // No auth cookie
    req.headers = {
      referer: "https://example.com/contact",
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should succeed despite missing auth cookie because it's from contact page
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    expect(jwt.sign).toHaveBeenCalled();
  });

  it("should issue token for public answers page without auth cookie", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Setup request from public answers page
    req.cookies = {}; // No auth cookie
    req.headers = {
      referer: "https://example.com/share/abc123",
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should succeed despite missing auth cookie because it's from public answers page
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    expect(jwt.sign).toHaveBeenCalled();
  });

  it("should still require JWT auth cookie for regular protected pages", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Setup request from a protected page
    req.cookies = {}; // No auth cookie
    req.headers = {
      referer: "https://example.com/protected-page",
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should fail because it's missing auth cookie and not from a public JWT-only endpoint
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Authentication required",
    });
    expect(jwt.sign).not.toHaveBeenCalled();
  });
});
