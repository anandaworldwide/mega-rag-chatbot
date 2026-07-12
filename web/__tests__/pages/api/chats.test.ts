/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/chats";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/userActivityUtils");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockUpdateUserActivity = updateUserActivity as jest.MockedFunction<typeof updateUserActivity>;
const mockDb = db as any;

function makeChainableQuery() {
  const query: any = {};
  query.where = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.startAfter = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  return query;
}

describe("/api/chats", () => {
  let query: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockUpdateUserActivity.mockResolvedValue(undefined as any);
    query = makeChainableQuery();
    mockDb.collection = jest.fn(() => query);
    mockFirestoreQueryGet.mockResolvedValue({
      docs: [
        {
          id: "doc-1",
          data: () => ({
            question: "Q1",
            answer: "A1",
            timestamp: { seconds: 1 },
            convId: "c1",
            model: "gpt-4o",
          }),
        },
      ],
    } as any);
  });

  it("rejects non-GET methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "POST" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns early when rate limited", async () => {
    mockRateLimiter.mockResolvedValue(false);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: { uuid: "u1" } });
    await handler(req, res);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("requires uuid when convId is absent", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns mapped chats for a valid uuid query and tracks activity", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: { uuid: "u1" } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("doc-1");
    expect(data[0].model).toBe("gpt-4o");
    expect(query.where).toHaveBeenCalledWith("uuid", "==", "u1");
    expect(mockUpdateUserActivity).toHaveBeenCalledWith("u1", "chats-api");
  });

  it("supports convId-only legacy queries and starred + pagination params", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { convId: "c1", starred: "true", startAfter: "2024-01-01T00:00:00.000Z", limit: "5" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(query.where).toHaveBeenCalledWith("convId", "==", "c1");
    expect(query.where).toHaveBeenCalledWith("isStarred", "==", true);
    expect(query.startAfter).toHaveBeenCalled();
    expect(query.limit).toHaveBeenCalledWith(5);
  });

  it("returns 500 with an index error response when firestore query fails", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("index needed"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET", query: { uuid: "u1" } });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
