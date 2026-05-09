import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/salesforce/verifyAccess";
import { syncUserAccessLevelFromSalesforce } from "@/utils/server/salesforceAccessSync";

const mockUserDoc = {};

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => mockUserDoc),
    })),
  },
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));

jest.mock("@/utils/server/loadSiteConfig", () => {
  const siteConfig = {
    accessControl: {
      enabled: true,
      levels: [{ key: "public", label: "Public", value: 0 }],
      defaultLevel: 0,
      superuserLevel: 9999,
    },
  };

  return {
    loadSiteConfigSync: jest.fn(() => siteConfig),
  };
});

jest.mock("@/utils/server/salesforceAccessSync", () => {
  const actual = jest.requireActual("@/utils/server/salesforceAccessSync");
  return {
    ...actual,
    syncUserAccessLevelFromSalesforce: jest.fn(),
  };
});

const mockSyncUserAccessLevelFromSalesforce = syncUserAccessLevelFromSalesforce as jest.MockedFunction<
  typeof syncUserAccessLevelFromSalesforce
>;

describe("/api/salesforce/verifyAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncUserAccessLevelFromSalesforce.mockResolvedValue({
      matched: true,
      salesforceId: "0031I00000ILXk1QAH",
      salesforceAccessLevel: 300,
    });
  });

  function createPostRequest(body: Record<string, unknown> = {}) {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: {
        cookie: "auth=valid-jwt-token",
      },
      body,
    });
    req.cookies = { auth: "valid-jwt-token" };
    return { req, res };
  }

  it("skips fresh users without calling Salesforce", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const jwtUtils = await import("@/utils/server/jwtUtils");
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    (jwtUtils.verifyToken as jest.MockedFunction<any>).mockReturnValueOnce({
      email: "test@example.com",
      role: "user",
    });
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        role: "user",
        lastSalesforceSyncAt: { toDate: () => oneDayAgo },
      }),
    });

    const { req, res } = createPostRequest();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true, skipped: "fresh" });
    expect(mockSyncUserAccessLevelFromSalesforce).not.toHaveBeenCalled();
  });

  it("syncs stale users using the auth-cookie email instead of a request body email", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const jwtUtils = await import("@/utils/server/jwtUtils");
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    (jwtUtils.verifyToken as jest.MockedFunction<any>).mockReturnValueOnce({
      email: "test@example.com",
      role: "user",
    });
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        role: "user",
        lastSalesforceSyncAt: { toDate: () => fourDaysAgo },
      }),
    });

    const { req, res } = createPostRequest({ email: "attacker@example.com" });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(mockSyncUserAccessLevelFromSalesforce).toHaveBeenCalledWith(
      "test@example.com",
      expect.objectContaining({ accessControl: expect.objectContaining({ enabled: true }) })
    );
  });

  it("skips non-accepted users", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const jwtUtils = await import("@/utils/server/jwtUtils");

    (jwtUtils.verifyToken as jest.MockedFunction<any>).mockReturnValueOnce({
      email: "test@example.com",
      role: "user",
    });
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "activated_pending_profile",
        role: "user",
      }),
    });

    const { req, res } = createPostRequest();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true, skipped: "not_accepted" });
    expect(mockSyncUserAccessLevelFromSalesforce).not.toHaveBeenCalled();
  });

  it("syncs stale local superusers while preserving effective superuser access elsewhere", async () => {
    const firestoreRetryUtils = await import("@/utils/server/firestoreRetryUtils");
    const jwtUtils = await import("@/utils/server/jwtUtils");
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    (jwtUtils.verifyToken as jest.MockedFunction<any>).mockReturnValueOnce({
      email: "test@example.com",
      role: "superuser",
    });
    (firestoreRetryUtils.firestoreGet as jest.MockedFunction<any>).mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        role: "superuser",
        lastSalesforceSyncAt: { toDate: () => fourDaysAgo },
      }),
    });

    const { req, res } = createPostRequest();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(mockSyncUserAccessLevelFromSalesforce).toHaveBeenCalledWith(
      "test@example.com",
      expect.objectContaining({ accessControl: expect.objectContaining({ enabled: true }) })
    );
  });
});
