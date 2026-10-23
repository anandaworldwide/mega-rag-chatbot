/**
 * Clone fails when Pages cookie.parse keeps a parent-domain uuid/authToken.
 * The proxy referer check only logs. It does not block this POST.
 */

process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

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

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/clone-conversation";
import { createSignedUUIDCookie } from "@/utils/server/uuidUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

const mockFirebase = jest.requireMock("@/services/firebase");
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;

const PARENT_UUID = "11111111-1111-4111-8111-111111111111";
const HOST_UUID = "22222222-2222-4222-8222-222222222222";

function thirdPartyCookies(count: number): string {
  return Array.from({ length: count }, (_, index) => `_ga_extra_${index}=val${index}`).join("; ");
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

describe("clone-conversation parent-domain cookies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin: false } as ReturnType<typeof loadSiteConfigSync>);
    mockFirebase.db = {
      collection: jest.fn(),
      batch: jest.fn(),
    };
  });

  it("clones on Vivek when cookie.parse kept the parent uuid and authToken", async () => {
    const signedHost = createSignedUUIDCookie(HOST_UUID);
    const cookieHeader = [
      thirdPartyCookies(31),
      `uuid=${PARENT_UUID}`,
      "authToken=parent-junk",
      `uuid=${signedHost}`,
      "authToken=host-not-a-jwt",
    ].join("; ");

    const { req, res } = createMocks({
      method: "POST",
      headers: {
        cookie: cookieHeader,
        origin: "https://vivek.ananda.org",
        "content-type": "application/json",
      },
      cookies: {
        uuid: PARENT_UUID,
        authToken: "parent-junk",
      },
      body: { docId: "test-doc-id" },
    });

    const mockBatch = mockCloneFirestore();

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(200);
    const payload = res._getJSONData();
    expect(payload.success).toBe(true);
    expect(payload.messageCount).toBe(1);
    expect(mockBatch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uuid: HOST_UUID })
    );
  });

  it("clones on Vivek when only a parent-domain authToken is present", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        cookie: `${thirdPartyCookies(33)}; authToken=parent-junk`,
        origin: "https://vivek.ananda.org",
        "content-type": "application/json",
      },
      cookies: { authToken: "parent-junk" },
      body: { docId: "test-doc-id" },
    });

    const mockBatch = mockCloneFirestore();

    await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().success).toBe(true);
    expect(mockBatch.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
    );
  });
});
