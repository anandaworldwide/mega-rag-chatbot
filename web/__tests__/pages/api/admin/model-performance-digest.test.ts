/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/model-performance-digest";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";

jest.mock("@/utils/server/cronAuthUtils", () => ({ withJwtOrCronAuth: (h: any) => h }));
jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h: any) => h }));
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/emailOps", () => ({ sendOpsAlert: jest.fn() }));
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

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockSendOpsAlert = sendOpsAlert as jest.MockedFunction<typeof sendOpsAlert>;
const { db } = jest.requireMock("@/services/firebase");

function snapshotOf(records: any[]) {
  return { forEach: (cb: (doc: any) => void) => records.forEach((r) => cb({ data: () => r })) } as any;
}

const sampleRecord = {
  model: "gpt-4o",
  status: "success",
  totalTokens: 200,
  tokensPerSecond: 50,
  timings: { ttfb: 3000, answerStreaming: 1000, totalSessionTime: 5000 },
};

describe("/api/admin/model-performance-digest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockSendOpsAlert.mockResolvedValue(undefined as any);
    db.collection = jest.fn(() => ({ where: jest.fn().mockReturnThis() }));
  });

  it("rejects unsupported methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "DELETE" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns totals without alerting when there are no records", async () => {
    mockFirestoreQueryGet.mockResolvedValue(snapshotOf([]));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ ok: true, totals: { totalRecords: 0 } });
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });

  it("aggregates records and sends an ops alert", async () => {
    mockFirestoreQueryGet.mockResolvedValue(
      snapshotOf([sampleRecord, { ...sampleRecord, timings: { ttfb: 7000, answerStreaming: 2000, totalSessionTime: 8000 } }])
    );
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "POST", body: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.totals.totalRecords).toBe(2);
    expect(data.models).toHaveLength(1);
    expect(mockSendOpsAlert).toHaveBeenCalled();
  });

  it("returns 500 when the query throws a non-index error", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("boom"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
