/**
 * Authorization tests for GET /api/answers.
 * Anonymous callers are allowed on no-login sites.
 * Anonymous and non-admin callers are refused on login-required sites.
 */

global.Request = class MockRequest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    return {} as any;
  }
} as any;

jest.mock("next/server", () => ({
  NextRequest: jest.fn().mockImplementation(() => ({
    url: "[REDACTED]",
    method: "GET",
    headers: new Headers(),
    ip: "127.0.0.1",
    json: jest.fn(),
    nextUrl: new URL("[REDACTED]"),
  })),
  NextResponse: {
    json: jest.fn().mockImplementation((body, init) => ({
      status: init?.status || 200,
      body,
      headers: new Headers(init?.headers),
    })),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/services/firebase", () => {
  return {
    db: {
      collection: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(),
      delete: jest.fn(),
      stream: jest.fn(),
    },
  };
});

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("answers"),
}));

jest.mock("@/utils/server/answersUtils", () => ({
  getTotalDocuments: jest.fn(),
  getAnswersByIds: jest.fn(),
  searchAnswersByQuestion: jest.fn(),
  mapAnswerDocToAnswer: jest.fn(),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/authz", () => ({
  getRequesterRole: jest.fn(),
  requireAdminRole: jest.fn(),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: (handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>) => handler,
}));

jest.mock("@/utils/server/jwtUtils", () => {
  return {
    withJwtAuth: jest.fn().mockImplementation((handler) => {
      return handler;
    }),
  };
});

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/answers";

const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;
const mockGetTotalDocuments = jest.requireMock("@/utils/server/answersUtils").getTotalDocuments;
const mockGetAnswersByIds = jest.requireMock("@/utils/server/answersUtils").getAnswersByIds;
const mockMapAnswerDocToAnswer = jest.requireMock("@/utils/server/answersUtils").mapAnswerDocToAnswer;
const mockLoadSiteConfigSync = jest.requireMock("@/utils/server/loadSiteConfig").loadSiteConfigSync;
const mockGetRequesterRole = jest.requireMock("@/utils/server/authz").getRequesterRole;
const mockDb = jest.requireMock("@/services/firebase").db;

const VISITOR_FIELDS = {
  ip: "203.0.113.10",
  uuid: "secret-visitor-uuid",
  history: [{ role: "user", content: "prior turn" }],
};

function mapAnswerWithOption(
  doc: { id: string; data: () => Record<string, unknown> },
  options: { includeVisitorFields?: boolean } = {}
) {
  const data = doc.data();
  const mapped: Record<string, unknown> = {
    id: doc.id,
    question: data.question,
    answer: data.answer,
  };
  if (options.includeVisitorFields) {
    mapped.ip = data.ip;
    mapped.uuid = data.uuid;
    mapped.history = data.history;
  }
  return mapped;
}

function answersByIdsWithOption(
  ids: string[],
  options: { includeVisitorFields?: boolean } = {}
) {
  const mapped: Record<string, unknown> = {
    id: ids[0],
    question: "Test question",
    answer: "Test answer",
  };
  if (options.includeVisitorFields) {
    Object.assign(mapped, VISITOR_FIELDS);
  }
  return [mapped];
}

describe("Answers API authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "",
      message: "No sudo cookie",
    });
    mockGetRequesterRole.mockReturnValue("user");
  });

  it("allows anonymous callers on no-login sites", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });

    const mockSnapshot = {
      docs: [
        {
          id: "answer1",
          data: () => ({
            question: "Test question",
            answer: "Test answer",
            timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
            sources: "[]",
            ip: "203.0.113.10",
            uuid: "secret-visitor-uuid",
            history: [{ role: "user", content: "prior turn" }],
          }),
        },
      ],
    };

    mockDb.get.mockResolvedValueOnce(mockSnapshot);
    mockGetTotalDocuments.mockResolvedValueOnce(1);
    mockMapAnswerDocToAnswer.mockImplementation(mapAnswerWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        page: "1",
        limit: "10",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetTotalDocuments).toHaveBeenCalled();
    expect(mockMapAnswerDocToAnswer).toHaveBeenCalledWith(expect.anything(), { includeVisitorFields: false });
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toMatch(/secret-visitor-uuid/);
    expect(JSON.stringify(body)).not.toMatch(/203\.0\.113\.10/);
    expect(JSON.stringify(body)).not.toMatch(/"history"/);
  });

  it("omits visitor fields for an anonymous caller on a no-login site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "public-answer",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["public-answer"], { includeVisitorFields: false });
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toMatch(/secret-visitor-uuid/);
    expect(JSON.stringify(body)).not.toMatch(/203\.0\.113\.10/);
    expect(JSON.stringify(body)).not.toMatch(/"history"/);
  });

  it("refuses anonymous callers on login-required sites", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    });
    mockGetRequesterRole.mockReturnValue("user");

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        page: "1",
        limit: "10",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: "Access denied. You don't have permission to access this resource.",
    });
    expect(mockGetTotalDocuments).not.toHaveBeenCalled();
  });

  it("refuses a signed-in user who is not an admin", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    });
    mockGetRequesterRole.mockReturnValue("user");

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "other-visitor-answer",
      },
      headers: {
        "x-test-role": "user",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: "Access denied. You don't have permission to access this resource.",
    });
    expect(mockGetAnswersByIds).not.toHaveBeenCalled();
  });

  it("allows an anonymous caller to request an answer by id on a no-login site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "other-visitor-answer",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["other-visitor-answer"], { includeVisitorFields: false });
    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toMatch(/"ip"/);
    expect(JSON.stringify(body)).not.toMatch(/"uuid"/);
    expect(JSON.stringify(body)).not.toMatch(/"history"/);
  });

  it("allows an admin on a login-required site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    });
    mockGetRequesterRole.mockReturnValue("admin");
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "answer1",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["answer1"], { includeVisitorFields: true });
    expect(res._getJSONData()[0]).toMatchObject(VISITOR_FIELDS);
  });

  it("returns visitor fields for an admin on a login-required site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    });
    mockGetRequesterRole.mockReturnValue("admin");
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "admin-answer",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["admin-answer"], { includeVisitorFields: true });
    expect(res._getJSONData()[0]).toEqual({
      id: "admin-answer",
      question: "Test question",
      answer: "Test answer",
      ...VISITOR_FIELDS,
    });
  });

  it("allows a sudo caller on a no-login site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "valid-sudo-cookie",
      message: "",
    });

    const mockSnapshot = {
      docs: [
        {
          id: "answer1",
          data: () => ({
            question: "Test question",
            answer: "Test answer",
            timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
            sources: "[]",
            ...VISITOR_FIELDS,
          }),
        },
      ],
    };

    mockDb.get.mockResolvedValueOnce(mockSnapshot);
    mockGetTotalDocuments.mockResolvedValueOnce(1);
    mockMapAnswerDocToAnswer.mockImplementation(mapAnswerWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        page: "1",
        limit: "5",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetTotalDocuments).toHaveBeenCalled();
    expect(mockMapAnswerDocToAnswer).toHaveBeenCalledWith(expect.anything(), { includeVisitorFields: true });
    expect(res._getJSONData().answers[0]).toMatchObject(VISITOR_FIELDS);
  });

  it("returns visitor fields for a sudo caller on a no-login site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "valid-sudo-cookie",
      message: "",
    });
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "sudo-answer",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["sudo-answer"], { includeVisitorFields: true });
    expect(res._getJSONData()[0]).toEqual({
      id: "sudo-answer",
      question: "Test question",
      answer: "Test answer",
      ...VISITOR_FIELDS,
    });
  });
});
