/**
 * Tests for the Password Login API endpoint
 *
 * This file tests the functionality of the password login API endpoint, including:
 * - Method validation (only POST allowed)
 * - Input validation (email, password format)
 * - Rate limiting
 * - Authentication logic with bcrypt
 * - Cookie setting
 * - Site configuration check (requireLogin)
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/loginWithPassword";

// Mock bcrypt
jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
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
}));

// Mock environment check
jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

// Mock site config
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

// Mock JWT utilities
jest.mock("@/utils/server/jwtUtils", () => ({
  signToken: jest.fn().mockReturnValue("mock-jwt-token"),
}));

// Mock Firestore utilities
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("users"),
  getDb: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  })),
}));

// Mock audit log
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));

// Import the mocked functions
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

describe("Password Login API", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for siteConfig
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    } as any);
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(405);
  });

  it("returns access denied when blacklisted", async () => {
    process.env.SITE_ID = "test-site";
    const blacklist = await import("@/utils/server/blacklist");
    jest.mocked(blacklist.isEmailBlacklisted).mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "bad@example.com", password: "password1" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Access denied. Please contact your administrator." });
  });
});
