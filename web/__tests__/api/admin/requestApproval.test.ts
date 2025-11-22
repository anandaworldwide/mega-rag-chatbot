import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/requestApproval";

// Mock firebase-admin
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({
        seconds: Math.floor(Date.now() / 1000),
        nanoseconds: 0,
      })),
    },
  },
}));

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
  /* eslint-disable @typescript-eslint/no-var-requires */
  const firestoreRetryUtils = require("@/utils/server/firestoreRetryUtils");
  const { genericRateLimiter } = require("@/utils/server/genericRateLimiter");
  const { writeAuditLog } = require("@/utils/server/auditLog");
  const loadSiteConfig = require("@/utils/server/loadSiteConfig");
  /* eslint-enable @typescript-eslint/no-var-requires */

  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

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
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
    const mockSend = require("@aws-sdk/client-ses").mockSend;
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
    const mockSend = require("@aws-sdk/client-ses").mockSend;
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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

  it("should allow new request to different admin even if pending request exists with another admin", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
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
    const { db } = require("@/services/firebase");
    /* eslint-enable @typescript-eslint/no-var-requires */
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

    expect(res.statusCode).toBe(200);
    const response = res._getJSONData();
    expect(response.message).toBe("Approval request submitted successfully");
    expect(response.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);

    // Verify query checked for this specific admin
    expect(mockWhere).toHaveBeenCalledWith("requesterEmail", "==", "requester@example.com");
    expect(mockWhere).toHaveBeenCalledWith("adminEmail", "==", "admin2@example.com");

    // Verify new Firestore document was created
    expect(firestoreRetryUtils.firestoreSet).toHaveBeenCalled();
  });
});
