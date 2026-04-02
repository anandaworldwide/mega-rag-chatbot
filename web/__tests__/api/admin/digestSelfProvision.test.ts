import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/digestSelfProvision";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sendOpsAlert } from "@/utils/server/emailOps";

type MockDigestDoc = {
  action?: string;
  target?: string;
  details?: Record<string, unknown>;
};

type MockUserRecord = {
  firstName?: string;
  lastName?: string;
  invitedByEmail?: string;
  invitedByName?: string;
};

let mockSelfProvisionDocs: MockDigestDoc[] = [];
let mockActivationDocs: MockDigestDoc[] = [];
let mockUserDocs: Record<string, MockUserRecord> = {};
let mockAdminAccessByEmail: Record<string, { action: string } | undefined> = {};

function createQuerySnapshot(docs: MockDigestDoc[]) {
  return {
    empty: docs.length === 0,
    docs: docs.map((doc) => ({
      data: () => doc,
    })),
    forEach: jest.fn((callback) => {
      docs.forEach((doc) =>
        callback({
          data: () => doc,
        })
      );
    }),
  };
}

function buildDefaultCollectionMock(collectionName: string) {
  const userCollection = process.env.NODE_ENV === "production" ? "prod_users" : "dev_users";
  const auditCollection = process.env.NODE_ENV === "production" ? "prod_admin_audit" : "dev_admin_audit";

  if (collectionName === userCollection) {
    return {
      doc: jest.fn((email: string) => ({
        get: jest.fn(() => {
          const userData = mockUserDocs[email];
          return Promise.resolve({
            exists: !!userData,
            data: () => userData,
          });
        }),
      })),
    };
  }

  if (collectionName === auditCollection) {
    return {
      where: jest.fn((field: string, _op: string, value: string) => {
        if (field === "action") {
          return {
            where: jest.fn(() => ({
              get: jest.fn(() => {
                if (value === "self_provision_attempt") {
                  return Promise.resolve(createQuerySnapshot(mockSelfProvisionDocs));
                }
                if (value === "user_activation_completed") {
                  return Promise.resolve(createQuerySnapshot(mockActivationDocs));
                }
                return Promise.resolve(createQuerySnapshot([]));
              }),
            })),
          };
        }

        if (field === "target") {
          return {
            where: jest.fn((_actionField: string, _actionOp: string, _actionValues: string[]) => ({
              orderBy: jest.fn(() => ({
                limit: jest.fn(() => {
                  const adminAccess = mockAdminAccessByEmail[value];
                  return {
                    get: jest.fn(() =>
                      Promise.resolve(
                        createQuerySnapshot(adminAccess ? [{ action: adminAccess.action, target: value }] : [])
                      )
                    ),
                  };
                }),
              })),
            })),
          };
        }

        return {
          where: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve(createQuerySnapshot([]))),
          })),
        };
      }),
    };
  }

  return {
    where: jest.fn(() => ({
      where: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve(createQuerySnapshot([]))),
      })),
    })),
  };
}

// Mock Firebase
let mockDbValue: any = {
  collection: jest.fn((collectionName: string) => buildDefaultCollectionMock(collectionName)),
};

jest.mock("@/services/firebase", () => ({
  get db() {
    return mockDbValue;
  },
}));

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: (handler: any) => handler,
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter");

// Mock email operations
jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn(),
}));

describe("/api/admin/digestSelfProvision", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "test-cron-secret",
      SITE_ID: "test-site",
      NODE_ENV: "test",
    };
    (genericRateLimiter as jest.Mock).mockResolvedValue(true);
    (sendOpsAlert as jest.Mock).mockResolvedValue(true);
    mockSelfProvisionDocs = [];
    mockActivationDocs = [];
    mockUserDocs = {};
    mockAdminAccessByEmail = {};

    // Reset the database mock to return empty results by default
    mockDbValue.collection = jest.fn((collectionName: string) => buildDefaultCollectionMock(collectionName));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Authentication", () => {
    it("returns 500 when CRON_SECRET is not set", async () => {
      delete process.env.CRON_SECRET;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer some-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({ error: "Cron authentication not configured" });
    });

    it("returns 401 when Authorization header is missing", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 when Authorization header has wrong secret", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer wrong-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({ error: "Unauthorized" });
    });

    it("accepts valid CRON_SECRET", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toHaveProperty("ok", true);
    });
  });

  describe("HTTP Methods", () => {
    it("accepts POST method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("accepts GET method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("rejects unsupported methods", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({ error: "Method not allowed" });
    });
  });

  describe("Rate Limiting", () => {
    it("returns early when rate limited", async () => {
      (genericRateLimiter as jest.Mock).mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(genericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000,
        max: 3,
        name: "digest-self-provision",
      });
      // Rate limiting should prevent database calls
    });
  });

  describe("Database Operations", () => {
    it("returns 503 when database is unavailable", async () => {
      // Temporarily set mockDbValue to null
      const originalMockDb = mockDbValue;
      mockDbValue = null;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({ error: "Database not available" });

      // Restore original mockDb
      mockDbValue = originalMockDb;
    });

    it("queries correct Firestore collection and filters", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      // Database queries should have been made
    });

    it("uses prod collection in production environment", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        writable: true,
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      // Should use prod collection in production

      // Restore original NODE_ENV
      Object.defineProperty(process.env, "NODE_ENV", {
        value: originalNodeEnv,
        writable: true,
      });
    });
  });

  describe("Data Aggregation", () => {
    it("correctly aggregates activation outcomes", async () => {
      mockSelfProvisionDocs = [
        { details: { outcome: "created_pending_user" }, target: "user1@example.com" },
        { details: { outcome: "created_pending_user" }, target: "user2@example.com" },
        { details: { outcome: "server_error" }, target: "user5@example.com" },
      ];
      mockActivationDocs = [{ details: { outcome: "activation_completed" }, target: "user1@example.com" }];

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();

      expect(responseData.counts).toEqual({
        activationsCompleted: 1,
        activationEmailsSent: 2,
        errors: 1,
      });

      expect(responseData.samples).toHaveLength(1); // Only activation completions are shown
      expect(responseData.samples[0]).toEqual({
        target: "user1@example.com",
        outcome: "activation_completed",
      });
    });

    it("limits samples to 100 entries", async () => {
      mockActivationDocs = Array.from({ length: 150 }, (_, i) => ({
        details: { outcome: "activation_completed" },
        target: `user${i}@example.com`,
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();

      expect(responseData.samples).toHaveLength(100);
      expect(responseData.counts.activationsCompleted).toBe(150);
    });

    it("shows 'plus X more' message when there are more activations than the limit", async () => {
      mockActivationDocs = Array.from({ length: 150 }, (_, i) => ({
        details: { outcome: "activation_completed" },
        target: `user${i}@example.com`,
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();

      // Verify the email body contains the "plus X more" message
      const emailBody = (sendOpsAlert as jest.Mock).mock.calls[0][1];
      expect(emailBody).toContain("plus 50 more not shown here");
      expect(responseData.samples).toHaveLength(100);
      expect(responseData.counts.activationsCompleted).toBe(150);
    });
  });

  describe("Email Operations", () => {
    it("sends ops alert with correct digest format", async () => {
      mockSelfProvisionDocs = [{ details: { outcome: "created_pending_user" }, target: "user1@example.com" }];
      mockActivationDocs = [{ details: { outcome: "activation_completed" }, target: "user1@example.com" }];

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      const [subject, body] = (sendOpsAlert as jest.Mock).mock.calls[0];
      expect(subject).toMatch(/^User activation digest:/);
      expect(body).toContain("Self-provision digest for site test-site (last 24h)");

      const emailBody = (sendOpsAlert as jest.Mock).mock.calls[0][1];
      expect(emailBody).toContain("Activations completed: 1");
      expect(emailBody).toContain("Activation emails sent: 1");
      expect(emailBody).toContain("Server errors: 0");
      expect(emailBody).toContain("ACTIVITY DETAILS:");
    });

    it("includes how each activated user got access", async () => {
      mockActivationDocs = [
        { details: { outcome: "activation_completed" }, target: "user1@example.com" },
        { details: { outcome: "activation_completed" }, target: "user2@example.com" },
        { details: { outcome: "activation_completed" }, target: "user3@anandaindia.org" },
      ];
      mockUserDocs = {
        "user1@example.com": {
          invitedByEmail: "admin1@example.com",
          invitedByName: "Admin One",
        },
        "user2@example.com": {
          invitedByEmail: "admin2@example.com",
          invitedByName: "Admin Two",
        },
      };
      mockAdminAccessByEmail = {
        "user1@example.com": { action: "admin_add_user" },
        "user2@example.com": { action: "admin_approval_approve" },
      };

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      const emailBody = (sendOpsAlert as jest.Mock).mock.calls[0][1];

      expect(emailBody).toContain("Account activated");
      expect(emailBody).toContain(
        "1. user1 (user1@example.com) - Account activated - invited by admin Admin One (admin1@example.com)"
      );
      expect(emailBody).toContain(
        "2. user2 (user2@example.com) - Account activated - approved by admin Admin Two (admin2@example.com)"
      );
      expect(emailBody).toContain(
        "3. user3 (user3@anandaindia.org) - Account activated - matched pre-approved domain"
      );
    });

    it("does not send email when there is no activity", async () => {
      // Mock empty data for both self-provision and activation attempts
      mockDbValue.collection = jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn(() => Promise.resolve({ forEach: jest.fn() })), // Empty results
          })),
        })),
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      // Verify response is successful
      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();
      expect(responseData.counts).toEqual({
        activationsCompleted: 0,
        activationEmailsSent: 0,
        errors: 0,
      });

      // Verify no email was sent
      expect(sendOpsAlert).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("returns 500 when Firestore query fails", async () => {
      // Set up the mock to throw an error
      mockDbValue.collection = jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn().mockRejectedValue(new Error("Firestore error")),
          })),
        })),
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Firestore error",
      });
    });

    it("returns 500 when email sending fails", async () => {
      mockActivationDocs = [{ details: { outcome: "activation_completed" }, target: "user1@example.com" }];

      (sendOpsAlert as jest.Mock).mockRejectedValue(new Error("Email error"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Email error",
      });
    });

    it("handles generic errors gracefully", async () => {
      // Set up the mock to throw a string error (not Error object)
      mockDbValue.collection = jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn().mockRejectedValue("String error"),
          })),
        })),
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Failed to build digest",
      });
    });

    it("handles missing Firestore index with Firebase Console URL", async () => {
      const indexError = new Error(
        "The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/test-project/firestore/indexes?create_composite=ABC123"
      );

      // Set up the mock to throw an index error
      mockDbValue.collection = jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(() => ({
            get: jest.fn().mockRejectedValue(indexError),
          })),
        })),
      }));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      const responseData = res._getJSONData();
      expect(responseData.error).toBe(
        "This feature requires database configuration. Please contact the site administrator to enable this functionality."
      );
      expect(responseData.type).toBe("firestore_index_error");
      expect(responseData.isBuilding).toBe(false);
      expect(responseData.adminMessage).toBe(
        "Firestore index is missing and needs to be created. Check the Firebase Console to create the required index."
      );
      expect(responseData.indexUrl).toBe(
        "https://console.firebase.google.com/v1/r/project/test-project/firestore/indexes?create_composite=ABC123"
      );
    });
  });
});
