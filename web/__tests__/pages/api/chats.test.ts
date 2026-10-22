/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/chats";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/userActivityUtils");
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));
jest.mock("@/utils/server/uuidUtils", () => ({
  getSecureUUID: jest.fn(),
}));
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockUpdateUserActivity = updateUserActivity as jest.MockedFunction<typeof updateUserActivity>;
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockGetSecureUUID = getSecureUUID as jest.MockedFunction<typeof getSecureUUID>;
const mockDb = db as any;

const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

function makeChainableQuery() {
  const query: any = {};
  query.where = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.startAfter = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  return query;
}

function mockOwnerSession() {
  mockVerifyToken.mockReturnValue({
    client: "web",
    email: "owner@example.com",
    role: "user",
    uuid: OWNER_UUID,
    iat: 1,
    exp: 2,
  });
  mockGetSecureUUID.mockReturnValue({
    success: true,
    uuid: OWNER_UUID,
  });
}

describe("/api/chats", () => {
  let query: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockUpdateUserActivity.mockResolvedValue(undefined as any);
    mockOwnerSession();
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
            uuid: OWNER_UUID,
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
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers without an authorization header", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { uuid: OTHER_UUID },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ error: "Authorization header required" });
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers who send only convId", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { convId: "c1" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("refuses callers with an invalid token", async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error("Invalid or expired token");
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { uuid: OWNER_UUID },
      headers: { authorization: "Bearer bad-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ error: "Invalid or expired token" });
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("refuses callers without a signed session uuid", async () => {
    mockGetSecureUUID.mockReturnValue({
      success: false,
      error: "UUID not found in cookies",
      statusCode: 400,
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { uuid: OTHER_UUID },
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("returns the logged-in owner chats and ignores a different query uuid", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { uuid: OTHER_UUID },
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("doc-1");
    expect(data[0].model).toBe("gpt-4o");
    expect(query.where).toHaveBeenCalledWith("uuid", "==", OWNER_UUID);
    expect(query.where).not.toHaveBeenCalledWith("uuid", "==", OTHER_UUID);
    expect(mockUpdateUserActivity).toHaveBeenCalledWith(OWNER_UUID, "chats-api");
  });

  it("binds convId queries to the session uuid", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { convId: "c1", starred: "true", startAfter: "2024-01-01T00:00:00.000Z", limit: "5" },
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(query.where).toHaveBeenCalledWith("uuid", "==", OWNER_UUID);
    expect(query.where).toHaveBeenCalledWith("convId", "==", "c1");
    expect(query.where).toHaveBeenCalledWith("isStarred", "==", true);
    expect(query.startAfter).toHaveBeenCalled();
    expect(query.limit).toHaveBeenCalledWith(5);
  });

  it("returns 500 with an index error response when firestore query fails", async () => {
    mockFirestoreQueryGet.mockRejectedValue(new Error("index needed"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});
