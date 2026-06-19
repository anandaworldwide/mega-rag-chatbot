/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/downvotes/backfill";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { firestoreAdd, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";

jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h: any) => h, getTokenFromRequest: jest.fn() }));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/sudoCookieUtils");
jest.mock("@/utils/server/authz", () => ({ requireSuperuserRoleFromFirestore: jest.fn() }));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("openai", () => ({ OpenAI: jest.fn() }));
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
  firestore: Object.assign(() => ({}), {
    FieldValue: { delete: jest.fn(() => "DELETE"), serverTimestamp: jest.fn(() => "TS") },
  }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockGetSudoCookie = getSudoCookie as jest.MockedFunction<typeof getSudoCookie>;
const mockFirestoreAdd = firestoreAdd as jest.MockedFunction<typeof firestoreAdd>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockFirestoreUpdate = firestoreUpdate as jest.MockedFunction<typeof firestoreUpdate>;
const { db } = jest.requireMock("@/services/firebase");

function post(body: Record<string, unknown> = {}) {
  return createMocks<NextApiRequest, NextApiResponse>({ method: "POST", body });
}

describe("/api/admin/downvotes/backfill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false, allowedFrontEndDomains: [] } as any);
    mockRateLimiter.mockResolvedValue(true);
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: "valid" } as any);
    mockFirestoreAdd.mockResolvedValue({ id: "new-event" } as any);
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

  it("creates events for valid downvotes and skips invalid/existing ones", async () => {
    // First call: the answers query. Subsequent calls: per-answer existing-event checks.
    mockFirestoreQueryGet
      .mockResolvedValueOnce({
        docs: [
          { id: "a1", data: () => ({}) }, // no reason -> skipped
          { id: "a2", data: () => ({ feedbackReason: "Incorrect Information", question: "q", answer: "a" }) }, // created
          { id: "a3", data: () => ({ feedbackReason: "Incorrect Information" }) }, // existing -> skipped
        ],
      } as any)
      .mockResolvedValueOnce({ empty: true } as any) // a2 has no existing event
      .mockResolvedValueOnce({ empty: false } as any); // a3 already has an event

    const { req, res } = post({ upgradeWithLlm: false });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toMatchObject({ ok: true, created: 1, skipped: 2, upgradedWithLlm: false });
    expect(mockFirestoreAdd).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the query fails", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("boom"));
    const { req, res } = post();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
