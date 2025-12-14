/**
 * Tests for the Login API endpoint
 *
 * This file tests the functionality of the login API endpoint, including:
 * - Method validation (only POST allowed)
 * - Input validation (password format, redirect URL)
 * - Rate limiting
 * - Authentication logic
 * - Cookie setting
 * - Redirect handling
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import handler from "@/pages/api/login";

// Mock bcrypt
jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
}));

// Mock crypto
jest.mock("crypto", () => ({
  createHash: jest.fn().mockReturnValue({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue("mocked-hashed-token"),
  }),
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

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
}));

// Mock environment check
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

// Mock CORS middleware
jest.mock("@/utils/server/corsMiddleware", () => ({
  __esModule: true,
  default: jest.fn(),
  runMiddleware: jest.fn().mockResolvedValue(undefined),
  setCorsHeaders: jest.fn(),
  createErrorCorsHeaders: jest.fn().mockReturnValue({}),
}));

// Mock new utils
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(),
      })),
    })),
  },
}));
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
  firestoreSet: jest.fn(),
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(),
}));
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn(),
  verify: jest.fn(),
}));

describe("Login API", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
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
      message: "Method not allowed",
    });
  });

  it("should handle OPTIONS request for CORS", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "OPTIONS",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(res._isEndCalled()).toBe(true);
  });

  it("should validate password presence", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "test@example.com",
        password: "",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid password",
    });
  });

  it("should validate password length", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "test@example.com",
        password: "12345", // too short
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid password length",
    });
  });

  it("should validate redirect URL", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "test@example.com",
        password: "validpassword123",
        redirect: 'javascript:alert("xss")', // invalid URL
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid redirect URL",
    });
  });

  it("should authenticate valid email and password", async () => {
    const mockEmail = "user@example.com";
    const mockPassword = "validpass123";
    const mockUserData = {
      passwordHash: "mock-hash",
      role: "user",
      entitlements: { basic: true },
      inviteStatus: "accepted",
    };
    const mockJwt = "mock-jwt";

    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => mockUserData,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue(mockJwt);
    (getUsersCollectionName as jest.Mock).mockReturnValue("users");
    process.env.SECURE_TOKEN = "test-secret";
    process.env.SITE_ID = "test-site";

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: mockEmail, password: mockPassword, redirect: "/" },
    });

    await handler(req, res);

    expect(firestoreGet).toHaveBeenCalledWith(expect.anything(), "user login", mockEmail.toLowerCase().trim());
    expect(bcrypt.compare).toHaveBeenCalledWith(mockPassword.trim(), "mock-hash");
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        client: "web",
        email: mockEmail.toLowerCase().trim(),
        role: "user",
        entitlements: { basic: true },
        site: "test-site",
      },
      "test-secret",
      {
        expiresIn: "180d",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "Authenticated", redirect: "/" });
    // Note: Cookie setting is tested via integration tests; node-mocks-http doesn't fully support cookie headers
  });

  it("should fail for invalid email", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "invalid-email", password: "pass123" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ message: "Invalid email" });
  });

  it("should fail for missing email", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { password: "pass123" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ message: "Invalid email" });
  });

  it("should fail for inactive user", async () => {
    const mockEmail = "inactive@example.com";
    const mockPassword = "pass123";

    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => ({
        passwordHash: "mock-hash",
        inviteStatus: "pending", // Inactive
      }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: mockEmail, password: mockPassword },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ message: "Account not activated" });
  });

  it("should fail for non-existent user", async () => {
    (firestoreGet as jest.Mock).mockResolvedValue({ exists: false });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "nonexistent@example.com", password: "pass123" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ message: "Invalid credentials" });
  });

  it("should fail for invalid password", async () => {
    const mockEmail = "user@example.com";
    const mockPassword = "wrongpass";

    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => ({
        passwordHash: "mock-hash",
        role: "user",
        inviteStatus: "accepted",
      }),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: mockEmail, password: mockPassword },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ message: "Invalid credentials" });
  });

  it("should fail for user without passwordHash", async () => {
    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => ({
        role: "user",
        inviteStatus: "accepted",
        // No passwordHash
      }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", password: "pass123" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ message: "Password not set" });
  });

  it("should handle missing email", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        password: "validpassword123",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: "Invalid email",
    });
  });

  it("should handle missing SECURE_TOKEN", async () => {
    delete process.env.SECURE_TOKEN;

    const mockEmail = "user@example.com";
    const mockPassword = "validpass123";

    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => ({
        passwordHash: "mock-hash",
        role: "user",
        inviteStatus: "accepted",
      }),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (getUsersCollectionName as jest.Mock).mockReturnValue("users");

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: mockEmail,
        password: mockPassword,
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({
      message: "Server configuration error",
    });
  });

  it("should use default redirect if not provided", async () => {
    const mockEmail = "user@example.com";
    const mockPassword = "validpass123";
    const mockJwt = "mock-jwt";

    (firestoreGet as jest.Mock).mockResolvedValue({
      exists: true,
      data: () => ({
        passwordHash: "mock-hash",
        role: "user",
        entitlements: { basic: true },
        inviteStatus: "accepted",
      }),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (jwt.sign as jest.Mock).mockReturnValue(mockJwt);
    (getUsersCollectionName as jest.Mock).mockReturnValue("users");
    process.env.SECURE_TOKEN = "test-secret";
    process.env.SITE_ID = "test-site";

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: mockEmail,
        password: mockPassword,
      },
      headers: {
        "x-forwarded-proto": "https",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "Authenticated",
      redirect: "/",
    });
  });
});
