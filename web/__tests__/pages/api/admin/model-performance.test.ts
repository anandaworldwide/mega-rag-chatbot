/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/model-performance";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";

jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h: any) => h }));
jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h: any) => h }));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/sudoCookieUtils");
jest.mock("@/utils/server/authz", () => ({ requireAdminRoleFromFirestore: jest.fn() }));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getModelPerformanceCollectionName: jest.fn().mockReturnValue("model_perf"),
}));
jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(() => ({}), { Timestamp: { fromDate: jest.fn((d: Date) => ({ d })) } }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockGetSudoCookie = getSudoCookie as jest.MockedFunction<typeof getSudoCookie>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const { db } = jest.requireMock("@/services/firebase");

function snapshotOf(records: any[]) {
  return { forEach: (cb: (doc: any) => void) => records.forEach((r) => cb({ data: () => r })) } as any;
}

describe("/api/admin/model-performance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false, siteId: "ananda" } as any);
    mockRateLimiter.mockResolvedValue(true);
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: "valid" } as any);
    db.collection = jest.fn(() => ({ where: jest.fn().mockReturnThis() }));
  });

  it("rejects non-GET methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "POST" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 403 when sudo access is missing", async () => {
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: null } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("aggregates performance records over the lookback window", async () => {
    mockFirestoreQueryGet.mockResolvedValue(
      snapshotOf([
        { model: "gpt-4o", status: "success", totalTokens: 100, tokensPerSecond: 40, timings: { ttfb: 2000, answerStreaming: 500, totalSessionTime: 3000 } },
      ])
    );
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: { days: "14" } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.lookbackDays).toBe(14);
    expect(data.totals.totalRecords).toBe(1);
    expect(data.models).toHaveLength(1);
  });

  it("returns 500 on a non-index query error", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("boom"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
