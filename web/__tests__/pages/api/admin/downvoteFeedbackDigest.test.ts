/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/downvoteFeedbackDigest";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";

jest.mock("@/utils/server/cronAuthUtils", () => ({ withJwtOrCronAuth: (h: any) => h }));
jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h: any) => h }));
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/emailOps", () => ({ sendOpsAlert: jest.fn() }));
jest.mock("@/utils/server/notionTaskClient", () => ({
  NotionTaskClient: jest.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
jest.mock("@/utils/server/downvoteFeedbackTriageService", () => ({
  DownvoteFeedbackTriageService: jest.fn().mockImplementation(() => ({
    enrichRecentHeuristicEvents: jest.fn().mockResolvedValue(0),
  })),
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
  firestore: Object.assign(() => ({}), { Timestamp: { fromDate: jest.fn((d: Date) => ({ d })) } }),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockSendOpsAlert = sendOpsAlert as jest.MockedFunction<typeof sendOpsAlert>;
const { db } = jest.requireMock("@/services/firebase");

describe("/api/admin/downvoteFeedbackDigest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockSendOpsAlert.mockResolvedValue(undefined as any);
    db.collection = jest.fn(() => ({ where: jest.fn().mockReturnThis(), doc: jest.fn((id: string) => ({ id })) }));
  });

  it("rejects unsupported methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "PUT" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns an empty digest when there are no recent events", async () => {
    mockFirestoreQueryGet.mockResolvedValue({ docs: [] } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ ok: true, totalEvents: 0 });
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });

  it("builds clusters and sends an ops alert when events exist", async () => {
    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "e1",
          data: () => ({
            taskCandidateKey: "incorrect_information",
            triageCategory: "retrieval_bug",
            feedbackReason: "Incorrect Information",
            question: "Why is this wrong?",
            feedbackComment: "It is inaccurate",
            triageConfidence: 0.8,
            identityMode: "anonymous",
            createdAt: "2024-01-01T00:00:00.000Z",
            recommendedAction: "Review retrieval",
          }),
        },
      ],
    } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: { createTasks: "false" } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.totalEvents).toBe(1);
    expect(data.clusters).toHaveLength(1);
    expect(mockSendOpsAlert).toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("boom"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
