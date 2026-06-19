/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/downvotes/syncStatus";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { firestoreGetAll, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";

jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h: any) => h }));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/sudoCookieUtils");
jest.mock("@/utils/server/authz", () => ({ requireSuperuserRoleFromFirestore: jest.fn() }));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/corsMiddleware", () => ({
  setCorsHeaders: jest.fn(),
  createErrorCorsHeaders: jest.fn(() => ({})),
}));
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("answers"),
  getDownvoteFeedbackEventsCollectionName: jest.fn().mockReturnValue("events"),
}));
jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(() => ({}), { FieldValue: { delete: jest.fn(() => "DELETE") } }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockGetSudoCookie = getSudoCookie as jest.MockedFunction<typeof getSudoCookie>;
const mockFirestoreGetAll = firestoreGetAll as jest.MockedFunction<typeof firestoreGetAll>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockFirestoreUpdate = firestoreUpdate as jest.MockedFunction<typeof firestoreUpdate>;
const { db } = jest.requireMock("@/services/firebase");

function post(body: Record<string, unknown> = {}) {
  return createMocks<NextApiRequest, NextApiResponse>({ method: "POST", body });
}

describe("/api/admin/downvotes/syncStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false, allowedFrontEndDomains: [] } as any);
    mockRateLimiter.mockResolvedValue(true);
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: "valid" } as any);
    mockFirestoreUpdate.mockResolvedValue(undefined as any);
    db.collection = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      doc: jest.fn((id: string) => ({ id })),
    }));
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 403 when sudo cookie is missing", async () => {
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: null, message: "no sudo" } as any);
    const { req, res } = post();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("syncs mirror fields, counting updated/unchanged/skipped/missing", async () => {
    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        { id: "a1", data: () => ({}) }, // no event -> skippedNoEvent
        { id: "a2", data: () => ({ feedbackEventId: "e2" }) }, // missing event
        { id: "a3", data: () => ({ feedbackEventId: "e3", feedbackTriageStatus: "old" }) }, // updated
        { id: "a4", data: () => ({ feedbackEventId: "e4", feedbackTriageStatus: "classified" }) }, // unchanged
      ],
    } as any);
    // unique event ids: e2, e3, e4 (in order)
    mockFirestoreGetAll.mockResolvedValue([
      { exists: false } as any, // e2
      { exists: true, data: () => ({ triageStatus: "classified" }) } as any, // e3
      { exists: true, data: () => ({ triageStatus: "classified" }) } as any, // e4
    ]);
    const { req, res } = post({ limit: 100 });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toMatchObject({ ok: true, scanned: 4, updated: 1, unchanged: 1, skippedNoEvent: 1, missingEvent: 1 });
    expect(mockFirestoreUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not write updates in dry-run mode", async () => {
    mockFirestoreQueryGet.mockResolvedValue({
      docs: [{ id: "a3", data: () => ({ feedbackEventId: "e3", feedbackTriageStatus: "old" }) }],
    } as any);
    mockFirestoreGetAll.mockResolvedValue([{ exists: true, data: () => ({ triageStatus: "classified" }) } as any]);
    const { req, res } = post({ dryRun: true });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ updated: 1, dryRun: true });
    expect(mockFirestoreUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("boom"));
    const { req, res } = post();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
