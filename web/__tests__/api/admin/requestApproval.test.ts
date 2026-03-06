import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/requestApproval";

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    })),
    fromDate: jest.fn((date: Date) => ({
      seconds: Math.floor(date.getTime() / 1000),
      nanoseconds: 0,
    })),
  };
  const mockFirestore = {
    Timestamp: mockTimestamp,
  };
  return {
    __esModule: true,
    default: {
      firestore: mockFirestore,
    },
    firestore: mockFirestore,
  };
});

// Mock dependencies
jest.mock("@/utils/server/awsConfig", () => ({
  ses: {
    send: jest.fn(),
  },
}));

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  },
}));

jest.mock("@/utils/server/redisUtils", () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreSet: jest.fn(),
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
}));

jest.mock("@/utils/server/domainWhitelistUtils", () => ({
  isEmailDomainWhitelisted: jest.fn(() => Promise.resolve(false)),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users"),
}));

jest.mock("@/utils/server/userInviteUtils", () => ({
  generateInviteToken: jest.fn(() => "test-token-123"),
  hashInviteToken: jest.fn(() => Promise.resolve("hashed-token")),
  getInviteExpiryDate: jest.fn(() => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)),
  sendActivationEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/utils/server/emailTemplates", () => ({
  createEmailParams: jest.fn().mockReturnValue({
    Source: "noreply@ananda.org",
    Destination: { ToAddresses: ["admin@example.com"] },
    Message: {
      Subject: { Data: "Test Subject" },
      Body: {
        Html: { Data: "<html>Test</html>" },
        Text: { Data: "Test" },
      },
    },
  }),
  generateEmailContent: jest.fn(),
}));

jest.mock("@aws-sdk/client-ses", () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    SESClient: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    SendEmailCommand: jest.fn(),
    mockSend, // Export for test access
  };
});

describe("/api/admin/requestApproval", () => {
  const firestoreRetryUtils = jest.requireMock("@/utils/server/firestoreRetryUtils");
  const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");
  const { writeAuditLog } = jest.requireMock("@/utils/server/auditLog");
  const loadSiteConfig = jest.requireMock("@/utils/server/loadSiteConfig");
  const { isEmailDomainWhitelisted } = jest.requireMock("@/utils/server/domainWhitelistUtils");
  const { sendActivationEmail } = jest.requireMock("@/utils/server/userInviteUtils");

  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations to defaults (clearAllMocks only clears call history)
    isEmailDomainWhitelisted.mockResolvedValue(false);

    // Set required environment variables
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      NEXT_PUBLIC_BASE_URL: "https://test.ananda.org",
      CONTACT_EMAIL: "test@ananda.org",
      SITE_ID: "ananda",
    };
  });

  afterEach(() => {
    // Restore original env vars
    process.env = originalEnv;
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("should apply rate limiting", async () => {
    genericRateLimiter.mockResolvedValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(genericRateLimiter).toHaveBeenCalled();
    // Rate limiter returns early, no further processing
  });

  it("should return 400 for missing requester email", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test Location",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Requester email is required" });
  });

  it("should return 400 for missing requester name", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test Location",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Requester name is required" });
  });

  it("should return 400 for missing admin email", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test User",
        adminName: "Admin User",
        adminLocation: "Test Location",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Admin email is required" });
  });

  it("should return 400 for missing admin name", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminLocation: "Test Location",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Admin name is required" });
  });

  it("should return 400 for missing admin location", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Admin location is required" });
  });

  it("should return 400 for invalid email format", async () => {
    genericRateLimiter.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "invalid-email",
        requesterName: "Test User",
        adminEmail: "admin@example.com",
        adminName: "Admin User",
        adminLocation: "Test Location",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Invalid email: Invalid email format" });
  });

  it("should create approval request successfully", async () => {
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("Approval request submitted successfully");
    expect(response.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);

    // Verify Firestore was called without referenceNote
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
        status: "pending",
      }),
      undefined,
      "create admin approval request"
    );

    // Verify audit log was called
    expect(writeAuditLog).toHaveBeenCalledWith(
      req,
      "admin_approval_request",
      "requester@example.com",
      expect.objectContaining({
        outcome: "request_created",
        adminEmail: "admin@example.com",
      })
    );
  });

  it("should create approval request with reference note", async () => {
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
        referenceNote: "I know Swami Kriyananda",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("Approval request submitted successfully");
    expect(response.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);

    // Verify Firestore was called with referenceNote
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
        referenceNote: "I know Swami Kriyananda",
        status: "pending",
      }),
      undefined,
      "create admin approval request"
    );
  });

  it("should handle errors gracefully", async () => {
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockRejectedValue(new Error("Database error"));
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    // Error message is sanitized, so it may differ from the original error message
    expect(res._getJSONData()).toHaveProperty("error");
    expect(typeof res._getJSONData().error).toBe("string");
  });

  it("should return error when email sending fails and cleanup the request", async () => {
    const mockSend = jest.requireMock("@aws-sdk/client-ses").mockSend;
    const mockDelete = jest.fn().mockResolvedValue(undefined);
    const mockDoc = jest.fn(() => ({
      delete: mockDelete,
    }));
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    // Mock SES send to throw an error
    mockSend.mockRejectedValueOnce({
      name: "MessageRejected",
      message:
        "Email address is not verified. The following identities failed the check in region US-WEST-1: admin@example.com",
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const responseData = res._getJSONData();
    expect(responseData.error).toBe(
      "Email sending failed due to unverified email addresses. Please contact support for assistance."
    );
    expect(responseData.details).toBe(
      "Email address is not verified. The following identities failed the check in region US-WEST-1: admin@example.com"
    ); // Should include details in development

    // Verify the request was cleaned up
    expect(mockCollection).toHaveBeenCalledWith("dev_admin_approval_requests");
    expect(mockDoc).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
  });

  it("should return generic error message for other email failures", async () => {
    const mockSend = jest.requireMock("@aws-sdk/client-ses").mockSend;
    const mockDelete = jest.fn().mockResolvedValue(undefined);
    const mockDoc = jest.fn(() => ({
      delete: mockDelete,
    }));
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    // Mock SES send to throw a generic error
    mockSend.mockRejectedValueOnce({
      name: "UnknownError",
      message: "Some unexpected email error occurred",
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const responseData = res._getJSONData();
    expect(responseData.error).toBe("Failed to send approval emails. Please try again or contact support.");

    // Verify cleanup was attempted
    expect(mockCollection).toHaveBeenCalledWith("dev_admin_approval_requests");
    expect(mockDoc).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
  });

  it("should resend reminder email when pending request already exists for same requester and admin", async () => {
    const existingRequestId = "req_123456789_abc123";
    const mockGet = jest.fn().mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            requestId: existingRequestId,
            requesterEmail: "requester@example.com",
            requesterName: "Test Requester",
            adminEmail: "admin@example.com",
            adminName: "Test Admin",
            adminLocation: "Test City, CA",
            status: "pending",
          }),
        },
      ],
    });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockCollection = jest.fn(() => ({
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("A pending request already exists. We've sent the administrator another reminder.");
    expect(response.requestId).toBe(existingRequestId);
    expect(response.isReminder).toBe(true);

    // Verify no new Firestore document was created
    expect(firestoreRetryUtils.firestoreSet).not.toHaveBeenCalled();

    // Verify query was made with correct parameters
    expect(mockCollection).toHaveBeenCalledWith("dev_admin_approval_requests");
    expect(mockWhere).toHaveBeenCalledWith("requesterEmail", "==", "requester@example.com");
    expect(mockWhere).toHaveBeenCalledWith("adminEmail", "==", "admin@example.com");
    expect(mockWhere).toHaveBeenCalledWith("status", "==", "pending");

    // Verify audit log was called for reminder
    expect(writeAuditLog).toHaveBeenCalledWith(
      req,
      "admin_approval_reminder",
      "requester@example.com",
      expect.objectContaining({
        outcome: "reminder_sent",
        adminEmail: "admin@example.com",
        requestId: existingRequestId,
      })
    );
  });

  it("should allow new request if previous request to same admin was already processed", async () => {
    const mockGet = jest.fn().mockResolvedValue({
      empty: true,
      docs: [],
    });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      where: mockWhere,
      doc: mockDoc,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("Approval request submitted successfully");
    expect(response.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
    expect(response.isReminder).toBeUndefined();

    // Verify new Firestore document was created
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalled();

    // Verify audit log was called for new request
    expect(writeAuditLog).toHaveBeenCalledWith(
      req,
      "admin_approval_request",
      "requester@example.com",
      expect.objectContaining({
        outcome: "request_created",
        adminEmail: "admin@example.com",
      })
    );
  });

  it("should block new request to different admin when pending request exists with another admin", async () => {
    const existingRequestId = "req_123456789_existing";
    const mockSend = jest.requireMock("@aws-sdk/client-ses").mockSend;

    // First query: Check for same requesterEmail + adminEmail (should return empty)
    // Second query: Check for any pending request with same requesterEmail (should return existing request)
    const mockGetSameAdmin = jest.fn().mockResolvedValue({
      empty: true,
      docs: [],
    });
    const mockGetAnyAdmin = jest.fn().mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            requestId: existingRequestId,
            requesterEmail: "requester@example.com",
            requesterName: "Test Requester",
            adminEmail: "admin1@example.com", // Different admin
            adminName: "Test Admin 1",
            adminLocation: "Test City 1, CA",
            status: "pending",
          }),
        },
      ],
    });

    // Create separate mock chains for the two queries
    let callCount = 0;
    const mockWhere: any = jest.fn(() => {
      callCount++;
      // First query chain (same admin check) - returns empty
      if (callCount <= 3) {
        return {
          where: mockWhere,
          limit: jest.fn(() => ({
            get: mockGetSameAdmin,
          })),
        };
      }
      // Second query chain (any admin check) - returns existing request
      return {
        where: mockWhere,
        limit: jest.fn(() => ({
          get: mockGetAnyAdmin,
        })),
      };
    });

    const mockCollection = jest.fn(() => ({
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    writeAuditLog.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({});

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin2@example.com", // Different admin
        adminName: "Test Admin 2",
        adminLocation: "Test City 2, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    const response = res._getJSONData();
    expect(response.error).toBe(
      "You already have a pending account activation request. Please wait for a response before submitting another request."
    );
    expect(response.existingRequestId).toBe(existingRequestId);

    // Verify no new Firestore document was created
    expect(firestoreRetryUtils.firestoreSet).not.toHaveBeenCalled();

    // Verify audit log was called for blocked submission
    expect(writeAuditLog).toHaveBeenCalledWith(
      req,
      "admin_approval_request",
      "requester@example.com",
      expect.objectContaining({
        outcome: "blocked_duplicate_submission",
        attemptedAdminEmail: "admin2@example.com",
        existingAdminEmail: "admin1@example.com",
        existingRequestId: existingRequestId,
      })
    );
  });

  it("should allow new request when no pending requests exist", async () => {
    const mockGet = jest.fn().mockResolvedValue({
      empty: true,
      docs: [],
    });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
    writeAuditLog.mockResolvedValue(undefined);

    // Mock the db collection
    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("Approval request submitted successfully");
    expect(response.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);

    // Verify new Firestore document was created
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalled();

    // Verify audit log was called for new request
    expect(writeAuditLog).toHaveBeenCalledWith(
      req,
      "admin_approval_request",
      "requester@example.com",
      expect.objectContaining({
        outcome: "request_created",
        adminEmail: "admin@example.com",
      })
    );
  });

  it("should check same admin first, then check any admin", async () => {
    const existingRequestId = "req_123456789_existing";
    const mockSend = jest.requireMock("@aws-sdk/client-ses").mockSend;

    // Track query order
    const queryOrder: string[] = [];

    const mockGetSameAdmin = jest.fn().mockResolvedValue({
      empty: true,
      docs: [],
    });
    const mockGetAnyAdmin = jest.fn().mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            requestId: existingRequestId,
            requesterEmail: "requester@example.com",
            adminEmail: "admin1@example.com",
            status: "pending",
          }),
        },
      ],
    });

    let callCount = 0;
    const mockWhere: any = jest.fn((field: string, op: string, value: string) => {
      callCount++;
      queryOrder.push(`${field} ${op} ${value}`);

      // First query: same admin (3 where calls)
      if (callCount <= 3) {
        return {
          where: mockWhere,
          limit: jest.fn(() => ({
            get: mockGetSameAdmin,
          })),
        };
      }
      // Second query: any admin (2 where calls)
      return {
        where: mockWhere,
        limit: jest.fn(() => ({
          get: mockGetAnyAdmin,
        })),
      };
    });

    const mockCollection = jest.fn(() => ({
      where: mockWhere,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    writeAuditLog.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({});

    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin2@example.com",
        adminName: "Test Admin 2",
        adminLocation: "Test City 2, CA",
      },
    });

    await handler(req, res);

    // Verify same admin query was checked first
    expect(queryOrder).toContain("requesterEmail == requester@example.com");
    expect(queryOrder).toContain("adminEmail == admin2@example.com");
    expect(queryOrder).toContain("status == pending");

    // Should block because any admin query found existing request
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toContain("already have a pending account activation request");
  });

  describe("Whitelisted email domain flow", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.SITE_ID = "ananda";
    });

    it("should skip admin approval and send activation email for whitelisted domain", async () => {
      const { db } = jest.requireMock("@/services/firebase");
      const { getUsersCollectionName } = jest.requireMock("@/utils/server/firestoreUtils");

      isEmailDomainWhitelisted.mockResolvedValue(true);
      genericRateLimiter.mockResolvedValue(true);
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      // Mock the document reference that firestoreGet receives
      const mockDocRef = {};
      firestoreRetryUtils.firestoreGet.mockResolvedValue({
        exists: false,
      });
      firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
      sendActivationEmail.mockResolvedValue(undefined);
      writeAuditLog.mockResolvedValue(undefined);
      getUsersCollectionName.mockReturnValue("users");

      const mockDoc = jest.fn(() => mockDocRef);
      const mockCollection = jest.fn((collectionName) => {
        if (collectionName === "users") {
          return {
            doc: mockDoc,
          };
        }
        return {
          doc: jest.fn(() => ({})),
        };
      });
      db.collection = mockCollection;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requesterEmail: "user@whitelisted.com",
          requesterName: "Test User",
          adminEmail: "admin@example.com",
          adminName: "Test Admin",
          adminLocation: "Test City, CA",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("activation-sent");
      expect(response.isWhitelisted).toBe(true);

      // Verify activation email was sent
      expect(sendActivationEmail).toHaveBeenCalledWith("user@whitelisted.com", "test-token-123", req);

      // Verify user was created
      expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
        mockDocRef,
        expect.objectContaining({
          email: "user@whitelisted.com",
          role: "user",
          inviteStatus: "pending",
        }),
        undefined,
        "create user via whitelisted domain"
      );

      // Verify no approval request was created
      expect(mockCollection).not.toHaveBeenCalledWith(expect.stringContaining("admin_approval_requests"));
    });

    it("should return success for whitelisted user who is already accepted", async () => {
      const { db } = jest.requireMock("@/services/firebase");
      const { getUsersCollectionName } = jest.requireMock("@/utils/server/firestoreUtils");

      isEmailDomainWhitelisted.mockResolvedValue(true);
      genericRateLimiter.mockResolvedValue(true);
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockDocRef = {};
      firestoreRetryUtils.firestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({
          inviteStatus: "accepted",
        }),
      });
      writeAuditLog.mockResolvedValue(undefined);
      getUsersCollectionName.mockReturnValue("users");

      const mockDoc = jest.fn(() => mockDocRef);
      const mockCollection = jest.fn(() => ({
        doc: mockDoc,
      }));
      db.collection = mockCollection;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requesterEmail: "user@whitelisted.com",
          requesterName: "Test User",
          adminEmail: "admin@example.com",
          adminName: "Test Admin",
          adminLocation: "Test City, CA",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("User already active");
      expect(response.isWhitelisted).toBe(true);

      // Verify no activation email was sent
      expect(sendActivationEmail).not.toHaveBeenCalled();
    });

    it("should resend activation email for whitelisted user with pending status", async () => {
      const { db } = jest.requireMock("@/services/firebase");
      const { getUsersCollectionName } = jest.requireMock("@/utils/server/firestoreUtils");

      isEmailDomainWhitelisted.mockResolvedValue(true);
      genericRateLimiter.mockResolvedValue(true);
      loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });

      const mockDocRef = {};
      firestoreRetryUtils.firestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({
          inviteStatus: "pending",
        }),
      });
      firestoreRetryUtils.firestoreSet.mockResolvedValue(undefined);
      sendActivationEmail.mockResolvedValue(undefined);
      writeAuditLog.mockResolvedValue(undefined);
      getUsersCollectionName.mockReturnValue("users");

      const mockDoc = jest.fn(() => mockDocRef);
      const mockCollection = jest.fn(() => ({
        doc: mockDoc,
      }));
      db.collection = mockCollection;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          requesterEmail: "user@whitelisted.com",
          requesterName: "Test User",
          adminEmail: "admin@example.com",
          adminName: "Test Admin",
          adminLocation: "Test City, CA",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const response = res._getJSONData();
      expect(response.message).toBe("activation-sent");
      expect(response.isWhitelisted).toBe(true);

      // Verify activation email was resent
      expect(sendActivationEmail).toHaveBeenCalledWith("user@whitelisted.com", "test-token-123", req);

      // Verify user was updated
      expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalledWith(
        mockDocRef,
        expect.objectContaining({
          inviteTokenHash: "hashed-token",
        }),
        { merge: true },
        "update pending user for whitelist resend"
      );
    });
  });

  it("should handle reminder email sending failure gracefully", async () => {
    const existingRequestId = "req_123456789_abc123";
    const sesModule = jest.requireMock("@aws-sdk/client-ses");
    const mockSend = sesModule.mockSend;

    const mockGet = jest.fn().mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            requestId: existingRequestId,
            requesterEmail: "requester@example.com",
            requesterName: "Test Requester",
            adminEmail: "admin@example.com",
            adminName: "Test Admin",
            adminLocation: "Test City, CA",
            status: "pending",
          }),
        },
      ],
    });
    const mockWhere: any = jest.fn(() => ({
      where: mockWhere,
      limit: jest.fn(() => ({
        get: mockGet,
      })),
    }));
    const mockDoc = jest.fn(() => ({}));
    const mockCollection = jest.fn(() => ({
      where: mockWhere,
      doc: mockDoc,
    }));

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    writeAuditLog.mockResolvedValue(undefined);

    // Mock SES send to fail - set up before handler is called
    // Use mockRejectedValueOnce to ensure it fails on the next call
    mockSend.mockReset();
    mockSend.mockRejectedValue(new Error("Email service unavailable"));

    const { db } = jest.requireMock("@/services/firebase");

    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        requesterEmail: "requester@example.com",
        requesterName: "Test Requester",
        adminEmail: "admin@example.com",
        adminName: "Test Admin",
        adminLocation: "Test City, CA",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    const response = res._getJSONData();
    expect(response.error).toBe("Failed to send reminder email. Please try again or contact support.");

    // Verify the send was called
    expect(mockSend).toHaveBeenCalled();
  });
});
