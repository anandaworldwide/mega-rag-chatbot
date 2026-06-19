/**
 * Tests for the Password Login API endpoint
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/loginWithPassword";

jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
}));

const setCookieMock = jest.fn();
const getCookieMock = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    set: setCookieMock,
    get: getCookieMock,
  }));
});

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(true),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock-jwt-token"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("users"),
}));

jest.mock("@/utils/server/passwordUtils", () => ({
  comparePassword: jest.fn(),
}));

jest.mock("@/utils/server/uuidUtils", () => ({
  createSignedUUIDCookie: jest.fn((uuid: string) => `signed:${uuid}`),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((h) => h),
}));

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1, nanoseconds: 0 })),
    },
  },
}));

const mockRunTransaction = jest.fn();
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
  },
}));

import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { comparePassword } from "@/utils/server/passwordUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockComparePassword = comparePassword as jest.MockedFunction<typeof comparePassword>;
const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;

describe("Password Login API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECURE_TOKEN = "test-secret";
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin: true } as any);
    mockGenericRateLimiter.mockResolvedValue(true);
    mockRunTransaction.mockImplementation(async (fn) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          get: (field: string) => (field === "uuid" ? "11111111-1111-1111-1111-111111111111" : undefined),
        }),
        set: jest.fn(),
      };
      await fn(tx);
    });
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(405);
  });

  it("returns 403 when requireLogin is false", async () => {
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin: false } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", password: "Password1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
  });

  it("returns access denied when blacklisted", async () => {
    process.env.SITE_ID = "test-site";
    const blacklist = await import("@/utils/server/blacklist");
    jest.mocked(blacklist.isEmailBlacklisted).mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "bad@example.com", password: "Password1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
  });

  it("returns 400 when email is missing", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { password: "Password1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe("Email is required");
  });

  it("returns 400 when password is missing", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe("Password is required");
  });

  it("returns 400 when user not found", async () => {
    mockFirestoreGet.mockResolvedValueOnce({ exists: false } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "missing@example.com", password: "Password1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe("Invalid email or password");
  });

  it("returns 400 when account not activated", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "pending", passwordHash: "hash" }),
    } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "pending@example.com", password: "Password1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe("Account not activated");
  });

  it("returns 400 when password is incorrect", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "accepted", passwordHash: "hash" }),
    } as any);
    mockComparePassword.mockResolvedValueOnce(false);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", password: "WrongPass1" },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe("Invalid email or password");
  });

  it("returns 200 and sets cookies on successful login", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        passwordHash: "hash",
        role: "user",
        uuid: "11111111-1111-1111-1111-111111111111",
      }),
    } as any);
    mockComparePassword.mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", password: "Password1" },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "ok" });
    expect(setCookieMock).toHaveBeenCalledWith("authToken", "mock-jwt-token", expect.any(Object));
  });

  it("stops when rate limiter denies request", async () => {
    mockGenericRateLimiter.mockResolvedValueOnce(false);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", password: "Password1" },
    });
    await handler(req, res);
    expect(mockFirestoreGet).not.toHaveBeenCalled();
  });
});
