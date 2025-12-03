import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/verifyAccess";

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

// Mock bcrypt
jest.mock("bcryptjs", () => ({
  compare: jest.fn(() => Promise.resolve(true)),
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

// Mock Firestore utils
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
  firestoreSet: jest.fn(),
}));

// Mock audit log
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

// Mock domain whitelist utils
jest.mock("@/utils/server/domainWhitelistUtils", () => ({
  isEmailDomainWhitelisted: jest.fn(() => Promise.resolve(false)),
}));

describe("Setup file", () => {
  it("should be valid", () => {
    expect(true).toBe(true);
  });
});

describe("/api/auth/verifyAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("should return 400 for missing email", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {},
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("should create new user with newsletter defaulted to true", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");
    const auditLog = await import("@/utils/server/auditLog");
    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");

    // Mock email as whitelisted
    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValueOnce(true);

    // Mock user doesn't exist
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: false,
    });

    // Mock successful firestore set
    (firestoreRetryUtils.firestoreSet as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock successful email sending
    (userInviteUtils.sendActivationEmail as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock audit log
    (auditLog.writeAuditLog as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
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
        email: "test@example.com",
        role: "user",
        entitlements: { basic: true },
        inviteStatus: "pending",
        newsletterSubscribed: true, // Should default to true
      }),
      undefined,
      "create user via verify access"
    );

    expect(userInviteUtils.sendActivationEmail).toHaveBeenCalledWith(
      "test@example.com",
      "test-token",
      expect.any(Object)
    );
  });

  it("should resend activation for existing pending user", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");
    const auditLog = await import("@/utils/server/auditLog");
    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");

    // Mock email as whitelisted
    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValueOnce(true);

    // Mock user exists and is pending
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "pending",
      }),
    });

    // Mock successful firestore set
    (firestoreRetryUtils.firestoreSet as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock successful email sending
    (userInviteUtils.sendActivationEmail as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    // Mock audit log
    (auditLog.writeAuditLog as jest.MockedFunction<any>).mockResolvedValueOnce(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "test@example.com",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "activation-resent",
    });
  });

  it("should return already active for accepted users", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");

    // Mock email as whitelisted
    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValueOnce(true);

    // Mock user exists and is already accepted
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
      }),
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "test@example.com",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "already active",
    });
  });

  it("should return requires_admin_approval for non-whitelisted email without password", async () => {
    const auditLog = await import("@/utils/server/auditLog");
    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");

    // Mock whitelist to return false
    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValueOnce(false);
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValueOnce(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        email: "nonwhitelisted@example.com",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      message: "requires_admin_approval",
    });
    expect(firestoreRetryUtils.firestoreGet).not.toHaveBeenCalled();
    expect(firestoreRetryUtils.firestoreSet).not.toHaveBeenCalled();
    expect(userInviteUtils.sendActivationEmail).not.toHaveBeenCalled();
  });

  it("should return requires_admin_approval for non-whitelisted email", async () => {
    const mockEmail = "nonwhitelisted@example.com";
    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");
    const auditLog = await import("@/utils/server/auditLog");
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");

    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValue(false);
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: mockEmail },
    });

    await handler(req, res);

    expect(domainWhitelistUtils.isEmailDomainWhitelisted).toHaveBeenCalledWith(mockEmail, process.env.SITE_ID);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "requires_admin_approval" });
    expect(auditLog.writeAuditLog).toHaveBeenCalledWith(req, "self_provision_attempt", mockEmail.toLowerCase(), {
      outcome: "non_whitelisted_request",
    });
    expect(firestoreRetryUtils.firestoreGet).not.toHaveBeenCalled(); // No user query
    expect(userInviteUtils.sendActivationEmail).not.toHaveBeenCalled();
    expect(firestoreRetryUtils.firestoreSet).not.toHaveBeenCalled();
  });

  it("should create pending user for new whitelisted email", async () => {
    const mockEmail = "whitelisted@example.com";
    const mockToken = "mock-token";
    const mockTokenHash = "mock-hash";
    const mockExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const domainWhitelistUtils = await import("@/utils/server/domainWhitelistUtils");
    const userInviteUtils = await import("@/utils/server/userInviteUtils");
    const auditLog = await import("@/utils/server/auditLog");
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");

    const firebase = await import("firebase-admin");
    jest.spyOn(domainWhitelistUtils, "isEmailDomainWhitelisted").mockResolvedValue(true);
    jest.spyOn(userInviteUtils, "generateInviteToken").mockReturnValue(mockToken);
    jest.spyOn(userInviteUtils, "hashInviteToken").mockResolvedValue(mockTokenHash);
    jest.spyOn(firebase.firestore.Timestamp, "fromDate").mockReturnValue(mockExpiry as any);
    (firestoreRetryUtils.firestoreGet as jest.Mock).mockResolvedValue({ exists: false });
    jest.spyOn(userInviteUtils, "sendActivationEmail").mockResolvedValue(undefined);
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: mockEmail },
    });

    await handler(req, res);

    expect(domainWhitelistUtils.isEmailDomainWhitelisted).toHaveBeenCalledWith(mockEmail, process.env.SITE_ID);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "created" });
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: mockEmail.toLowerCase(),
        role: "user",
        entitlements: { basic: true },
        inviteStatus: "pending",
        newsletterSubscribed: true,
      }),
      undefined,
      "create user via verify access"
    );
    expect(userInviteUtils.sendActivationEmail).toHaveBeenCalledWith(mockEmail, mockToken, req);
    expect(auditLog.writeAuditLog).toHaveBeenCalledWith(req, "self_provision_attempt", mockEmail.toLowerCase(), {
      outcome: "created_pending_user_whitelisted",
    });
  });
});
