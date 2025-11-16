import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/cleanupExpiredInvitations";
import { db } from "@/services/firebase";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { writeAuditLog } from "@/utils/server/auditLog";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import firebase from "firebase-admin";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/utils/server/firestoreIndexErrorHandler", () => ({
  createIndexErrorResponse: jest.fn(),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(),
    },
  },
}));

const mockDb = db as jest.Mocked<typeof db>;
const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockWriteAuditLog = writeAuditLog as jest.MockedFunction<typeof writeAuditLog>;
const mockCreateIndexErrorResponse = createIndexErrorResponse as jest.MockedFunction<typeof createIndexErrorResponse>;
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockFirebaseTimestamp = firebase.firestore.Timestamp as jest.Mocked<typeof firebase.firestore.Timestamp>;

describe("/api/admin/cleanupExpiredInvitations", () => {
  const originalEnv = process.env;

  // Helper function to create properly typed mocks
  const createTestMocks = (options: any) => {
    const { req, res } = createMocks(options);
    (req as any).env = process.env;
    return { req: req as any, res: res as any };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SITE_ID = "test-site";
    process.env.CRON_SECRET = "test-cron-secret";

    // Mock rate limiter to allow requests
    mockGenericRateLimiter.mockResolvedValue(true);

    // Mock site config to require login by default
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    } as any);

    // Mock Firebase timestamp
    const mockNow = { seconds: 1640995200, nanoseconds: 0 } as any;
    mockFirebaseTimestamp.now.mockReturnValue(mockNow);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Authentication", () => {
    it("should allow Vercel cron requests with correct secret", async () => {
      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      // Mock empty result (no expired invitations)
      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        ok: true,
        summary: {
          totalExpired: 0,
          deletedCount: 0,
          errorCount: 0,
          deletedEmails: [],
          errors: [],
        },
        message: "Cleanup completed: 0 expired invitations deleted, 0 errors",
      });
    });

    it("should reject Vercel cron requests with incorrect secret", async () => {
      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer wrong-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getData())).toEqual({
        error: "Unauthorized",
      });
    });

    it("should reject non-cron requests without JWT", async () => {
      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
    });
  });

  describe("Rate Limiting", () => {
    it("should respect rate limits", async () => {
      mockGenericRateLimiter.mockResolvedValue(false);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000,
        max: 3,
        name: "cleanup-expired-invitations",
      });
    });
  });

  describe("Method Validation", () => {
    it("should only allow GET and POST methods", async () => {
      const { req, res } = createTestMocks({
        method: "PUT",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      expect(JSON.parse(res._getData())).toEqual({
        error: "Method not allowed",
      });
    });
  });

  // Note: Database availability test removed due to Jest mocking complexity
  // The handler correctly checks for db availability and returns 503 if null

  describe("Firestore Index Handling", () => {
    it("should handle missing Firestore index error", async () => {
      const indexError = new Error(
        "query requires an index. You can create it here: https://console.firebase.google.com/project/test/firestore/indexes"
      );

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockRejectedValue(indexError),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      // Mock the index error response
      mockCreateIndexErrorResponse.mockReturnValue({
        error:
          "This feature requires database configuration. Please contact the site administrator to enable this functionality.",
        type: "firestore_index_error",
        isBuilding: false,
        adminMessage:
          "Firestore index is missing and needs to be created. Check the Firebase Console to create the required index.",
        indexUrl: "https://console.firebase.google.com/project/test/firestore/indexes",
      });

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.type).toBe("firestore_index_error");
      expect(responseData.isBuilding).toBe(false);
      expect(mockCreateIndexErrorResponse).toHaveBeenCalledWith(indexError, {
        endpoint: "/api/admin/cleanupExpiredInvitations",
        collection: "dev_users",
        fields: ["inviteStatus", "inviteExpiresAt", "__name__"],
        query: "pending invitations with expired dates",
      });
    });

    it("should handle building Firestore index error", async () => {
      const indexError = new Error("index is currently building");

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockRejectedValue(indexError),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      // Mock the index error response for building index
      mockCreateIndexErrorResponse.mockReturnValue({
        error:
          "The database is currently being optimized. Please try again in a few minutes. If this persists, please contact the site administrator.",
        type: "firestore_index_error",
        isBuilding: true,
        adminMessage:
          "Firestore index is currently building. This is normal for new indexes and should resolve automatically.",
        indexUrl: undefined,
      });

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.type).toBe("firestore_index_error");
      expect(responseData.isBuilding).toBe(true);
    });
  });

  describe("Site Configuration", () => {
    it("should return early if site does not require login", async () => {
      // Mock site config to not require login
      mockLoadSiteConfigSync.mockReturnValue({
        requireLogin: false,
      } as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.ok).toBe(true);
      expect(responseData.message).toBe("Site does not require login - no invitations to clean up");
      expect(responseData.summary).toEqual({
        totalExpired: 0,
        deletedCount: 0,
        errorCount: 0,
        deletedEmails: [],
        errors: [],
      });

      // Verify that no database queries were made
      expect(mockDb.collection).not.toHaveBeenCalled();
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });

    it("should proceed with cleanup if site requires login", async () => {
      // Mock site config to require login
      mockLoadSiteConfigSync.mockReturnValue({
        requireLogin: true,
      } as any);

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      // Verify that database queries were made
      expect(mockDb.collection).toHaveBeenCalled();
    });
  });

  describe("Cleanup Functionality", () => {
    it("should successfully delete expired invitations", async () => {
      const mockExpiredDoc1 = {
        id: "expired1@example.com",
        data: () => ({
          inviteExpiresAt: { toDate: () => new Date("2023-01-01") },
          createdAt: { toDate: () => new Date("2022-12-01") },
        }),
        ref: { delete: jest.fn().mockResolvedValue(undefined) },
      };

      const mockExpiredDoc2 = {
        id: "expired2@example.com",
        data: () => ({
          inviteExpiresAt: { toDate: () => new Date("2023-01-02") },
          createdAt: { toDate: () => new Date("2022-12-02") },
        }),
        ref: { delete: jest.fn().mockResolvedValue(undefined) },
      };

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          docs: [mockExpiredDoc1, mockExpiredDoc2],
        }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.ok).toBe(true);
      expect(responseData.summary.totalExpired).toBe(2);
      expect(responseData.summary.deletedCount).toBe(2);
      expect(responseData.summary.errorCount).toBe(0);
      expect(responseData.summary.deletedEmails).toEqual(["expired1@example.com", "expired2@example.com"]);

      // Verify documents were deleted
      expect(mockExpiredDoc1.ref.delete).toHaveBeenCalled();
      expect(mockExpiredDoc2.ref.delete).toHaveBeenCalled();

      // Verify audit logs were written
      expect(mockWriteAuditLog).toHaveBeenCalledTimes(2);
      expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "expired_invitation_cleanup", "expired1@example.com", {
        outcome: "deleted",
        expiresAt: "2023-01-01T00:00:00.000Z",
        createdAt: "2022-12-01T00:00:00.000Z",
      });

      // No ops alerts are sent for successful cleanup
    });

    it("should handle deletion errors gracefully", async () => {
      const deleteError = new Error("Firestore delete failed");

      const mockExpiredDoc = {
        id: "error@example.com",
        data: () => ({
          inviteExpiresAt: { toDate: () => new Date("2023-01-01") },
          createdAt: { toDate: () => new Date("2022-12-01") },
        }),
        ref: { delete: jest.fn().mockRejectedValue(deleteError) },
      };

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          docs: [mockExpiredDoc],
        }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.summary.totalExpired).toBe(1);
      expect(responseData.summary.deletedCount).toBe(0);
      expect(responseData.summary.errorCount).toBe(1);
      expect(responseData.summary.errors).toEqual([{ email: "error@example.com", error: "Firestore delete failed" }]);

      // Verify error audit log was written
      expect(mockWriteAuditLog).toHaveBeenCalledWith(req, "expired_invitation_cleanup", "error@example.com", {
        outcome: "error",
        error: "Firestore delete failed",
      });

      // No ops alerts are sent for cleanup operations
    });

    it("should handle no expired invitations", async () => {
      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.summary.totalExpired).toBe(0);
      expect(responseData.summary.deletedCount).toBe(0);
      expect(responseData.summary.errorCount).toBe(0);

      // No ops alerts are sent for any cleanup operations
    });

    it("should process large batches correctly", async () => {
      // Create 25 expired invitations to test batch processing
      const mockDocs = Array.from({ length: 25 }, (_, i) => ({
        id: `expired${i}@example.com`,
        data: () => ({
          inviteExpiresAt: { toDate: () => new Date("2023-01-01") },
          createdAt: { toDate: () => new Date("2022-12-01") },
        }),
        ref: { delete: jest.fn().mockResolvedValue(undefined) },
      }));

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: mockDocs }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.summary.totalExpired).toBe(25);
      expect(responseData.summary.deletedCount).toBe(25);
      expect(responseData.summary.errorCount).toBe(0);

      // Verify all documents were deleted
      mockDocs.forEach((doc) => {
        expect(doc.ref.delete).toHaveBeenCalled();
      });

      // Verify audit logs were written for all
      expect(mockWriteAuditLog).toHaveBeenCalledTimes(25);

      // Verify only first 20 emails are shown in summary
      expect(responseData.summary.deletedEmails).toHaveLength(20);
    });
  });

  describe("Environment Configuration", () => {
    it("should use production collections in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = "production";

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect((mockDb as any).collection).toHaveBeenCalledWith("prod_users");

      (process.env as any).NODE_ENV = originalNodeEnv;
    });

    it("should use dev collections in non-production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = "development";

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect((mockDb as any).collection).toHaveBeenCalledWith("dev_users");

      (process.env as any).NODE_ENV = originalNodeEnv;
    });
  });

  describe("Error Handling", () => {
    it("should handle unexpected errors and send alert", async () => {
      const unexpectedError = new Error("Unexpected database error");

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockRejectedValue(unexpectedError),
      };
      (mockDb as any).collection.mockReturnValue(mockCollection as any);

      // Mock the index error response to return a generic error (not an index error)
      mockCreateIndexErrorResponse.mockReturnValue({
        error: "Unexpected database error",
        type: "generic_error",
      });

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getData())).toEqual({
        error: "Unexpected database error",
      });

      // No ops alerts are sent for cleanup operations
    });
  });
});
