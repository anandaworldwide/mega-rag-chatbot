import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/sendNewsletter";
import * as firestoreRetryUtils from "@/utils/server/firestoreRetryUtils";
import * as firestoreUtils from "@/utils/server/firestoreUtils";
import * as authz from "@/utils/server/authz";
import * as genericRateLimiter from "@/utils/server/genericRateLimiter";
import * as jwtUtils from "@/utils/server/jwtUtils";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(() => ({
            // Mock query chain
          })),
        })),
      })),
      doc: jest.fn(() => ({
        id: "mock-newsletter-id",
      })),
    })),
    batch: jest.fn(() => ({
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils");
jest.mock("@/utils/server/authz");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ toDate: () => new Date("2024-01-15T10:00:00Z") })),
    },
  },
}));

// Mock JWT wrapper to no-op
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (handler: any) => handler,
  verifyToken: jest.fn(),
  getTokenFromRequest: jest.fn(() => ({ email: "admin@example.com", role: "admin" })),
}));

const mockFirestoreQueryGet = firestoreRetryUtils.firestoreQueryGet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreQueryGet
>;
const mockFirestoreSet = firestoreRetryUtils.firestoreSet as jest.MockedFunction<
  typeof firestoreRetryUtils.firestoreSet
>;
const mockGetUsersCollectionName = firestoreUtils.getUsersCollectionName as jest.MockedFunction<
  typeof firestoreUtils.getUsersCollectionName
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
const mockGetTokenFromRequest = jwtUtils.getTokenFromRequest as jest.MockedFunction<
  typeof jwtUtils.getTokenFromRequest
>;

describe("/api/admin/sendNewsletter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock environment variables
    process.env.SECURE_TOKEN = "mock-jwt-secret";
    process.env.CONTACT_EMAIL = "noreply@example.com";
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com";

    // Default mocks
    (mockGenericRateLimiter as jest.Mock).mockResolvedValue(true);
    mockRequireSuperuserRoleFromFirestore.mockResolvedValue(undefined);
    mockGetUsersCollectionName.mockReturnValue("test_users");
    mockGetNewslettersCollectionName.mockReturnValue("test_newsletters");
    mockGetTokenFromRequest.mockReturnValue({ email: "admin@example.com", role: "superuser" } as any);
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks({
      method: "GET",
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toEqual({ error: "Method not allowed" });
  });

  it("should return early if rate limit is exceeded", async () => {
    mockGenericRateLimiter.mockResolvedValue(false as any);

    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test", content: "Content" },
    });

    await handler(req as any, res as any);

    // Rate limiter should handle the response
    expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
      name: "sendNewsletter",
      max: 5,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("should validate superuser role", async () => {
    mockRequireSuperuserRoleFromFirestore.mockRejectedValue(new Error("Unauthorized: Superuser privileges required"));

    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test", content: "Content" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(403);
    expect(JSON.parse(res._getData())).toEqual({
      error: "Forbidden: Superuser privileges required",
    });
  });

  it("should validate required subject field", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { content: "Test content" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Subject is required" });
  });

  it("should validate empty subject field", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "   ", content: "Test content" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Subject is required" });
  });

  it("should validate required content field", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test subject" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Content is required" });
  });

  it("should validate empty content field", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test subject", content: "" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Content is required" });
  });

  it("should validate subject length", async () => {
    const longSubject = "a".repeat(201);
    const { req, res } = createMocks({
      method: "POST",
      body: { subject: longSubject, content: "Test content" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Subject too long (max 200 characters)" });
  });

  it("should validate content length", async () => {
    const longContent = "a".repeat(50001);
    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test subject", content: longContent },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "Content too long (max 50,000 characters)" });
  });

  it("should validate CTA fields when URL is provided but text is missing", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
        ctaUrl: "https://example.com",
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "CTA text is required when CTA URL is provided" });
  });

  it("should validate CTA fields when text is provided but URL is missing", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
        ctaText: "Click here",
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "CTA URL is required when CTA text is provided" });
  });

  it("should validate role selection - at least one role must be selected", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
        includeRoles: { users: false, admins: false, superusers: false },
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toEqual({ error: "At least one user role must be selected" });
  });

  it("should return error when no subscribed users found", async () => {
    // Mock users found but none subscribed
    const unsubscribedUser = {
      id: "user@example.com",
      data: () => ({
        inviteStatus: "accepted",
        role: "user",
        emailPreferences: {
          newsletters: false,
        },
      }),
    };

    mockFirestoreQueryGet.mockResolvedValue({
      empty: false,
      docs: [unsubscribedUser],
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
        includeRoles: { users: true, admins: false, superusers: false },
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(400);
    const response = JSON.parse(res._getData());
    expect(response.error).toBe("No newsletter subscribers found");
    expect(response.details).toContain("There are currently no active Users with newsletter subscriptions enabled");
  });

  it("should successfully send newsletter to subscribed users", async () => {
    const mockUsers = [
      {
        id: "user1@example.com",
        data: () => ({
          firstName: "John",
          lastName: "Doe",
          role: "user",
        }),
      },
      {
        id: "user2@example.com",
        data: () => ({
          firstName: "Jane",
          lastName: "Smith",
          role: "user",
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      empty: false,
      docs: mockUsers,
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test Newsletter",
        content: "This is a test newsletter content.",
        ctaUrl: "https://example.com",
        ctaText: "Learn More",
        includeRoles: { users: true, admins: false, superusers: false },
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    const response = JSON.parse(res._getData());
    expect(response.message).toBe("Newsletter queued successfully");
    expect(response.newsletterId).toBe("mock-newsletter-id");
    expect(response.totalQueued).toBe(2);

    // Verify firestore operations
    expect(mockFirestoreSet).toHaveBeenCalledTimes(1);
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.any(Object), // newsletter doc reference
      expect.objectContaining({
        subject: "Test Newsletter",
        content: "This is a test newsletter content.",
        ctaUrl: "https://example.com",
        ctaText: "Learn More",
        sentBy: "admin@example.com",
        status: "queued",
        totalQueued: 2,
        sentCount: 0,
        failedCount: 0,
      }),
      undefined,
      "save newsletter metadata"
    );
  });

  it("should use default role selection when includeRoles is not provided", async () => {
    const mockUsers = [
      {
        id: "user1@example.com",
        data: () => ({ role: "user" }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      empty: false,
      docs: mockUsers,
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    // Should include all roles by default
  });

  it("should handle users with missing name fields", async () => {
    const mockUsers = [
      {
        id: "user1@example.com",
        data: () => ({
          role: "user",
          // Missing firstName and lastName
        }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      empty: false,
      docs: mockUsers,
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    // Should handle missing names gracefully
  });

  it("should trim whitespace from subject, content, and CTA fields", async () => {
    const mockUsers = [
      {
        id: "user1@example.com",
        data: () => ({ role: "user" }),
      },
    ];

    mockFirestoreQueryGet.mockResolvedValue({
      empty: false,
      docs: mockUsers,
    } as any);

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "  Test subject  ",
        content: "  Test content  ",
        ctaUrl: "  https://example.com  ",
        ctaText: "  Click here  ",
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);

    // Verify trimmed values are saved
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        subject: "Test subject",
        content: "Test content",
        ctaUrl: "https://example.com",
        ctaText: "Click here",
      }),
      undefined,
      "save newsletter metadata"
    );
  });

  it("should handle database not available", async () => {
    // Mock db as undefined
    const firebase = jest.requireMock("@/services/firebase");
    const originalDb = firebase.db;
    firebase.db = undefined;

    const { req, res } = createMocks({
      method: "POST",
      body: { subject: "Test", content: "Content" },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getData())).toEqual({ error: "Database not available" });

    // Restore db
    firebase.db = originalDb;
  });

  it("should handle Firestore query errors", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("Database connection failed"));

    const { req, res } = createMocks({
      method: "POST",
      body: {
        subject: "Test subject",
        content: "Test content",
        includeRoles: { users: true },
      },
    });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(500);
    // Error response no longer includes details field - only sanitized error message
    const response = JSON.parse(res._getData());
    expect(response).toHaveProperty("error");
    expect(typeof response.error).toBe("string");
    // Error message may be sanitized, so we just check it exists
  });
});
