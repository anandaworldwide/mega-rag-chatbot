/** @jest-environment node */
/**
 * Test suite for the Process Onboarding Emails cron endpoint
 *
 * Tests cover:
 * 1. Authentication (cron auth)
 * 2. User eligibility filtering
 * 3. Email preference checking
 * 4. Template existence checking
 * 5. Onboarding sequence tracking
 * 6. Email sending logic
 * 7. Error handling
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/cron/processOnboardingEmails";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendOnboardingEmail, loadOnboardingTemplate } from "@/utils/server/onboardingEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

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
jest.mock("@/utils/server/onboardingEmailUtils");
jest.mock("@/utils/server/loadSiteConfig");
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

// Mock firebase-admin for Timestamp.now()
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
const mockIsSubscribedToCategory = isSubscribedToCategory as jest.MockedFunction<typeof isSubscribedToCategory>;
const mockSendOnboardingEmail = sendOnboardingEmail as jest.MockedFunction<typeof sendOnboardingEmail>;
const mockLoadOnboardingTemplate = loadOnboardingTemplate as jest.MockedFunction<typeof loadOnboardingTemplate>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("/api/cron/processOnboardingEmails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "test-cron-secret",
      SITE_ID: "ananda",
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };

    mockDb.collection = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        ref: { id: "test-doc-id" },
      }),
    });

    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      name: "Ananda",
    } as any);

    mockLoadOnboardingTemplate.mockResolvedValue({
      day: 0,
      subject: "Welcome",
      greeting: "Hi {{firstName}},",
      body: "Welcome message",
      exampleQuestions: ["Question 1"],
    } as any);

    // Default mock for firestoreSet
    mockFirestoreSet.mockResolvedValue(undefined);
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

  describe("Database Availability", () => {
    it("should return 503 when database is not available", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer test-cron-secret",
          "user-agent": "vercel-cron/1.0",
        },
      });

      // Mock db module to return null
      jest.doMock("@/services/firebase", () => ({
        db: null,
      }));

      // Re-import handler to get the null db
      jest.resetModules();
      const handlerModule = await import("@/pages/api/cron/processOnboardingEmails");
      await handlerModule.default(req, res);

      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: "Database not available",
      });

      // Restore
      jest.resetModules();
    });
  });

  describe("No Eligible Users", () => {
    it("should return success with zero counts when no users found", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      mockFirestoreQueryGet.mockResolvedValue({
        empty: true,
        docs: [],
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.processed).toBe(0);
      expect(data.sent).toBe(0);
      expect(data.errors).toBe(0);
    });
  });

  describe("User Filtering", () => {
    it("should skip users not subscribed to onboarding emails", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(false);

      await handler(req, res);

      expect(mockIsSubscribedToCategory).toHaveBeenCalledWith(
        expect.objectContaining({ inviteStatus: "accepted" }),
        "onboarding"
      );
      expect(mockSendOnboardingEmail).not.toHaveBeenCalled();
    });

    it("should process users subscribed to onboarding emails", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      // User without onboardingStartedAt will trigger day 0 email
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendOnboardingEmail.mockResolvedValue(true);
      mockLoadOnboardingTemplate.mockResolvedValue({ day: 0, subject: "Test", body: "Body" } as any);

      await handler(req, res);

      expect(mockSendOnboardingEmail).toHaveBeenCalled();
    });
  });

  describe("Onboarding Start", () => {
    it("should start onboarding sequence for users without onboardingStartedAt", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendOnboardingEmail.mockResolvedValue(true);

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          onboardingStartedAt: expect.any(Object),
          onboardingEmailsSent: [],
        }),
        expect.any(Object),
        "start onboarding sequence for existing user"
      );
    });
  });

  describe("Template Checking", () => {
    it("should skip users when template does not exist for site", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      // User without onboardingStartedAt will try to load day 0 template
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockLoadOnboardingTemplate.mockResolvedValue(null);

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      await handler(req, res);

      expect(mockSendOnboardingEmail).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("no onboarding template"));

      consoleSpy.mockRestore();
    });
  });

  describe("Email Sending", () => {
    it("should send day 0 email and update tracking", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      // User without onboardingStartedAt will trigger day 0 email
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendOnboardingEmail.mockResolvedValue(true);
      mockLoadOnboardingTemplate.mockResolvedValue({ day: 0, subject: "Test", body: "Body" } as any);

      await handler(req, res);

      expect(mockSendOnboardingEmail).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user@example.com" }),
        0,
        "ananda",
        "https://test.example.com"
      );
      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          onboardingEmailsSent: [0],
        }),
        expect.any(Object),
        "mark day 0 email sent"
      );
    });

    it("should handle email sending failures", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      // User without onboardingStartedAt will trigger day 0 email
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockSendOnboardingEmail.mockResolvedValue(false);
      mockLoadOnboardingTemplate.mockResolvedValue({ day: 0, subject: "Test", body: "Body" } as any);

      await handler(req, res);

      const data = res._getJSONData();
      expect(data.errors).toBeGreaterThan(0);
      // Error details are now logged to console, not returned in JSON
    });
  });

  describe("Onboarding Completion", () => {
    it("should mark onboarding as completed after 14 days with all emails sent", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      const fourteenDaysAgo = createMockTimestampFromMillis(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
          onboardingStartedAt: fourteenDaysAgo,
          onboardingEmailsSent: [0, 3, 7, 14],
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          onboardingCompleted: true,
        }),
        expect.any(Object),
        "mark onboarding completed"
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle errors gracefully and continue processing", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      // User without onboardingStartedAt will trigger day 0 email, but sendOnboardingEmail will throw
      const mockUserDoc = {
        id: "user@example.com",
        data: () => ({
          inviteStatus: "accepted",
          onboardingCompleted: false,
        }),
        ref: { id: "user@example.com" },
      };

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: [mockUserDoc],
      } as any);

      mockIsSubscribedToCategory.mockReturnValue(true);
      mockLoadOnboardingTemplate.mockResolvedValue({ day: 0, subject: "Test", body: "Body" } as any);
      // Throw error during email sending to trigger error handling
      mockSendOnboardingEmail.mockRejectedValue(new Error("Email service error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.errors).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });
  });
});
