/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/document/[docId]";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { createSignedUUIDCookie } from "@/utils/server/uuidUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn(),
}));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockDb = db as any;

const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "doc-owner-1";

function mockDocument(data: Record<string, unknown> | null, exists = true) {
  const get = jest.fn().mockResolvedValue({
    exists,
    id: DOC_ID,
    data: () => data,
  });
  mockDb.collection = jest.fn(() => ({
    doc: jest.fn(() => ({ get })),
  }));
  return get;
}

function ownerDocument() {
  return {
    uuid: OWNER_UUID,
    convId: "c1",
    timestamp: { seconds: 1 },
    question: "Q1",
    answer: "A1",
    title: "Owner chat",
    history: [{ role: "user", content: "secret" }],
    sources: null,
    collection: "whole_library",
    suggestions: [],
    model: "gpt-4o",
  };
}

describe("/api/document cookie path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockVerifyToken.mockReturnValue({
      client: "web",
      iat: 1,
      exp: 2,
    });
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
      siteId: "ananda-public",
    } as any);
    mockDocument(ownerDocument());
  });

  it("returns 401 for an unsigned uuid cookie on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: OWNER_UUID },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  it("returns 401 for a uuid cookie with a bad signature on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: `${OWNER_UUID}--${"a".repeat(64)}` },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  it("returns 404 for a signed cookie that is not the owner on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: createSignedUUIDCookie(OTHER_UUID) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({ message: "Document not found" });
  });

  it("returns the document for a signed owner cookie on a no-login site", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
      cookies: { uuid: createSignedUUIDCookie(OWNER_UUID) },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.id).toBe(DOC_ID);
    expect(data.convId).toBe("c1");
    expect(data).not.toHaveProperty("uuid");
    expect(data).not.toHaveProperty("history");
  });

  it("returns 404 when the JWT uuid is not the owner on a login site", async () => {
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

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({ message: "Document not found" });
  });
});
