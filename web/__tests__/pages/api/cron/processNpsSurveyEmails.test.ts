/** @jest-environment node */
/**
 * Test suite for the Process NPS Survey Emails cron endpoint
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/cron/processNpsSurveyEmails";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { sendNpsSurveyEmail, loadNpsSurveyTemplate } from "@/utils/server/npsSurveyEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter as _genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { daysSince } from "@/utils/server/dateUtils";

const createMockTimestampFromMillis = (ms: number) => {
  const date = new Date(ms);
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1000000,
    toDate: () => date,
    toMillis: () => ms,
  };
};

// Mock dependencies
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/npsSurveyEmailUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/cronAuthUtils", () => ({
  withJwtOrCronAuth: jest.fn((handler) => handler),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));
jest.mock("@/utils/server/errorSanitization", () => ({
  getSafeErrorMessage: jest.fn((error, fallback) => fallback || error?.message || "Error"),
}));
jest.mock("@/utils/server/dateUtils", () => ({
  daysSince: jest.fn(),
}));

// Mock firebase-admin
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
    delete: jest.fn(() => ({ _delete: true })),
  };
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
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
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockSendNpsSurveyEmail = sendNpsSurveyEmail as jest.MockedFunction<typeof sendNpsSurveyEmail>;
const mockLoadNpsSurveyTemplate = loadNpsSurveyTemplate as jest.MockedFunction<typeof loadNpsSurveyTemplate>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockDaysSince = daysSince as jest.MockedFunction<typeof daysSince>;
// genericRateLimiter is mocked

describe("/api/cron/processNpsSurveyEmails", () => {
  const originalEnv = process.env;
  const now = Date.now();
  const oneHourAgo = now - 1 * 60 * 60 * 1000; // Active in last 72h
  const seventyThreeHoursAgo = now - 73 * 60 * 60 * 1000; // Not active in last 72h
  const sevenMonthsAgo = now - 7 * 30 * 24 * 60 * 60 * 1000; // > 6 months ago
  const fiveMonthsAgo = now - 5 * 30 * 24 * 60 * 60 * 1000; // < 6 months ago
  const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000; // > 14 days ago (verified)

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CRON_SECRET: "test-cron-secret",
      SITE_ID: "ananda",
      NEXT_PUBLIC_BASE_URL: "https://test.example.com",
    };
    delete process.env.NPS_SURVEY_TEST_EMAIL;

    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      shortname: "Luca",
      name: "Luca, The Ananda Devotee Chatbot",
      requireLogin: true,
      enableNpsSurveyEmail: true,
    } as any);
    mockLoadNpsSurveyTemplate.mockResolvedValue({
      subject: "Quick question about {{shortname}}",
      greeting: "Hi {{firstName}},",
      body: "We'd love to hear your feedback!",
    } as any);

    // Ensure mocks return resolved promises
    mockFirestoreSet.mockResolvedValue(undefined);
    mockFirestoreGet.mockResolvedValue({ exists: true, data: () => ({}) } as any);
    mockSendNpsSurveyEmail.mockResolvedValue(true);
    (_genericRateLimiter as jest.MockedFunction<typeof _genericRateLimiter>).mockResolvedValue(true);

    mockDb.collection = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnValue({
        ref: { id: "test@example.com" },
      }),
    });

    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            lastNpsSurveySentAt: null,
            pendingNpsSurveyKeys: [],
          }),
        }),
        update: jest.fn(),
      };
      return callback(mockTransaction);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return 405 for non-POST/GET requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "PUT",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("should skip when site does not have NPS surveys enabled", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      requireLogin: true,
      enableNpsSurveyEmail: false,
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.processed).toBe(0);
    expect(data.sent).toBe(0);
  });

  it("should skip when site does not require login", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      requireLogin: false,
      enableNpsSurveyEmail: true,
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.processed).toBe(0);
    expect(data.sent).toBe(0);
  });

  it("should skip when template not found", async () => {
    mockLoadNpsSurveyTemplate.mockResolvedValue(null);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.processed).toBe(0);
    expect(data.sent).toBe(0);
  });

  it("should send email to eligible user", async () => {
    const mockUserDoc = {
      id: "test@example.com",
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: true },
        lastActivityAt: createMockTimestampFromMillis(oneHourAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(sevenMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [mockUserDoc],
      empty: false,
      size: 1,
    } as any);

    mockDaysSince.mockImplementation((timestamp: any) => {
      if (!timestamp) return 0;
      const ts = timestamp.toMillis ? timestamp.toMillis() : timestamp;
      return Math.floor((now - ts) / (24 * 60 * 60 * 1000));
    });

    mockSendNpsSurveyEmail.mockResolvedValue(true);

    // Mock transaction to succeed
    mockDb.runTransaction = jest.fn().mockResolvedValue({ sent: true, reason: "proceed" });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(1);
    expect(mockSendNpsSurveyEmail).toHaveBeenCalled();
  });

  it("should skip user not active in last 72 hours", async () => {
    const mockUserDoc = {
      id: "test@example.com",
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: true },
        lastActivityAt: createMockTimestampFromMillis(seventyThreeHoursAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(sevenMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [mockUserDoc],
      empty: false,
      size: 1,
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendNpsSurveyEmail).not.toHaveBeenCalled();
  });

  it("should skip user who received NPS email less than 6 months ago", async () => {
    const mockUserDoc = {
      id: "test@example.com",
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: true },
        lastActivityAt: createMockTimestampFromMillis(oneHourAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(fiveMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [mockUserDoc],
      empty: false,
      size: 1,
    } as any);

    mockDaysSince.mockReturnValue(150); // 5 months

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendNpsSurveyEmail).not.toHaveBeenCalled();
  });

  it("should skip user not subscribed to NPS emails", async () => {
    const mockUserDoc = {
      id: "test@example.com",
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: false },
        lastActivityAt: createMockTimestampFromMillis(oneHourAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(sevenMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [mockUserDoc],
      empty: false,
      size: 1,
    } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.sent).toBe(0);
    expect(mockSendNpsSurveyEmail).not.toHaveBeenCalled();
  });

  it("should handle test mode", async () => {
    process.env.NPS_SURVEY_TEST_EMAIL = "test@example.com";

    const mockUserDoc = {
      id: "test@example.com",
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: true },
        lastActivityAt: createMockTimestampFromMillis(oneHourAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(sevenMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreGet.mockResolvedValue(mockUserDoc as any);
    mockSendNpsSurveyEmail.mockResolvedValue(true);

    // Mock daysSince to return different values based on timestamp
    mockDaysSince.mockImplementation((timestamp: any) => {
      if (!timestamp) return 0;
      const ts = timestamp.toMillis ? timestamp.toMillis() : timestamp;
      const days = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
      return days;
    });

    // Mock transaction
    const mockTransactionUpdate = jest.fn();
    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => mockUserDoc.data(),
        }),
        update: mockTransactionUpdate,
      };
      return callback(mockTransaction);
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.testMode).toBe(true);
    expect(data.testEmail).toBe("test@example.com");
  });

  it("should update lastNpsSurveySentAt after successful send", async () => {
    const mockUserDoc = {
      id: "test@example.com",
      data: () => ({
        inviteStatus: "accepted",
        emailPreferences: { nps: true },
        lastActivityAt: createMockTimestampFromMillis(oneHourAgo),
        lastNpsSurveySentAt: createMockTimestampFromMillis(sevenMonthsAgo),
        verifiedAt: createMockTimestampFromMillis(fifteenDaysAgo),
        npsSendAttempts: 0,
        pendingNpsSurveyKeys: [],
      }),
      ref: { id: "test@example.com" },
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [mockUserDoc],
      empty: false,
      size: 1,
    } as any);

    // Mock daysSince to return different values based on timestamp
    mockDaysSince.mockImplementation((timestamp: any) => {
      if (!timestamp) return 0;
      const ts = timestamp.toMillis ? timestamp.toMillis() : timestamp;
      return Math.floor((now - ts) / (24 * 60 * 60 * 1000));
    });
    mockSendNpsSurveyEmail.mockResolvedValue(true);

    // Mock transaction to capture the update call
    const mockTransactionUpdate = jest.fn();
    mockDb.runTransaction = jest.fn().mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => mockUserDoc.data(),
        }),
        update: mockTransactionUpdate,
      };
      return callback(mockTransaction);
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    // Check that transaction.update was called with lastNpsSurveySentAt
    expect(mockTransactionUpdate).toHaveBeenCalledWith(
      mockUserDoc.ref,
      expect.objectContaining({
        lastNpsSurveySentAt: expect.any(Object),
        pendingNpsSurveyKeys: expect.any(Object),
      })
    );

    // Check that firestoreSet was called to remove pending key after successful send
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      mockUserDoc.ref,
      expect.objectContaining({
        pendingNpsSurveyKeys: expect.any(Object),
      }),
      { merge: true },
      expect.stringContaining("remove pending key")
    );
  });
});
