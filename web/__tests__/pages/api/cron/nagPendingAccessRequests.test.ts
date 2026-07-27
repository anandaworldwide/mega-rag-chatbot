/** @jest-environment node */

import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/cron/nagPendingAccessRequests";
import { db } from "@/services/firebase";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { sendPendingAccessRequestNagEmail } from "@/utils/server/pendingAccessRequestNagUtils";

jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/pendingAccessRequestNagUtils", () => {
  const actual = jest.requireActual("@/utils/server/pendingAccessRequestNagUtils");
  return {
    ...actual,
    sendPendingAccessRequestNagEmail: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock("@/utils/server/cronAuthUtils", () => ({
  withJwtOrCronAuth: jest.fn((h) => h),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/utils/server/errorSanitization", () => ({
  getSafeErrorMessage: jest.fn((error, fallback) => fallback || error?.message || "Error"),
}));
jest.mock("@/utils/server/firestoreIndexErrorHandler", () => ({
  analyzeFirestoreError: jest.fn(() => ({ isIndexError: false })),
  notifyOpsOfIndexError: jest.fn(),
}));
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
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockSendNag = sendPendingAccessRequestNagEmail as jest.MockedFunction<typeof sendPendingAccessRequestNagEmail>;

describe("/api/cron/nagPendingAccessRequests", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      SITE_ID: "ananda",
      NEXT_PUBLIC_BASE_URL: "https://example.com",
    };

    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      requireLogin: true,
      shortname: "Luca",
      name: "Luca",
    } as any);

    mockDb.collection = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
    });
    mockFirestoreQueryGet.mockResolvedValue({ docs: [] } as any);
    mockFirestoreSet.mockResolvedValue(undefined as any);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("skips sites that do not require login", async () => {
    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda-public",
      requireLogin: false,
    } as any);

    const { req, res } = createMocks({ method: "POST" });
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      processed: 0,
      sent: 0,
      errors: 0,
    });
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("sends a nag and updates lastNaggedAt for an eligible pending request", async () => {
    const createdAtMs = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const createdAt = {
      seconds: Math.floor(createdAtMs / 1000),
      nanoseconds: 0,
      toDate: () => new Date(createdAtMs),
      toMillis: () => createdAtMs,
    };
    const docRef = { id: "req_1" };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "req_1",
          ref: docRef,
          data: () => ({
            requestId: "req_1",
            requesterEmail: "user@example.com",
            requesterName: "Test User",
            adminEmail: "admin@example.com",
            adminName: "Admin Person",
            status: "pending",
            createdAt,
          }),
        },
      ],
    } as any);

    const { req, res } = createMocks({ method: "POST" });
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      processed: 1,
      sent: 1,
      skipped: 0,
      errors: 0,
    });
    expect(mockSendNag).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req_1",
        adminEmail: "admin@example.com",
        requesterEmail: "user@example.com",
      })
    );
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      docRef,
      expect.objectContaining({
        nagCount: 1,
        lastNaggedAt: expect.anything(),
      }),
      { merge: true },
      expect.any(String)
    );
  });

  it("skips requests that were nagged within the last three days", async () => {
    const createdAtMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const lastNaggedAtMs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const createdAt = {
      seconds: Math.floor(createdAtMs / 1000),
      nanoseconds: 0,
      toDate: () => new Date(createdAtMs),
      toMillis: () => createdAtMs,
    };
    const lastNaggedAt = {
      seconds: Math.floor(lastNaggedAtMs / 1000),
      nanoseconds: 0,
      toDate: () => new Date(lastNaggedAtMs),
      toMillis: () => lastNaggedAtMs,
    };

    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "req_2",
          ref: { id: "req_2" },
          data: () => ({
            requestId: "req_2",
            requesterEmail: "user@example.com",
            requesterName: "Test User",
            adminEmail: "admin@example.com",
            adminName: "Admin Person",
            status: "pending",
            createdAt,
            lastNaggedAt,
            nagCount: 1,
          }),
        },
      ],
    } as any);

    const { req, res } = createMocks({ method: "POST" });
    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      processed: 1,
      sent: 0,
      skipped: 1,
      errors: 0,
    });
    expect(mockSendNag).not.toHaveBeenCalled();
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });
});
