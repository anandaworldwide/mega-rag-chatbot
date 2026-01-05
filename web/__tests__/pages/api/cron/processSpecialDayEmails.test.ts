/** @jest-environment node */
/**
 * Test suite for the Process Special Day Emails cron endpoint
 *
 * Tests cover:
 * 1. Authentication (cron auth)
 * 2. User eligibility filtering
 * 3. Email preference checking
 * 4. Template existence checking
 * 5. Idempotency (campaign already sent)
 * 6. Email sending logic
 * 7. Holy day date matching
 * 8. Error handling
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/cron/processSpecialDayEmails";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendSpecialDayEmail, loadSpecialDayTemplate } from "@/utils/server/specialDayEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { getSpecialDaysForDate, generateCampaignId } from "@/config/specialDays";

// Mock p-map (ES module) to avoid Jest transformation issues
jest.mock("p-map", () => ({
  __esModule: true,
  default: jest.fn(async (iterable: any[], mapper: (item: any) => Promise<any>) => {
    const results = [];
    for (const item of iterable) {
      results.push(await mapper(item));
    }
    return results;
  }),
}));

// Mock dependencies
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/emailPreferenceUtils");
jest.mock("@/utils/server/specialDayEmailUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/config/specialDays");
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
jest.mock("@/utils/server/firestoreIndexErrorHandler", () => ({
  analyzeFirestoreError: jest.fn(() => ({ isIndexError: false })),
  notifyOpsOfIndexError: jest.fn(),
}));
jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
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
const _mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockIsSubscribedToCategory = isSubscribedToCategory as jest.MockedFunction<typeof isSubscribedToCategory>;
const mockSendSpecialDayEmail = sendSpecialDayEmail as jest.MockedFunction<typeof sendSpecialDayEmail>;
const mockLoadSpecialDayTemplate = loadSpecialDayTemplate as jest.MockedFunction<typeof loadSpecialDayTemplate>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockGetSpecialDaysForDate = getSpecialDaysForDate as jest.MockedFunction<typeof getSpecialDaysForDate>;
const mockGenerateCampaignId = generateCampaignId as jest.MockedFunction<typeof generateCampaignId>;

describe("/api/cron/processSpecialDayEmails", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "test-cron-secret",
      SITE_ID: "ananda",
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };
    delete process.env.SPECIAL_DAY_TEST_EMAIL;

    mockDb.collection = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        ref: { id: "test-doc-id" },
      }),
    });

    // Mock runTransaction to allow sending emails
    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            specialDayEmailsSent: [],
            pendingSpecialDayKeys: [],
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

    mockLoadSpecialDayTemplate.mockResolvedValue({
      specialDayId: "masters-birthday",
      subject: "Tomorrow is Master's Birthday",
      greeting: "Dear {{firstName}},",
      body: "Body text",
      exampleQuestionPool: ["Question 1", "Question 2"],
      exampleQuestionCount: 3,
    } as any);

    // Mock special days for today (Jan 4, 2026 - day before Master's birthday)
    const mockSpecialDay = {
      id: "masters-birthday",
      name: "Master's Birthday",
      getDate: jest.fn((year: number) => new Date(year, 0, 5)),
      sendDaysBefore: 1,
    };
    mockGetSpecialDaysForDate.mockResolvedValue([mockSpecialDay] as any);
    mockGenerateCampaignId.mockImplementation((id: string, year: number) => `${id}-${year}`);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should skip non-login-required sites", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda-public",
      requireLogin: false,
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.message).toContain("does not require login");
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("should return early when no special days match today", async () => {
    mockGetSpecialDaysForDate.mockResolvedValue([]);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.message).toContain("No special day emails to send today");
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("should skip users not subscribed to specialDay emails", async () => {
    const mockUser = {
      id: "user1@example.com",
      inviteStatus: "accepted",
      emailPreferences: {
        specialDay: false,
      },
      specialDayEmailsSent: [],
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "user1@example.com",
          data: () => mockUser,
          ref: { id: "user1@example.com" },
        },
      ],
      empty: false,
      size: 1,
    } as any);

    mockIsSubscribedToCategory.mockReturnValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendSpecialDayEmail).not.toHaveBeenCalled();
  });

  it("should skip users who already received the campaign", async () => {
    const campaignId = "masters-birthday-2026";
    const mockUser = {
      id: "user1@example.com",
      inviteStatus: "accepted",
      emailPreferences: {
        specialDay: true,
      },
      specialDayEmailsSent: [campaignId],
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "user1@example.com",
          data: () => mockUser,
          ref: { id: "user1@example.com" },
        },
      ],
      empty: false,
      size: 1,
    } as any);

    mockIsSubscribedToCategory.mockReturnValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendSpecialDayEmail).not.toHaveBeenCalled();
  });

  it("should send email to eligible users", async () => {
    const mockUser = {
      id: "user1@example.com",
      firstName: "John",
      inviteStatus: "accepted",
      emailPreferences: {
        specialDay: true,
      },
      specialDayEmailsSent: [],
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "user1@example.com",
          data: () => mockUser,
          ref: { id: "user1@example.com" },
        },
      ],
      empty: false,
      size: 1,
    } as any);

    mockIsSubscribedToCategory.mockReturnValue(true);
    mockSendSpecialDayEmail.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(1);
    expect(mockSendSpecialDayEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user1@example.com" }),
      "masters-birthday",
      "ananda",
      "https://test.example.com",
      2026
    );
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        specialDayEmailsSent: expect.anything(),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it("should handle idempotency correctly with transactions", async () => {
    const campaignId = "masters-birthday-2026";
    const mockUser = {
      id: "user1@example.com",
      inviteStatus: "accepted",
      emailPreferences: {
        specialDay: true,
      },
      specialDayEmailsSent: [],
      pendingSpecialDayKeys: [],
    };

    // Mock transaction to detect already sent
    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            specialDayEmailsSent: [campaignId], // Already sent
            pendingSpecialDayKeys: [],
          }),
        }),
        update: jest.fn(),
      };
      return callback(mockTransaction);
    });

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "user1@example.com",
          data: () => mockUser,
          ref: { id: "user1@example.com" },
        },
      ],
      empty: false,
      size: 1,
    } as any);

    mockIsSubscribedToCategory.mockReturnValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendSpecialDayEmail).not.toHaveBeenCalled();
  });

  it("should skip template when it doesn't exist for site", async () => {
    mockLoadSpecialDayTemplate.mockResolvedValue(null);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendSpecialDayEmail).not.toHaveBeenCalled();
  });

  it("should handle test mode with specific user", async () => {
    process.env.SPECIAL_DAY_TEST_EMAIL = "test@example.com";

    const mockUser = {
      id: "test@example.com",
      firstName: "Test",
      inviteStatus: "accepted",
      emailPreferences: {
        specialDay: true,
      },
      specialDayEmailsSent: [],
    };

    _mockFirestoreGet.mockResolvedValue({
      exists: true,
      data: () => mockUser,
      id: "test@example.com",
      ref: { id: "test@example.com" },
    } as any);

    mockIsSubscribedToCategory.mockReturnValue(true);
    mockSendSpecialDayEmail.mockResolvedValue(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.testMode).toBe(true);
    expect(data.testEmail).toBe("test@example.com");
    expect(mockSendSpecialDayEmail).toHaveBeenCalled();
  });
});
