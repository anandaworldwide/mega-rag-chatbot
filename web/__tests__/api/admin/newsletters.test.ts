import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/newsletters";
import * as firestoreRetryUtils from "@/utils/server/firestoreRetryUtils";
import * as firestoreUtils from "@/utils/server/firestoreUtils";
import * as authz from "@/utils/server/authz";
import * as genericRateLimiter from "@/utils/server/genericRateLimiter";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      orderBy: jest.fn(() => ({
        limit: jest.fn(() => ({
          where: jest.fn(() => ({
            // Mock query with status filter
          })),
        })),
      })),
    })),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils");
jest.mock("@/utils/server/authz");
jest.mock("@/utils/server/genericRateLimiter");

// Mock JWT wrapper to no-op
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (handler: any) => handler,
  verifyToken: jest.fn(),
  getTokenFromRequest: jest.fn(() => ({ email: "admin@example.com", role: "admin" })),
}));

const mockFirestoreQueryGet = firestoreRetryUtils.firestoreQueryGet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreQueryGet
>;
const mockGetNewslettersCollectionName = firestoreUtils.getNewslettersCollectionName as jest.MockedFunction<
  typeof firestoreUtils.getNewslettersCollectionName
>;
const mockRequireSuperuserRoleFromFirestore = authz.requireSuperuserRoleFromFirestore as jest.MockedFunction<
  typeof authz.requireSuperuserRoleFromFirestore
>;
const mockGenericRateLimiter = genericRateLimiter.genericRateLimiter as jest.MockedFunction<
  typeof genericRateLimiter.genericRateLimiter
>;

describe("/api/admin/newsletters", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    (mockGenericRateLimiter as jest.Mock).mockResolvedValue(true);
    mockRequireSuperuserRoleFromFirestore.mockResolvedValue(undefined);
    mockGetNewslettersCollectionName.mockReturnValue("test_newsletters");
  });

  it("should return 405 for non-GET requests", async () => {
    const { req, res } = createMocks({
      method: "POST",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it("should return early if rate limit is exceeded", async () => {
    mockGenericRateLimiter.mockResolvedValue(false as any);

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    // Rate limiter should handle the response
    expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
      name: "newslettersList",
      max: 20,
      windowMs: 60 * 1000,
    });
  });

  it("should validate superuser role", async () => {
    mockRequireSuperuserRoleFromFirestore.mockRejectedValue(new Error("Unauthorized: Superuser privileges required"));

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(JSON.parse(res._getData())).toEqual({
      error: "Forbidden: Superuser privileges required",
    });
  });

  it("should return empty newsletters list when no newsletters exist", async () => {
    mockFirestoreQueryGet.mockResolvedValue({
      docs: [],
    } as any);

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());
    expect(responseData).toEqual({
      newsletters: [],
      total: 0,
    });
  });

  it("should return newsletters list successfully without status filter", async () => {
    const mockNewsletters = [
      {
        id: "newsletter1",
        data: () => ({
          subject: "Test Newsletter 1",
          content: "This is test content 1",
          status: "completed",
          totalQueued: 100,
          sentCount: 98,
          failedCount: 2,
          createdAt: { toDate: () => new Date("2024-01-15T10:00:00Z") },
          sentBy: "admin@example.com",
        }),
      },
      {
        id: "newsletter2",
        data: () => ({
          subject: "Test Newsletter 2",
          content: "This is test content 2",
          status: "in_progress",
          totalQueued: 50,
          sentCount: 25,
          failedCount: 0,
          createdAt: { toDate: () => new Date("2024-01-10T15:30:00Z") },
          sentBy: "admin2@example.com",
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      docs: mockNewsletters,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.newsletters).toHaveLength(2);
    expect(responseData.total).toBe(2);

    // Check first newsletter
    expect(responseData.newsletters[0]).toEqual({
      id: "newsletter1",
      subject: "Test Newsletter 1",
      content: "This is test content 1",
      status: "completed",
      totalQueued: 100,
      sentCount: 98,
      failedCount: 2,
      createdAt: "2024-01-15T10:00:00.000Z",
      sentBy: "admin@example.com",
    });

    // Check second newsletter
    expect(responseData.newsletters[1]).toEqual({
      id: "newsletter2",
      subject: "Test Newsletter 2",
      content: "This is test content 2",
      status: "in_progress",
      totalQueued: 50,
      sentCount: 25,
      failedCount: 0,
      createdAt: "2024-01-10T15:30:00.000Z",
      sentBy: "admin2@example.com",
    });
  });

  it("should filter newsletters by status when status parameter is provided", async () => {
    const mockNewsletters = [
      {
        id: "newsletter1",
        data: () => ({
          subject: "Completed Newsletter",
          content: "Content",
          status: "completed",
          totalQueued: 100,
          sentCount: 100,
          failedCount: 0,
          createdAt: { toDate: () => new Date("2024-01-15T10:00:00Z") },
          sentBy: "admin@example.com",
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      docs: mockNewsletters,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
      query: { status: "completed" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.newsletters).toHaveLength(1);
    expect(responseData.newsletters[0].status).toBe("completed");
  });

  // REGRESSION TEST: Fix for newsletter disappearing from dropdown after first batch
  it("should include 'in_progress' newsletters when filtering by 'queued' status", async () => {
    const mockNewsletters = [
      {
        id: "newsletter1",
        data: () => ({
          subject: "Queued Newsletter",
          content: "Content",
          status: "queued",
          totalQueued: 100,
          sentCount: 0,
          failedCount: 0,
          createdAt: { toDate: () => new Date("2024-01-15T10:00:00Z") },
          sentBy: "admin@example.com",
        }),
      },
      {
        id: "newsletter2",
        data: () => ({
          subject: "In Progress Newsletter",
          content: "Content",
          status: "in_progress",
          totalQueued: 100,
          sentCount: 50,
          failedCount: 0,
          createdAt: { toDate: () => new Date("2024-01-15T10:00:00Z") },
          sentBy: "admin@example.com",
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      docs: mockNewsletters,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
      query: { status: "queued" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    // Should include both 'queued' and 'in_progress' newsletters
    expect(responseData.newsletters).toHaveLength(2);
    expect(responseData.newsletters[0].status).toBe("queued");
    expect(responseData.newsletters[1].status).toBe("in_progress");
  });

  // REGRESSION TEST: Ensure non-'queued' status filters still work correctly
  it("should filter by exact status for non-'queued' status values", async () => {
    const mockNewsletters = [
      {
        id: "newsletter1",
        data: () => ({
          subject: "In Progress Newsletter",
          content: "Content",
          status: "in_progress",
          totalQueued: 100,
          sentCount: 50,
          failedCount: 0,
          createdAt: { toDate: () => new Date("2024-01-15T10:00:00Z") },
          sentBy: "admin@example.com",
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      docs: mockNewsletters,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
      query: { status: "in_progress" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    // Should only include 'in_progress' newsletters
    expect(responseData.newsletters).toHaveLength(1);
    expect(responseData.newsletters[0].status).toBe("in_progress");
  });

  it("should handle newsletters with missing optional fields", async () => {
    const mockNewsletters = [
      {
        id: "newsletter1",
        data: () => ({
          subject: "Basic Newsletter",
          content: "Basic content",
          status: "queued",
          // Missing optional fields like sentCount, failedCount, etc.
          createdAt: "2024-01-15T10:00:00Z", // String instead of Timestamp
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      docs: mockNewsletters,
    } as any);

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const responseData = JSON.parse(res._getData());

    expect(responseData.newsletters[0]).toEqual({
      id: "newsletter1",
      subject: "Basic Newsletter",
      content: "Basic content",
      status: "queued",
      totalQueued: 0,
      sentCount: 0,
      failedCount: 0,
      createdAt: "2024-01-15T10:00:00Z",
      sentBy: "unknown",
    });
  });

  it("should handle Firestore query errors", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("Database connection failed"));

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(500);
    // Error response no longer includes details field - only sanitized error message
    const response = JSON.parse(res._getData());
    expect(response).toHaveProperty("error");
    expect(typeof response.error).toBe("string");
    // Error message may be sanitized, so we just check it exists
  });

  it("should handle database not available", async () => {
    // Mock db as undefined
    const firebase = jest.requireMock("@/services/firebase");
    const originalDb = firebase.db;
    firebase.db = undefined;

    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getData())).toEqual({ error: "Database not available" });

    // Restore db
    firebase.db = originalDb;
  });
});
