/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/vote";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h: any) => h, getTokenFromRequest: jest.fn() }));
jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h: any) => h }));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/corsMiddleware", () => ({
  setCorsHeaders: jest.fn(),
  handleCorsOptions: jest.fn(),
}));
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("answers"),
  getDownvoteFeedbackEventsCollectionName: jest.fn().mockReturnValue("events"),
}));
jest.mock("@/utils/server/firestoreRetryUtils", () => ({ firestoreAdd: jest.fn(), firestoreUpdate: jest.fn() }));
jest.mock("@/utils/server/downvoteFeedbackTriageService", () => ({
  DownvoteFeedbackTriageService: jest.fn().mockImplementation(() => ({ enrichFeedbackEvent: jest.fn() })),
}));
jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(() => ({}), { FieldValue: { delete: jest.fn(), serverTimestamp: jest.fn() } }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;

function post(body: Record<string, unknown>) {
  return createMocks<NextApiRequest, NextApiResponse>({ method: "POST", body });
}

describe("/api/vote validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false } as any);
    mockRateLimiter.mockResolvedValue(true);
  });

  it("returns 500 when site config fails to load", async () => {
    mockLoadSiteConfig.mockReturnValue(null as any);
    const { req, res } = post({ docId: "x", vote: 1 });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "PUT" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns early when rate limited", async () => {
    mockRateLimiter.mockResolvedValue(false);
    const { req, res } = post({ docId: "x", vote: 1 });
    await handler(req, res);
    expect(res.statusCode).toBe(200); // default node-mocks status, handler returned without writing
  });

  it("rejects a missing document ID", async () => {
    const { req, res } = post({ vote: 1 });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid vote value", async () => {
    const { req, res } = post({ docId: "abcdefghij1234567890", vote: 5 });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid shareIdentity type", async () => {
    const { req, res } = post({ docId: "abcdefghij1234567890", vote: 1, shareIdentity: "yes" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid downvote feedback reason", async () => {
    const { req, res } = post({ docId: "abcdefghij1234567890", vote: -1, reason: "not_a_reason" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an over-long downvote comment", async () => {
    const { req, res } = post({
      docId: "abcdefghij1234567890",
      vote: -1,
      reason: "Incorrect Information",
      comment: "x".repeat(1001),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});
