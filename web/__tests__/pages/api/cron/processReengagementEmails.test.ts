/** @jest-environment node */
/**
 * Test suite for the Process Re-engagement Emails cron endpoint
 *
 * Tests cover:
 * 1. Authentication (cron auth)
 * 2. User eligibility filtering (21-30 days inactive)
 * 3. Email preference checking
 * 4. Template existence checking
 * 5. Idempotency (campaign already sent)
 * 6. Email sending logic
 * 7. Error handling
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/cron/processReengagementEmails";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendReengagementEmail, loadReengagementTemplate } from "@/utils/server/reengagementEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isEmailBlacklisted } from "@/utils/server/blacklist";

const createMockTimestampFromMillis = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: (ms % 1000) * 1000000,
  toDate: () => new Date(ms),
  toMillis: () => ms,
});

// Mock dependencies
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/emailPreferenceUtils");
jest.mock("@/utils/server/reengagementEmailUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/cronAuthUtils", () => ({
  withJwtOrCronAuth: jest.fn((handler) => handler),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true), // Always allow in tests
}));
jest.mock("@/utils/server/errorSanitization", () => ({
  getSafeErrorMessage: jest.fn((error, fallback) => fallback || error?.message || "Error"),
}));

// Mock firebase-admin for Timestamp.now() and FieldValue
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
      toDate: () => new Date(),
      toMillis: () => Date.now(),
    })),
    fromMillis: jest.fn((ms: number) => ({
      seconds: Math.floor(ms / 1000),
      nanoseconds: 0,
      toDate: () => new Date(ms),
      toMillis: () => ms,
    })),
  };
  const mockFieldValue = {
    arrayUnion: jest.fn((...items: any[]) => ({ _arrayUnion: items })),
    arrayRemove: jest.fn((...items: any[]) => ({ _arrayRemove: items })),
    serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  };
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
    batch: jest.fn(),
  }));
  (firestoreFn as any).Timestamp = mockTimestamp;
  (firestoreFn as any).FieldValue = mockFieldValue;
  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: { cert: jest.fn() },
    initializeApp: jest.fn(),
  };
});

const mockDb = db as any;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const _mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>; // Available for test mode tests
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockIsSubscribedToCategory = isSubscribedToCategory as jest.MockedFunction<typeof isSubscribedToCategory>;
const mockSendReengagementEmail = sendReengagementEmail as jest.MockedFunction<typeof sendReengagementEmail>;
const mockLoadReengagementTemplate = loadReengagementTemplate as jest.MockedFunction<typeof loadReengagementTemplate>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockIsEmailBlacklisted = isEmailBlacklisted as jest.MockedFunction<typeof isEmailBlacklisted>;

describe("/api/cron/processReengagementEmails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "test-cron-secret",
      SITE_ID: "ananda",
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };
    // Ensure test mode is off by default
    delete process.env.REENGAGEMENT_TEST_EMAIL;

    mockDb.collection = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        ref: { id: "test-doc-id" },
      }),
    });

    // Mock runTransaction to allow sending emails
    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      // Create a mock transaction object
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            reengagementEmailsSent: [],
            pendingReengagementKeys: [],
          }),
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return callback(mockTransaction);
    });

    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      name: "Ananda",
      requireLogin: true,
    } as any);

    mockLoadReengagementTemplate.mockResolvedValue({
      campaignId: "reengagement-21-nudge",
      subject: "We miss you, {{firstName}}!",
      greeting: "Hi {{firstName}}, it's been a while...",
      leadIn: "If you're not sure what to ask, start here.",
      prompts: {
        meditationSupport: ["Question 1"],
        dailyLife: ["Question 2"],
        inspiration: ["Question 3"],
      },
      ctaCategories: ["meditationSupport"],
      secondaryCta: {
        label: "Return to Luca",
        url: "{{baseUrl}}",
      },
    } as any);

    // Default mock for firestoreSet
    mockFirestoreSet.mockResolvedValue(undefined);

    // Default: email is not blacklisted
    mockIsEmailBlacklisted.mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Method Validation", () => {
    it("should allow POST method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer test-cron-secret",
          "user-agent": "vercel-cron/1.0",
        },
      });

      mockFirestoreQueryGet.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should allow GET method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer test-cron-secret",
          "user-agent": "vercel-cron/1.0",
        },
      });

      mockFirestoreQueryGet.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should reject other methods", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PUT",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
    });
  });

  describe("Site Filtering", () => {
    it("should skip non-login-required sites", async () => {
      mockLoadSiteConfig.mockResolvedValue({
        siteId: "ananda-public",
        name: "Ananda Public",
        requireLogin: false,
      } as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.message).toContain("does not require login");
      expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
    });

    it("should skip sites without templates", async () => {
      mockLoadReengagementTemplate.mockResolvedValue(null);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.message).toContain("No re-engagement template found");
    });
  });

  describe("User Eligibility", () => {
    const now = Date.now();
    const twentyFiveDaysAgo = now - 25 * 24 * 60 * 60 * 1000;

    it("should send email to eligible user (25 days inactive)", async () => {
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
          firstName: "John",
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendReengagementEmail.mockResolvedValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).toHaveBeenCalledTimes(1);
      // Now uses FieldValue.arrayUnion for atomic array updates
      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          reengagementEmailsSent: { _arrayUnion: ["reengagement-21-nudge"] },
        }),
        { merge: true },
        expect.stringContaining("mark re-engagement campaign")
      );
    });

    it("should skip user who is not subscribed", async () => {
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: false },
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should skip blacklisted user without sending re-engagement email", async () => {
      const mockDoc = {
        id: "blocked@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
          firstName: "Blocked",
        }),
        ref: { id: "blocked@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockIsEmailBlacklisted.mockResolvedValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockIsEmailBlacklisted).toHaveBeenCalledWith("blocked@example.com", "ananda");
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
      expect(mockFirestoreSet).not.toHaveBeenCalled();
    });

    it("should skip user who already received this campaign", async () => {
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: ["reengagement-21-nudge"],
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should skip user who is too recent (10 days ago)", async () => {
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(tenDaysAgo),
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should skip user who is too old (65 days ago)", async () => {
      const sixtyFiveDaysAgo = now - 65 * 24 * 60 * 60 * 1000;
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(sixtyFiveDaysAgo),
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should skip user without lastActivityAt or lastLoginAt", async () => {
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          // No lastActivityAt or lastLoginAt
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should prefer lastActivityAt over lastLoginAt", async () => {
      const now = Date.now();
      const twentyFiveDaysAgo = now - 25 * 24 * 60 * 60 * 1000;
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000; // More recent activity

      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastActivityAt: createMockTimestampFromMillis(tenDaysAgo), // Recent activity
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo), // Older login
          firstName: "John",
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      // Should skip because lastActivityAt (10 days) is too recent
      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).not.toHaveBeenCalled();
    });

    it("should fall back to lastLoginAt when lastActivityAt is missing", async () => {
      const now = Date.now();
      const twentyFiveDaysAgo = now - 25 * 24 * 60 * 60 * 1000;

      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          // No lastActivityAt - should fall back to lastLoginAt
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
          firstName: "John",
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendReengagementEmail.mockResolvedValue(true);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      // Should send email using lastLoginAt as fallback
      expect(res.statusCode).toBe(200);
      expect(mockSendReengagementEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("Email Sending", () => {
    const now = Date.now();
    const twentyFiveDaysAgo = now - 25 * 24 * 60 * 60 * 1000;

    it("should handle email send failure gracefully", async () => {
      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
          firstName: "John",
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendReengagementEmail.mockResolvedValue(false); // Send fails

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.errors).toBe(1);
      // After send failure, the pending idempotency key is removed (so it can be retried)
      // So firestoreSet IS called, but to remove the pending key, not to mark as sent
      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          pendingReengagementKeys: expect.any(Object), // arrayRemove call
        }),
        { merge: true },
        expect.stringContaining("remove pending key")
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle database errors gracefully", async () => {
      mockFirestoreQueryGet.mockRejectedValue(new Error("Database error"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
    });

    it("should handle individual user processing errors", async () => {
      const now = Date.now();
      const twentyFiveDaysAgo = now - 25 * 24 * 60 * 60 * 1000;

      const mockDoc = {
        id: "test@example.com",
        data: () => ({
          inviteStatus: "accepted",
          emailPreferences: { reengagement: true },
          reengagementEmailsSent: [],
          lastLoginAt: createMockTimestampFromMillis(twentyFiveDaysAgo),
        }),
        ref: { id: "test@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendReengagementEmail.mockRejectedValue(new Error("Send error"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.errors).toBe(1);
    });
  });
});
