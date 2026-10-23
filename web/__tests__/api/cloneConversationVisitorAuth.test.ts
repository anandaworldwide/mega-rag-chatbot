/**
 * Production clone failures (2026-10-23):
 * - Vivek Incognito / new visitor: POST /api/clone-conversation with no uuid
 *   cookie returns 400 { error: "UUID not found in cookies" } from getSecureUUID.
 * - Luca: POST is not in publicPaths, so proxy returns 401
 *   { message: "Authentication required (Web Middleware)" } even when fetchWithAuth
 *   sends a signed-in Bearer JWT. The handler never runs.
 */

/** @jest-environment node */

process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";
process.env.SECURE_TOKEN = process.env.SECURE_TOKEN || "clone-visitor-test-secret";

jest.unmock("next/server");

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
    batch: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_answers"),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/firestoreIndexErrorHandler", () => ({
  createIndexErrorResponse: jest.fn().mockReturnValue({ type: "generic_error" }),
}));

jest.mock("@/utils/server/libraryAccessMiddlewareGate", () => ({
  applyComputedLibraryAccessOverrides: jest.fn(() => []),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  createErrorCorsHeaders: jest.fn(() => ({})),
  handleCors: jest.fn(() => null),
  addCorsHeaders: jest.fn((response: Response) => response),
}));

import { NextApiRequest, NextApiResponse } from "next";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { isPublicPath } from "@/config/publicPaths";
import { middleware } from "../../src/proxy";
import handler from "@/pages/api/clone-conversation";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { JWT_SIGN_OPTIONS } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";

const mockFirebase = jest.requireMock("@/services/firebase");
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

const SIGNED_IN_UUID = "22222222-2222-4222-8222-222222222222";

function signUserJwt(payload: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      client: "web",
      email: "user@ananda.org",
      uuid: SIGNED_IN_UUID,
      ...payload,
    },
    process.env.SECURE_TOKEN as string,
    { ...JWT_SIGN_OPTIONS, expiresIn: "15m" }
  );
}

function mockCloneFirestore() {
  const mockTimestamp = { toDate: () => new Date("2024-01-01") };
  const mockSourceData = {
    convId: "original-conv-id",
    question: "Test question",
    answer: "Test answer",
    uuid: "original-uuid",
    timestamp: mockTimestamp,
  };
  const mockBatch = {
    set: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  };
  const mockQueryGet = jest.fn().mockResolvedValue({
    empty: false,
    docs: [{ id: "msg-1", data: () => mockSourceData }],
  });
  const mockOrderBy = jest.fn().mockReturnValue({ get: mockQueryGet });
  const mockWhereTimestamp = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockWhereConvId = jest.fn().mockReturnValue({ where: mockWhereTimestamp });
  const mockGet = jest.fn().mockResolvedValue({
    exists: true,
    data: () => mockSourceData,
  });
  const mockDoc = jest.fn((id?: string) => {
    if (id) {
      return { get: mockGet };
    }
    return { id: "new-doc-1" };
  });
  const mockCollection = jest.fn().mockReturnValue({
    doc: mockDoc,
    where: mockWhereConvId,
  });
  mockFirebase.db = {
    collection: mockCollection,
    batch: jest.fn(() => mockBatch),
  };
  return mockBatch;
}

function jsonRes() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    req: { method: "POST", body: { docId: "share-doc" }, headers: {}, cookies: {} } as Partial<NextApiRequest>,
    res: { status, json } as Partial<NextApiResponse>,
    json,
    status,
  };
}

describe("clone-conversation visitor and signed-in gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFirebase.db = { collection: jest.fn(), batch: jest.fn() };
  });

  it("lists /api/clone-conversation as a public API so Luca proxy does not 401 a Bearer JWT", () => {
    expect(isPublicPath("/api/clone-conversation")).toBe(true);
  });

  it("Luca proxy lets a signed-in share-page POST through when only Authorization Bearer is present", () => {
    mockLoadSiteConfigSync.mockReturnValue({
      siteId: "ananda",
      requireLogin: true,
      allowedFrontEndDomains: ["luca.ananda.org"],
    } as ReturnType<typeof loadSiteConfigSync>);

    const token = signUserJwt();
    const response = middleware(
      new NextRequest("https://luca.ananda.org/api/clone-conversation", {
        method: "POST",
        headers: {
          origin: "https://luca.ananda.org",
          referer: "https://luca.ananda.org/share/abc",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      })
    );

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("getSecureUUID returns 400 UUID not found in cookies for a Vivek new visitor", () => {
    mockLoadSiteConfigSync.mockReturnValue({
      siteId: "ananda-public",
      requireLogin: false,
    } as ReturnType<typeof loadSiteConfigSync>);

    const result = getSecureUUID({ cookies: {}, headers: {} } as NextApiRequest);

    expect(result).toEqual({
      success: false,
      error: "UUID not found in cookies",
      statusCode: 400,
    });
  });

  it("Vivek clone mints a visitor uuid when the share page sent no uuid cookie", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      siteId: "ananda-public",
      requireLogin: false,
    } as ReturnType<typeof loadSiteConfigSync>);
    const batch = mockCloneFirestore();
    const { req, res, status, json } = jsonRes();

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        messageCount: 1,
      })
    );
    expect(batch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      })
    );
  });

  it("Luca clone accepts a signed-in authToken cookie when Bearer is missing", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      siteId: "ananda",
      requireLogin: true,
    } as ReturnType<typeof loadSiteConfigSync>);
    mockCloneFirestore();
    const token = signUserJwt();
    const { req, res, status, json } = jsonRes();
    req.cookies = { authToken: token };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        messageCount: 1,
      })
    );
  });
});
