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

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

import { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/web-token";
import jwt from "jsonwebtoken";
import { Socket } from "net";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import * as passwordUtils from "@/utils/server/passwordUtils";
import CryptoJS from "crypto-js";
import { sendOpsAlert } from "@/utils/server/emailOps";

// Mock modules
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/passwordUtils");
jest.mock("crypto-js");
jest.mock("jsonwebtoken");
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

// Mock cookies library
const setCookieMock = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => {
    return {
      set: setCookieMock,
    };
  });
});

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

    // Set up jwt.verify mock to succeed by default
    (jwt.verify as jest.Mock).mockReturnValue({ client: "web", exp: Math.floor(Date.now() / 1000) + 900 });

    // Reset cookies mock
    setCookieMock.mockClear();

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
      {
        expiresIn: "15m",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      }
    );
  });

  it("should handle JWT signing errors", async () => {
    (jwt.sign as jest.Mock).mockImplementationOnce(() => {
      throw new Error("JWT signing failed");
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "TOKEN_SERVICE_UNAVAILABLE",
        error: expect.stringMatching(/temporarily unavailable/i),
      })
    );
    expect(sendOpsAlert).toHaveBeenCalled();
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

  it("should issue anonymous token when no auth cookie on login-required site", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Make request with no cookies
    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should issue anonymous token (authorization happens at downstream endpoints)
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    expect(jwt.sign).toHaveBeenCalled();
  });

  it("should ignore legacy siteAuth cookie and issue anonymous token", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Set legacy siteAuth cookie (should be ignored)
    req.cookies = { siteAuth: "token-value:12345678" };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should issue anonymous token (legacy cookies are ignored)
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    // Should not use legacy validation methods
    expect(CryptoJS.SHA256).not.toHaveBeenCalled();
    expect(passwordUtils.isTokenValid).not.toHaveBeenCalled();
  });

  it("should accept authToken JWT cookie when login is required", async () => {
    // Site requires login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({ requireLogin: true });

    (req as any).cookies = { authToken: "valid-jwt-cookie" };

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

  // Tests for anonymous token issuance (no Referer bypass vulnerability)

  it("should issue anonymous token when no auth cookie present (even on login-required sites)", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Setup request without auth cookie
    req.cookies = {}; // No auth cookie
    req.headers = {
      referer: "https://example.com/contact",
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should succeed and issue anonymous token
    // Authorization decisions are made by downstream endpoints
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    expect(jwt.sign).toHaveBeenCalled();

    // Verify token payload is anonymous (no user info)
    const signCall = (jwt.sign as jest.Mock).mock.calls[0];
    const payload = signCall[0];
    expect(payload.email).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.client).toBe("web");
  });

  it("should not trust Referer header for authorization decisions", async () => {
    // This test verifies the security fix: Referer header is ignored
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Setup request with spoofed Referer but no auth cookie
    req.cookies = {}; // No auth cookie
    req.headers = {
      referer: "https://example.com/contact", // Spoofed header
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should issue anonymous token (200), ignoring the Referer header
    // The contact form endpoint itself will decide if it accepts anonymous tokens
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
  });

  it("should issue anonymous token when invalid auth cookie present", async () => {
    // Set site config to not require login (default behavior for this test)
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: false,
    });

    // Mock jwt.verify to throw error for invalid cookie (called twice: once directly, once via verifyToken)
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error("Invalid token");
    });

    req.cookies = { authToken: "invalid-token" };
    req.headers = {};

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should clear invalid cookies and issue anonymous token (not block the request)
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ token: "test-jwt-token" });
    // Verify cookies were cleared
    expect(setCookieMock).toHaveBeenCalledWith("authToken", "", expect.objectContaining({ expires: expect.any(Date) }));
    expect(setCookieMock).toHaveBeenCalledWith("hasSession", "", expect.objectContaining({ expires: expect.any(Date) }));
  });

  it("should set signed uuid cookie for anonymous visitors on public sites", async () => {
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: false,
    });

    req.cookies = {};
    setCookieMock.mockClear();

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(setCookieMock).toHaveBeenCalledWith(
      "uuid",
      expect.stringMatching(/^[0-9a-f-]{36}--[0-9a-f]{64}$/i),
      expect.objectContaining({
        httpOnly: false,
        path: "/",
      })
    );
  });

  it("should not set uuid cookie on login-required sites without auth", async () => {
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    req.cookies = {};
    setCookieMock.mockClear();

    await handler(req as NextApiRequest, res as NextApiResponse);

    const uuidSetCalls = setCookieMock.mock.calls.filter((call) => call[0] === "uuid" && call[1] !== "");
    expect(uuidSetCalls).toHaveLength(0);
  });

  it("should return 401 when invalid auth cookie present on login-required site", async () => {
    // Set site config to require login
    (loadSiteConfigSync as jest.Mock).mockReturnValue({
      requireLogin: true,
    });

    // Mock jwt.verify to throw error for invalid cookie
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error("Invalid token");
    });

    req.cookies = { authToken: "invalid-token" };
    req.headers = {};

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Should return 401 and clear invalid cookies
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Authentication required" });
    // Verify cookies were cleared
    expect(setCookieMock).toHaveBeenCalledWith("authToken", "", expect.objectContaining({ expires: expect.any(Date) }));
    expect(setCookieMock).toHaveBeenCalledWith("hasSession", "", expect.objectContaining({ expires: expect.any(Date) }));
  });
});
