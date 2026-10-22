/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/chats";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import { verifyToken } from "@/utils/server/jwtUtils";
import { createSignedUUIDCookie } from "@/utils/server/uuidUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/userActivityUtils");
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockUpdateUserActivity = updateUserActivity as jest.MockedFunction<typeof updateUserActivity>;
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
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

function ownerChatDocs() {
  return {
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
  };
}

describe("/api/chats cookie path", () => {
  let query: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockUpdateUserActivity.mockResolvedValue(undefined as any);
    query = makeChainableQuery();
    mockDb.collection = jest.fn(() => query);
    mockFirestoreQueryGet.mockResolvedValue(ownerChatDocs() as any);
    mockVerifyToken.mockReturnValue({
      client: "web",
      iat: 1,
      exp: 2,
    });
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
      siteId: "ananda-public",
    } as any);
  });

  it("returns 401 for an unsigned uuid cookie on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: OWNER_UUID },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("returns 401 for a uuid cookie with a bad signature on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: `${OWNER_UUID}--${"a".repeat(64)}` },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockFirestoreQueryGet).not.toHaveBeenCalled();
  });

  it("returns an empty list for a signed cookie that is not the owner on a no-login site", async () => {
    mockFirestoreQueryGet.mockResolvedValue({ docs: [] } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: createSignedUUIDCookie(OTHER_UUID) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual([]);
    expect(query.where).toHaveBeenCalledWith("uuid", "==", OTHER_UUID);
    expect(query.where).not.toHaveBeenCalledWith("uuid", "==", OWNER_UUID);
  });

  it("returns chats for a signed owner cookie on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: createSignedUUIDCookie(OWNER_UUID) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("doc-1");
    expect(query.where).toHaveBeenCalledWith("uuid", "==", OWNER_UUID);
    expect(mockUpdateUserActivity).toHaveBeenCalledWith(OWNER_UUID, "chats-api");
  });

  it("returns an empty list when the JWT uuid is not the owner on a login site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
      siteId: "ananda",
    } as any);
    mockVerifyToken.mockReturnValue({
      client: "web",
      email: "other@example.com",
      role: "user",
      uuid: OTHER_UUID,
      iat: 1,
      exp: 2,
    });
    mockFirestoreQueryGet.mockResolvedValue({ docs: [] } as any);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual([]);
    expect(query.where).toHaveBeenCalledWith("uuid", "==", OTHER_UUID);
    expect(query.where).not.toHaveBeenCalledWith("uuid", "==", OWNER_UUID);
  });
});
