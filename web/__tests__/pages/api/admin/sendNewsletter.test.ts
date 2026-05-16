/** @jest-environment node */
/**
 * Test suite for the Send Newsletter API endpoint
 *
 * Tests cover:
 * 1. Authentication (superuser required)
 * 2. Rate limiting
 * 3. Input validation
 * 4. User filtering by role and subscription status
 * 5. Newsletter queueing
 * 6. Email preference checking
 * 7. Error handling
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/sendNewsletter";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { isEmailBlacklisted } from "@/utils/server/blacklist";

// Mock dependencies
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/authz");
jest.mock("@/utils/server/emailPreferenceUtils");
jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
  getTokenFromRequest: jest.fn(() => ({ email: "admin@example.com" })),
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
  getNewslettersCollectionName: jest.fn().mockReturnValue("test_newsletters"),
}));
jest.mock("@/utils/server/errorSanitization", () => ({
  getSafeErrorMessage: jest.fn((err: any) => err?.message || "Unknown error"),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    })),
  };
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
    batch: jest.fn(),
  }));
  (firestoreFn as any).Timestamp = mockTimestamp;
  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: { cert: jest.fn() },
    initializeApp: jest.fn(),
  };
});

const mockDb = db as any;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockRequireSuperuserRoleFromFirestore = requireSuperuserRoleFromFirestore as jest.MockedFunction<
  typeof requireSuperuserRoleFromFirestore
>;
const mockIsSubscribedToCategory = isSubscribedToCategory as jest.MockedFunction<typeof isSubscribedToCategory>;
const mockIsEmailBlacklisted = isEmailBlacklisted as jest.MockedFunction<typeof isEmailBlacklisted>;

describe("/api/admin/sendNewsletter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenericRateLimiter.mockResolvedValue(true);
    mockRequireSuperuserRoleFromFirestore.mockResolvedValue(undefined);
    mockFirestoreSet.mockResolvedValue(undefined);
    mockIsEmailBlacklisted.mockResolvedValue(false);
    mockDb.batch = jest.fn().mockReturnValue({
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    });
    // Support nested collection patterns like collection().doc() and collection(path).doc()
    mockDb.collection = jest.fn().mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        id: "test-newsletter-id",
      }),
    }));
  });

  describe("Method Validation", () => {
    it("should only allow POST method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      mockGenericRateLimiter.mockResolvedValue(false);

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalled();
      // Rate limiter sends response internally
    });
  });

  describe("Authentication", () => {
    it("should require superuser role", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      mockRequireSuperuserRoleFromFirestore.mockRejectedValue(new Error("Forbidden: Superuser privileges required"));

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({
        error: "Forbidden: Superuser privileges required",
      });
    });
  });

  describe("Input Validation", () => {
    it("should reject request without subject", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          content: "Test Content",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Subject is required",
      });
    });

    it("should reject request without content", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Content is required",
      });
    });

    it("should reject subject longer than 200 characters", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "a".repeat(201),
          content: "Test Content",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Subject too long (max 200 characters)",
      });
    });

    it("should reject content longer than 50000 characters", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "a".repeat(50001),
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Content too long (max 50,000 characters)",
      });
    });
  });

  describe("User Filtering", () => {
    it("should filter users by subscription status using emailPreferences", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      const subscribedUser = {
        id: "subscribed@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: {
            newsletters: true,
            onboarding: true,
          },
        }),
      };

      const unsubscribedUser = {
        id: "unsubscribed@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: {
            newsletters: false,
            onboarding: true,
          },
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [subscribedUser, unsubscribedUser],
      } as any);

      mockIsSubscribedToCategory.mockImplementation((user: any) => {
        return user.emailPreferences?.newsletters === true;
      });

      await handler(req, res);

      expect(mockIsSubscribedToCategory).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.totalQueued).toBe(1); // Only subscribed user
    });

    it("should suppress blacklisted emails at queue-build time", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      const subscribedUser = {
        id: "good@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: { newsletters: true },
        }),
      };

      const blacklistedUser = {
        id: "blocked@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: { newsletters: true },
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [subscribedUser, blacklistedUser],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockIsEmailBlacklisted.mockImplementation(async (email: string) => email === "blocked@example.com");

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.totalQueued).toBe(1);
      expect(data.blacklistedSuppressed).toBe(1);
    });

    it("should return error when all subscribed users are blacklisted", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      const subscribedUser = {
        id: "blocked@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: { newsletters: true },
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [subscribedUser],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockIsEmailBlacklisted.mockResolvedValue(true);

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "No newsletter subscribers found",
        details: expect.stringContaining("no active"),
      });
    });

    it("should return error when no subscribed users found", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      const unsubscribedUser = {
        id: "unsubscribed@example.com",
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

      mockIsSubscribedToCategory.mockReturnValue(false);

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "No newsletter subscribers found",
        details: expect.stringContaining("no active"),
      });
    });

    it("should return error when no users found at all", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      mockFirestoreQueryGet.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "No users found",
        details: expect.stringContaining("no active"),
      });
    });
  });

  describe("Newsletter Queueing", () => {
    it("should queue newsletter for subscribed users", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
          ctaUrl: "https://example.com",
          ctaText: "Click Here",
        },
      });

      const subscribedUser = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          firstName: "John",
          lastName: "Doe",
          emailPreferences: {
            newsletters: true,
          },
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [subscribedUser],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.message).toBe("Newsletter queued successfully");
      expect(data.totalQueued).toBe(1);
      expect(data.newsletterId).toBeDefined();
    });

    it("should filter by role selection", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
          includeRoles: {
            users: true,
            admins: false,
            superusers: false,
          },
        },
      });

      const userDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          role: "user",
          emailPreferences: {
            newsletters: true,
          },
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [userDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      // Verify query was built with role filter
      expect(mockDb.collection).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should handle database errors gracefully", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          subject: "Test Subject",
          content: "Test Content",
        },
      });

      mockFirestoreQueryGet.mockRejectedValue(new Error("Database error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
