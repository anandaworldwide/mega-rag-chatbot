import { createMocks } from "node-mocks-http";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { requireAdminRole } from "@/utils/server/authz";
import { firestoreQueryGet, firestoreGet } from "@/utils/server/firestoreRetryUtils";
import * as firebaseService from "@/services/firebase";

// Mock dependencies
jest.mock("@/utils/server/jwtUtils");
jest.mock("@/utils/server/uuidUtils");
jest.mock("@/utils/server/authz");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils");

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockGetSecureUUID = getSecureUUID as jest.MockedFunction<typeof getSecureUUID>;
const mockRequireAdminRole = requireAdminRole as jest.MockedFunction<typeof requireAdminRole>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockDb = firebaseService.db as any;

// Mock getAnswersCollectionName
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
    batch: jest.fn(),
  }));
  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: {
      cert: jest.fn(),
    },
    initializeApp: jest.fn(),
  };
});

describe("/api/deleteFollowUpMessages", () => {
  let handler: typeof import("@/pages/api/deleteFollowUpMessages").default;

  beforeAll(async () => {
    handler = (await import("@/pages/api/deleteFollowUpMessages")).default;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    mockRequireAdminRole.mockReturnValue(false);

    // Mock successful UUID retrieval
    mockGetSecureUUID.mockReturnValue({
      success: true,
      uuid: "test-uuid",
    });

    // Mock user payload
    mockVerifyToken.mockReturnValue({
      email: "test@example.com",
      role: "user",
      uuid: "test-uuid",
    } as any);

    // Mock database operations
    const mockCollection = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        get: jest.fn(),
      }),
    };
    mockDb.collection = jest.fn().mockReturnValue(mockCollection);

    const mockBatch = {
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue({}),
    };
    mockDb.batch = jest.fn().mockReturnValue(mockBatch);
  });

  describe("Successful deletion", () => {
    it("should delete follow-up messages successfully", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check (for non-admin)
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "owner-doc" }],
      } as any);

      // Mock follow-up messages query
      const mockFollowUpDocs = [
        { ref: { id: "doc-123" }, id: "doc-123" },
        { ref: { id: "doc-124" }, id: "doc-124" },
        { ref: { id: "doc-125" }, id: "doc-125" },
      ];
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: mockFollowUpDocs,
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        message: "Follow-up messages deleted successfully",
        deletedCount: 3,
      });

      // Verify batch was created and committed
      expect(mockDb.batch).toHaveBeenCalled();
      expect(mockDb.batch().commit).toHaveBeenCalled();
    });

    it("should handle no follow-up messages to delete", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "owner-doc" }],
      } as any);

      // Mock empty follow-up messages query
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: true,
        docs: [],
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        message: "No follow-up messages to delete",
        deletedCount: 0,
      });
    });
  });

  describe("Authorization", () => {
    it("should allow admin to delete any conversation's follow-ups", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      mockRequireAdminRole.mockReturnValue(true);

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock follow-up messages query (should skip ownership check for admin)
      const mockFollowUpDocs = [{ ref: { id: "doc-123" }, id: "doc-123" }];
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: mockFollowUpDocs,
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      // Verify ownership check was NOT called for admin
      expect(mockFirestoreQueryGet).toHaveBeenCalledTimes(1);
    });

    it("should allow superuser to delete any conversation's follow-ups", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer superuser-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      mockRequireAdminRole.mockReturnValue(true);

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock follow-up messages query
      const mockFollowUpDocs = [{ ref: { id: "doc-123" }, id: "doc-123" }];
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: mockFollowUpDocs,
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
    });

    it("should deny non-owner from deleting conversation follow-ups", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer unauthorized-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      mockRequireAdminRole.mockReturnValue(false);

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check returning empty (user doesn't own conversation)
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: true,
        docs: [],
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(403);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Conversation not found or access denied",
      });
    });

    it("should allow owner to delete their own conversation follow-ups", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer owner-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      mockRequireAdminRole.mockReturnValue(false);

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check (user owns conversation)
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "owner-doc" }],
      } as any);

      // Mock follow-up messages query
      const mockFollowUpDocs = [{ ref: { id: "doc-123" }, id: "doc-123" }];
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: mockFollowUpDocs,
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe("Input validation", () => {
    it("should return 400 for missing convId", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          startAfterDocId: "doc-123",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "convId and startAfterDocId are required",
      });
    });

    it("should return 400 for missing startAfterDocId", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "convId and startAfterDocId are required",
      });
    });

    it("should return 404 when start document not found", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "non-existent-doc",
        },
      });

      // Mock the start document lookup returning non-existent
      const mockStartDoc = {
        exists: false,
        data: () => null,
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(404);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Start document not found",
      });
    });

    it("should return 400 when start document has no timestamp", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      // Mock the start document lookup with no timestamp
      const mockStartDoc = {
        exists: true,
        data: () => ({
          // No timestamp field
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Start document has no timestamp",
      });
    });
  });

  describe("Authentication", () => {
    it("should return 401 for missing authorization header", async () => {
      const { req, res } = createMocks({
        method: "POST",
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(401);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Authorization header required",
      });
    });

    it("should return 401 for invalid token", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer invalid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      mockVerifyToken.mockImplementation(() => {
        throw new Error("Invalid token");
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(401);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Invalid or expired token",
      });
    });

    it("should return 400 when UUID retrieval fails", async () => {
      mockGetSecureUUID.mockReturnValue({
        success: false,
        error: "UUID not found in authentication token",
        statusCode: 400,
      });

      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "UUID not found in authentication token",
      });
    });
  });

  describe("Method validation", () => {
    it("should return 405 for unsupported methods", async () => {
      const { req, res } = createMocks({
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(405);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Method not allowed",
      });
    });
  });

  describe("Database error handling", () => {
    it("should return 503 when database is not available", async () => {
      // Temporarily replace db with null for this test
      const originalDb = firebaseService.db;
      (firebaseService as any).db = null;

      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(503);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Database not available",
      });

      // Restore db
      (firebaseService as any).db = originalDb;
    });

    it("should handle Firestore errors gracefully", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "owner-doc" }],
      } as any);

      // Mock Firestore error during follow-up query
      mockFirestoreQueryGet.mockRejectedValueOnce(new Error("Firestore error"));

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        error: "Internal server error",
      });
    });
  });

  describe("Batch deletion", () => {
    it("should handle large batches by splitting into multiple commits", async () => {
      const { req, res } = createMocks({
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: {
          convId: "test-conv-id",
          startAfterDocId: "doc-123",
        },
      });

      // Mock the start document lookup
      const mockStartDoc = {
        exists: true,
        data: () => ({
          timestamp: { seconds: 1000, nanoseconds: 0 },
        }),
      };
      mockFirestoreGet.mockResolvedValue(mockStartDoc as any);

      // Mock ownership check
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "owner-doc" }],
      } as any);

      // Mock 600 follow-up messages (more than batch limit of 500)
      const mockFollowUpDocs = Array.from({ length: 600 }, (_, i) => ({
        ref: { id: `doc-${i}` },
        id: `doc-${i}`,
      }));
      mockFirestoreQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: mockFollowUpDocs,
      } as any);

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData).toEqual({
        message: "Follow-up messages deleted successfully",
        deletedCount: 600,
      });

      // Verify multiple batches were created (600 / 500 = 2 batches)
      expect(mockDb.batch).toHaveBeenCalledTimes(2);
    });
  });
});
