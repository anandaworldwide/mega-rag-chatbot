import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/addUser";

// Mock Firebase
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  },
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1640995200, nanoseconds: 0 })),
      fromDate: jest.fn((date) => ({ seconds: Math.floor(date.getTime() / 1000), nanoseconds: 0 })),
    },
  },
}));

// Mock JWT auth
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
}));

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

// Mock user invite utils
jest.mock("@/utils/server/userInviteUtils", () => ({
  generateInviteToken: jest.fn(() => "test-token"),
  hashInviteToken: jest.fn(() => Promise.resolve("hashed-token")),
  getInviteExpiryDate: jest.fn(() => new Date()),
  sendActivationEmail: jest.fn(() => Promise.resolve()),
}));

// Mock Firestore utils
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
  firestoreSet: jest.fn(),
}));

// Mock getUsersCollectionName
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));

describe("/api/admin/addUser", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = { ...originalEnv, SITE_ID: "test-site" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { "x-test-role": "admin" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({
      error: "Method not allowed",
    });
  });

  it("should return 400 for missing email", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: { "x-test-role": "admin" },
      body: {},
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Invalid email",
    });
  });

  it("should create new user successfully", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");

    // Mock user doesn't exist
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: false,
    });

    // Mock successful firestore set
    (firestoreRetryUtils.firestoreSet as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock successful email sending
    (userInviteUtils.sendActivationEmail as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: { "x-test-role": "admin" },
      body: {
        email: "test@example.com",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "created",
    });

    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        // Note: email is now stored as document ID, not as a field
        role: "user",
        entitlements: { basic: true },
        inviteStatus: "pending",
        newsletterSubscribed: true, // Should default to true
      }),
      undefined,
      "create user"
    );

    expect(userInviteUtils.sendActivationEmail).toHaveBeenCalledWith(
      "test@example.com",
      "test-token",
      expect.any(Object),
      undefined
    );
  });

  it("returns 400 when email is blacklisted", async () => {
    const blacklist = await import("@/utils/server/blacklist");
    jest.mocked(blacklist.isEmailBlacklisted).mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: { "x-test-role": "admin" },
      body: { email: "bad@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Email is blacklisted" });
  });

  it("should resend activation for existing pending user", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");

    // Mock user exists and is pending
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        email: "test@example.com",
        inviteStatus: "pending",
        role: "user",
      }),
    });

    // Mock successful firestore update
    (firestoreRetryUtils.firestoreSet as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock successful email sending
    (userInviteUtils.sendActivationEmail as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: { "x-test-role": "admin" },
      body: {
        email: "test@example.com",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "resent",
    });

    expect(userInviteUtils.sendActivationEmail).toHaveBeenCalledWith(
      "test@example.com",
      "test-token",
      expect.any(Object),
      undefined
    );
  });
});
