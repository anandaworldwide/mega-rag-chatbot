// Tests for the email-first login request API

// Mock Firebase admin timestamp
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ toDate: () => new Date() })),
      fromDate: jest.fn((d: Date) => ({ toDate: () => d })),
    },
  },
}));

// Mock Firestore service
const mockFirestoreWhere = jest.fn();
const mockFirestoreLimit = jest.fn();
const mockFirestoreGet = jest.fn();

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn((name: string) => {
      if (name.includes("admin_approval_requests")) {
        return {
          where: mockFirestoreWhere,
        };
      }
      return {
        doc: jest.fn().mockReturnThis(),
      };
    }),
    doc: jest.fn().mockReturnThis(),
  },
}));

// Mock helpers
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users-test"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => {
  const firestoreGet = jest.fn();
  const firestoreSet = jest.fn();
  return { firestoreGet, firestoreSet };
});

// Mock invite/login utils
jest.mock("@/utils/server/userLoginMagicUtils", () => {
  const sendLoginEmail = jest.fn();
  const hashLoginToken = jest.fn(async () => "hashed-login");
  const generateLoginToken = jest.fn(() => "login-token");
  const getLoginExpiryDateHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);
  return { sendLoginEmail, hashLoginToken, generateLoginToken, getLoginExpiryDateHours };
});

jest.mock("@/utils/server/userInviteUtils", () => {
  const sendActivationEmail = jest.fn();
  const hashInviteToken = jest.fn(async () => "hashed-invite");
  const generateInviteToken = jest.fn(() => "invite-token");
  const getInviteExpiryDate = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return { sendActivationEmail, hashInviteToken, generateInviteToken, getInviteExpiryDate };
});

// Mock domain whitelist utils
jest.mock("@/utils/server/domainWhitelistUtils", () => ({
  isEmailDomainWhitelisted: jest.fn(() => Promise.resolve(false)),
}));

// Mock audit log
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));

// Mock environment variables
const originalEnv = process.env;
beforeAll(() => {
  process.env = {
    ...originalEnv,
    SITE_ID: "test-site",
  };
});

afterAll(() => {
  process.env = originalEnv;
});

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/requestLoginLink";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { sendLoginEmail, hashLoginToken } from "@/utils/server/userLoginMagicUtils";
import { sendActivationEmail, hashInviteToken } from "@/utils/server/userInviteUtils";

describe("requestLoginLink API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns access denied when email is blacklisted", async () => {
    const blacklist = await import("@/utils/server/blacklist");
    jest.mocked(blacklist.isEmailBlacklisted).mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "bad@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Access denied. Please contact your administrator." });
    expect(firestoreGet).not.toHaveBeenCalled();
  });

  it("sends login link if user exists and is accepted; stores hashed token with 1h expiry", async () => {
    (firestoreGet as unknown as jest.Mock).mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "accepted" }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com", redirect: "/dashboard" },
    });

    await handler(req, res);

    // stores hashed login token with 1-hour expiry
    expect(hashLoginToken).toHaveBeenCalledWith("login-token");
    expect(firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ loginTokenHash: "hashed-login", loginTokenExpiresAt: expect.any(Object) }),
      expect.any(Object),
      "store login token"
    );
    expect(sendLoginEmail).toHaveBeenCalledWith("user@example.com", "login-token", "/dashboard", expect.any(Object));
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "login-link-sent" });
  });

  it("returns a generic error when sending the login email fails", async () => {
    (firestoreGet as unknown as jest.Mock).mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "accepted" }),
    });
    (sendLoginEmail as jest.Mock).mockRejectedValueOnce(
      new Error('[EntityReplacer] Invalid character "#" in entity name: "#xD"')
    );

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "Unable to send login link. Please try again later." });
  });

  it("resends activation if user exists and is pending; stores hashed invite token with 14d expiry", async () => {
    (firestoreGet as unknown as jest.Mock).mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "pending" }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user2@example.com" },
    });

    await handler(req, res);

    // stores hashed invite token with 14-day expiry and sends activation email
    expect(hashInviteToken).toHaveBeenCalledWith("invite-token");
    expect(firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inviteTokenHash: "hashed-invite", inviteExpiresAt: expect.any(Object) }),
      expect.any(Object),
      "update pending user for resend"
    );
    expect(sendActivationEmail).toHaveBeenCalledWith("user2@example.com", "invite-token", expect.any(Object));
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "activation-resent" });
  });

  it("returns next=request-approval when user is not found and no pending request exists", async () => {
    (firestoreGet as unknown as jest.Mock).mockResolvedValueOnce({ exists: false, data: () => null });

    // Mock: no pending approval request
    mockFirestoreWhere.mockReturnValue({
      where: mockFirestoreWhere,
      limit: mockFirestoreLimit,
    });
    mockFirestoreLimit.mockReturnValue({
      get: mockFirestoreGet,
    });
    mockFirestoreGet.mockResolvedValueOnce({ empty: true, docs: [] });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "unknown@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ next: "request-approval", isWhitelisted: false });
  });

  it("returns next=request-pending with admin info when pending approval request exists", async () => {
    (firestoreGet as unknown as jest.Mock).mockResolvedValueOnce({ exists: false, data: () => null });

    // Mock: pending approval request exists
    const mockCreatedAt = new Date("2024-01-15T10:00:00Z");
    mockFirestoreWhere.mockReturnValue({
      where: mockFirestoreWhere,
      limit: mockFirestoreLimit,
    });
    mockFirestoreLimit.mockReturnValue({
      get: mockFirestoreGet,
    });
    mockFirestoreGet.mockResolvedValueOnce({
      empty: false,
      docs: [
        {
          data: () => ({
            adminName: "John Admin",
            adminEmail: "admin@example.com",
            adminLocation: "San Francisco, CA",
            createdAt: { toDate: () => mockCreatedAt },
          }),
        },
      ],
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "pending@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.next).toBe("request-pending");
    expect(data.pendingRequest).toEqual({
      adminName: "John Admin",
      adminEmail: "admin@example.com",
      adminLocation: "San Francisco, CA",
      createdAt: mockCreatedAt.toISOString(),
    });
  });
});
