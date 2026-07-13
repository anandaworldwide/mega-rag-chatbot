/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/vote-stats";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";

jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h: any) => h }));
jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h: any) => h }));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/sudoCookieUtils");
jest.mock("@/utils/server/authz", () => ({ requireSuperuserRoleFromFirestore: jest.fn() }));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("prod_chatLogs"),
  getDownvoteFeedbackEventsCollectionName: jest.fn().mockReturnValue("prod_downvote_feedback_events"),
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
const mockRequireSuperuser = requireSuperuserRoleFromFirestore as jest.MockedFunction<typeof requireSuperuserRoleFromFirestore>;
const { db } = jest.requireMock("@/services/firebase");

function snapshotOf(records: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: records.map((r) => ({
      id: r.id,
      data: () => r.data,
    })),
  } as any;
}

describe("/api/admin/vote-stats", () => {
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

  it("returns 403 when sudo access is missing on no-login sites", async () => {
    mockGetSudoCookie.mockReturnValue({ sudoCookieValue: null } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("requires superuser on login sites", async () => {
    mockLoadSiteConfig.mockReturnValue({ requireLogin: true, siteId: "ananda" } as any);
    mockRequireSuperuser.mockRejectedValue(new Error("forbidden"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(mockRequireSuperuser).toHaveBeenCalled();
  });

  it("aggregates answers and downvote events for the selected lookback", async () => {
    mockFirestoreQueryGet
      .mockResolvedValueOnce(
        snapshotOf([
          {
            id: "a1",
            data: {
              question: "What is kriya?",
              vote: 1,
              model: "gpt-4o",
              abTestModel: "gpt-4o",
              timestamp: "2026-07-12T00:00:00.000Z",
            },
          },
          {
            id: "a2",
            data: {
              question: "Where is Ananda Village?",
              vote: -1,
              model: "gpt-4.1-mini",
              abTestModel: "claude-fable-5",
              isLocationQuery: true,
              feedbackReason: "Incorrect Information",
              timestamp: "2026-07-11T00:00:00.000Z",
            },
          },
        ])
      )
      .mockResolvedValueOnce(
        snapshotOf([
          {
            id: "e1",
            data: {
              answerDocId: "old-doc",
              question: "Older downvote",
              feedbackReason: "Off-Topic Response",
              createdAt: "2026-07-12T12:00:00.000Z",
              triageCategory: "unclear",
            },
          },
        ])
      );

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { days: "30" },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.lookbackDays).toBe(30);
    expect(data.siteId).toBe("ananda");
    expect(data.summary.answersInWindow).toBe(2);
    expect(data.summary.upvotes).toBe(1);
    expect(data.summary.downvotes).toBe(1);
    expect(data.summary.comparableVotes).toBe(1);
    expect(data.summary.downvoteEventsInWindow).toBe(1);
    expect(data.recentVotes).toHaveLength(2);
    expect(data.recentDownvoteEvents[0].id).toBe("e1");
  });
});
