import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/pendingRequests";

// Mock firebase-admin
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({
        seconds: Math.floor(Date.now() / 1000),
        nanoseconds: 0,
        toDate: jest.fn(() => new Date()),
      })),
      fromDate: jest.fn((date: Date) => ({
        seconds: Math.floor(date.getTime() / 1000),
        nanoseconds: 0,
        toDate: jest.fn(() => date),
      })),
    },
  },
}));

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
  getTokenFromRequest: jest.fn(),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
}));

jest.mock("@/utils/server/emailTemplates", () => ({
  createEmailParams: jest.fn().mockReturnValue({
    Source: "noreply@ananda.org",
    Destination: { ToAddresses: ["user@example.com"] },
    Message: {
      Subject: { Data: "Test Subject" },
      Body: {
        Html: { Data: "<html>Test</html>" },
        Text: { Data: "Test" },
      },
    },
  }),
}));

jest.mock("@aws-sdk/client-ses", () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    SESClient: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    SendEmailCommand: jest.fn(),
    mockSend,
  };
});

jest.mock("@/utils/server/userInviteUtils", () => ({
  generateInviteToken: jest.fn().mockReturnValue("mock-token-123"),
  hashInviteToken: jest.fn().mockResolvedValue("hashed-token"),
  getInviteExpiryDate: jest.fn().mockReturnValue(new Date("2025-12-31")),
  sendActivationEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("dev_users"),
}));

describe("/api/admin/pendingRequests", () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { db } = require("@/services/firebase");
  const { genericRateLimiter } = require("@/utils/server/genericRateLimiter");
  const { getTokenFromRequest } = require("@/utils/server/jwtUtils");
  const { writeAuditLog } = require("@/utils/server/auditLog");
  const loadSiteConfig = require("@/utils/server/loadSiteConfig");
  const { mockSend } = require("@aws-sdk/client-ses");
  /* eslint-enable @typescript-eslint/no-var-requires */

  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_BASE_URL: "https://test.ananda.org",
      CONTACT_EMAIL: "test@ananda.org",
      SITE_ID: "ananda",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("GET - List pending requests", () => {
    it("should return 401 if admin email not found", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: undefined, role: "admin" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({ error: "Admin email not found" });
    });

    it("should return 403 if user is not admin", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "user@example.com", role: "user" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Admin privileges required" });
    });

    it("should return pending requests for authenticated admin", async () => {
      const mockRequests = [
        {
          requestId: "req_1",
          requesterEmail: "user1@example.com",
          requesterName: "User One",
          adminEmail: "admin@example.com",
          adminName: "Admin User",
          adminLocation: "Test City, CA",
          status: "pending",
          createdAt: { seconds: 1234567890, nanoseconds: 0 },
          updatedAt: { seconds: 1234567890, nanoseconds: 0 },
        },
        {
          requestId: "req_2",
          requesterEmail: "user2@example.com",
          requesterName: "User Two",
          adminEmail: "admin@example.com",
          adminName: "Admin User",
          adminLocation: "Test City, CA",
          status: "pending",
          createdAt: { seconds: 1234567800, nanoseconds: 0 },
          updatedAt: { seconds: 1234567800, nanoseconds: 0 },
        },
      ];

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockGet = jest.fn().mockResolvedValue({
        forEach: (callback: (doc: any) => void) => {
          mockRequests.forEach((request) => {
            callback({ data: () => request });
          });
        },
      });

      db.collection.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: mockGet,
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.requests).toHaveLength(2);
      expect(response.requests[0].requestId).toBe("req_1");
    });
  });

  describe("POST - Approve/deny request", () => {
    it("should return 400 for missing requestId", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          action: "approve",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Request ID is required" });
    });

    it("should return 400 for invalid action", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_123",
          action: "invalid",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Action must be 'approve' or 'deny'" });
    });

    it("should approve a request successfully", async () => {
      const mockRequest = {
        requestId: "req_123",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockUpdate = jest.fn();
      const mockSet = jest.fn();
      const mockTransactionGet = jest
        .fn()
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        .mockResolvedValueOnce({
          exists: false,
        });

      const mockTransaction = {
        get: mockTransactionGet,
        update: mockUpdate,
        set: mockSet,
      };

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockRequest,
      });

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      });

      db.runTransaction.mockImplementation(async (callback: any) => {
        return callback(mockTransaction);
      });

      writeAuditLog.mockResolvedValue(undefined);
      mockSend.mockResolvedValue({});

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_123",
          action: "approve",
          message: "Welcome to the community!",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("Request approved successfully");
      expect(response.requestId).toBe("req_123");

      // Verify transaction operations were called
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "approved",
          processedBy: "admin@example.com",
          adminMessage: "Welcome to the community!",
        })
      );

      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          role: "user",
          inviteStatus: "pending",
          invitedByEmail: "admin@example.com",
        })
      );
    });

    it("should deny a request successfully", async () => {
      const mockRequest = {
        requestId: "req_456",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockUpdate = jest.fn();
      const mockTransactionGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockRequest,
      });

      const mockTransaction = {
        get: mockTransactionGet,
        update: mockUpdate,
      };

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockRequest,
      });

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      });

      db.runTransaction.mockImplementation(async (callback: any) => {
        return callback(mockTransaction);
      });

      writeAuditLog.mockResolvedValue(undefined);
      mockSend.mockResolvedValue({});

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_456",
          action: "deny",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("Request denied successfully");

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "denied",
          processedBy: "admin@example.com",
        })
      );
    });

    it("should return 404 if request not found", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockGet = jest.fn().mockResolvedValue({
        exists: false,
      });

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_nonexistent",
          action: "approve",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({ error: "Request not found" });
    });

    it("should return 403 if admin is not authorized", async () => {
      const mockRequest = {
        requestId: "req_789",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "other-admin@example.com",
        adminName: "Other Admin",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockRequest,
      });

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_789",
          action: "approve",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "You are not authorized to process this request" });
    });

    it("should return 400 if request already processed", async () => {
      const mockRequest = {
        requestId: "req_999",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test City, CA",
        status: "approved",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567900, nanoseconds: 0 },
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockRequest,
      });

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_999",
          action: "approve",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Request already approved" });
    });
  });

  it("should return 405 for unsupported methods", async () => {
    genericRateLimiter.mockResolvedValue(true);
    getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({ error: "Method not allowed" });
  });

  it("should apply rate limiting", async () => {
    genericRateLimiter.mockResolvedValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(genericRateLimiter).toHaveBeenCalled();
  });
});
