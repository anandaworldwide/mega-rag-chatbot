/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/document/[docId]";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
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
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockGetSecureUUID = getSecureUUID as jest.MockedFunction<typeof getSecureUUID>;
const mockDb = db as any;

const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "doc-owner-1";

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

describe("/api/document/[docId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimiter.mockResolvedValue(true);
    mockOwnerSession();
    mockDocument({
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
    });
  });

  it("rejects non-GET methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { docId: DOC_ID },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("refuses anonymous callers without an authorization header", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ message: "Authorization header required" });
    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  it("refuses callers with an invalid token", async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error("Invalid or expired token");
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer bad-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ message: "Invalid or expired token" });
    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  it("returns the document for the logged-in owner and omits uuid and history", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { docId: DOC_ID },
      headers: { authorization: "Bearer valid-token" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.id).toBe(DOC_ID);
    expect(data.convId).toBe("c1");
    expect(data.question).toBe("Q1");
    expect(data).not.toHaveProperty("uuid");
    expect(data).not.toHaveProperty("history");
  });

  it("returns 404 when the session uuid does not match the document", async () => {
    mockDocument({
      uuid: OTHER_UUID,
      convId: "c-other",
      question: "Other question",
      answer: "Other answer",
      history: [{ role: "user", content: "other" }],
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
