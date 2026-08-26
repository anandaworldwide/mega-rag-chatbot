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
  loadSiteConfigSync: jest.fn(() => ({ requireLogin: false })),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
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
  const { db } = jest.requireMock("@/services/firebase");
  const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");
  const { getTokenFromRequest } = jest.requireMock("@/utils/server/jwtUtils");
  const { writeAuditLog } = jest.requireMock("@/utils/server/auditLog");
  const loadSiteConfig = jest.requireMock("@/utils/server/loadSiteConfig");
  const { mockSend } = jest.requireMock("@aws-sdk/client-ses");
  const blacklistMod = jest.requireMock("@/utils/server/blacklist");

  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    blacklistMod.isEmailBlacklisted.mockResolvedValue(false);

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

    it("returns 400 when requester is blacklisted on approve", async () => {
      const mockRequest = {
        requestId: "req_123",
        requesterEmail: "bad@example.com",
        requesterName: "Bad",
        adminEmail: "admin@example.com",
        adminName: "Admin",
        adminLocation: "Here",
        status: "pending",
        createdAt: { seconds: 1, nanoseconds: 0 },
        updatedAt: { seconds: 1, nanoseconds: 0 },
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
      blacklistMod.isEmailBlacklisted.mockResolvedValueOnce(true);

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
        body: { requestId: "req_123", action: "approve" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Email is blacklisted" });
      expect(db.runTransaction).not.toHaveBeenCalled();
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

      const mockAdminUser = {
        firstName: "Admin",
        lastName: "User",
        email: "admin@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockUpdate = jest.fn();
      const mockSet = jest.fn();
      const mockTransactionGet = jest
        .fn()
        // First call: request document
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        // Second call: admin user document (for processedByName lookup)
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockAdminUser,
        })
        // Third call: requester user document
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
          processedByName: "Admin User",
          adminMessage: "Welcome to the community!",
        })
      );

      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          role: "user",
          inviteStatus: "pending",
          invitedByEmail: "admin@example.com",
          invitedByName: "Admin User",
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

      const mockAdminUser = {
        firstName: "Admin",
        lastName: "User",
        email: "admin@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockUpdate = jest.fn();
      const mockTransactionGet = jest
        .fn()
        // First call: request document
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        // Second call: admin user document (for processedByName lookup)
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockAdminUser,
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
          privateNote: "Does not appear to be connected to Ananda",
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
          processedByName: "Admin User",
          adminPrivateNote: "Does not appear to be connected to Ananda",
        })
      );
      expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty("adminMessage");
    });

    it("should return 400 when denying without a private note", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_456",
          action: "deny",
          message: "Sorry, we cannot approve this request",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Private admin note is required when denying a request",
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(db.runTransaction).not.toHaveBeenCalled();
    });

    it("should return 400 when denying with a whitespace-only private note", async () => {
      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_456",
          action: "deny",
          privateNote: "   \n\t  ",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Private admin note is required when denying a request",
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should deny with private note only and omit it from the denial email", async () => {
      const mockRequest = {
        requestId: "req_priv_only",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      const mockAdminUser = {
        firstName: "Admin",
        lastName: "User",
        email: "admin@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Luca",
        shortname: "Luca",
      });

      const mockUpdate = jest.fn();
      const mockTransactionGet = jest
        .fn()
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockAdminUser,
        });

      const mockTransaction = {
        get: mockTransactionGet,
        update: mockUpdate,
      };

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => mockRequest,
          }),
        }),
      });

      db.runTransaction.mockImplementation(async (callback: any) => {
        return callback(mockTransaction);
      });

      writeAuditLog.mockResolvedValue(undefined);
      mockSend.mockResolvedValue({});

      const privateNote = "Suspected spam / unknown person";
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_priv_only",
          action: "deny",
          privateNote,
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "denied",
          adminPrivateNote: privateNote,
        })
      );
      expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty("adminMessage");

      const { createEmailParams } = jest.requireMock("@/utils/server/emailTemplates");
      expect(createEmailParams).toHaveBeenCalled();
      const emailOptions = createEmailParams.mock.calls[createEmailParams.mock.calls.length - 1][3];
      expect(emailOptions.message).not.toContain(privateNote);
      expect(emailOptions.message).not.toContain("Message from");
    });

    it("should deny with both messages and email only the user-facing message", async () => {
      const mockRequest = {
        requestId: "req_both",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      const mockAdminUser = {
        firstName: "Admin",
        lastName: "User",
        email: "admin@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "admin" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Luca",
        shortname: "Luca",
      });

      const mockUpdate = jest.fn();
      const mockTransactionGet = jest
        .fn()
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockAdminUser,
        });

      const mockTransaction = {
        get: mockTransactionGet,
        update: mockUpdate,
      };

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => mockRequest,
          }),
        }),
      });

      db.runTransaction.mockImplementation(async (callback: any) => {
        return callback(mockTransaction);
      });

      writeAuditLog.mockResolvedValue(undefined);
      mockSend.mockResolvedValue({});

      const userMessage = "We were unable to verify your connection to Ananda.";
      const privateNote = "No matching Salesforce record; unknown email domain";
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_both",
          action: "deny",
          message: userMessage,
          privateNote,
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "denied",
          adminMessage: userMessage,
          adminPrivateNote: privateNote,
        })
      );

      const { createEmailParams } = jest.requireMock("@/utils/server/emailTemplates");
      const emailOptions = createEmailParams.mock.calls[createEmailParams.mock.calls.length - 1][3];
      expect(emailOptions.message).toContain(userMessage);
      expect(emailOptions.message).not.toContain(privateNote);
    });

    it("should attribute denial email to the processor, not the assigned admin", async () => {
      const mockRequest = {
        requestId: "req_override",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "assigned-admin@example.com",
        adminName: "Assigned Admin",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      const mockSuperuser = {
        firstName: "Michael",
        lastName: "Olivier",
        email: "superuser@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      getTokenFromRequest.mockReturnValue({ email: "superuser@example.com", role: "superuser" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({
        siteId: "ananda",
        name: "Luca",
        shortname: "Luca",
      });

      const mockUpdate = jest.fn();
      const mockTransactionGet = jest
        .fn()
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockSuperuser,
        });

      const mockTransaction = {
        get: mockTransactionGet,
        update: mockUpdate,
      };

      db.collection.mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => mockRequest,
          }),
        }),
      });

      db.runTransaction.mockImplementation(async (callback: any) => {
        return callback(mockTransaction);
      });

      writeAuditLog.mockResolvedValue(undefined);
      mockSend.mockResolvedValue({});

      const userMessage = "We weren't able to verify your connection this time.";
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requestId: "req_override",
          action: "deny",
          message: userMessage,
          privateNote: "Superuser override of assigned admin queue",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "denied",
          processedBy: "superuser@example.com",
          processedByName: "Michael Olivier",
        })
      );

      const { createEmailParams } = jest.requireMock("@/utils/server/emailTemplates");
      const emailOptions = createEmailParams.mock.calls[createEmailParams.mock.calls.length - 1][3];
      expect(emailOptions.message).toContain("denied by Michael Olivier");
      expect(emailOptions.message).toContain("Message from Michael Olivier");
      expect(emailOptions.message).toContain(userMessage);
      expect(emailOptions.message).toContain("superuser@example.com");
      expect(emailOptions.message).not.toContain("Assigned Admin");
      expect(emailOptions.message).not.toContain("assigned-admin@example.com");
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

    it("should allow superuser to approve request assigned to another admin", async () => {
      const mockRequest = {
        requestId: "req_super",
        requesterEmail: "user@example.com",
        requesterName: "Test User",
        adminEmail: "other-admin@example.com", // Assigned to different admin
        adminName: "Other Admin",
        adminLocation: "Test City, CA",
        status: "pending",
        createdAt: { seconds: 1234567890, nanoseconds: 0 },
        updatedAt: { seconds: 1234567890, nanoseconds: 0 },
      };

      const mockSuperuserData = {
        firstName: "Super",
        lastName: "User",
        email: "superuser@example.com",
      };

      genericRateLimiter.mockResolvedValue(true);
      // Superuser can approve any request
      getTokenFromRequest.mockReturnValue({ email: "superuser@example.com", role: "superuser" });
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockUpdate = jest.fn();
      const mockSet = jest.fn();
      const mockTransactionGet = jest
        .fn()
        // First call: request document
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockRequest,
        })
        // Second call: superuser document (for processedByName lookup)
        .mockResolvedValueOnce({
          exists: true,
          data: () => mockSuperuserData,
        })
        // Third call: requester user document
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
          requestId: "req_super",
          action: "approve",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("Request approved successfully");

      // Verify the superuser's info is stored, NOT the originally assigned admin
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "approved",
          processedBy: "superuser@example.com", // Actual approver
          processedByName: "Super User", // Actual approver's name
        })
      );

      // User record should show who actually approved them
      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          invitedByEmail: "superuser@example.com", // Actual approver
          invitedByName: "Super User", // Actual approver's name
        })
      );
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
