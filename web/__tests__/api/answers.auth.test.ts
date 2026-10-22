/**
 * Authorization tests for GET /api/answers.
 * Uses the real answers page gate so anonymous and non-admin callers are refused.
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
const mockLoadSiteConfigSync = jest.requireMock("@/utils/server/loadSiteConfig").loadSiteConfigSync;
const mockGetRequesterRole = jest.requireMock("@/utils/server/authz").getRequesterRole;
const mockDb = jest.requireMock("@/services/firebase").db;

describe("Answers API authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "",
      message: "No sudo cookie",
    });
    mockGetRequesterRole.mockReturnValue("user");
  });

  it("refuses anonymous callers on no-login sites", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });

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
    expect(mockGetAnswersByIds).not.toHaveBeenCalled();
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

  it("refuses a non-sudo caller who requests another visitor answer by id", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
    });
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: false,
      message: "No sudo cookie",
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "other-visitor-answer",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockGetAnswersByIds).not.toHaveBeenCalled();
  });

  it("allows an admin on a login-required site", async () => {
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: true,
    });
    mockGetRequesterRole.mockReturnValue("admin");
    mockGetAnswersByIds.mockResolvedValueOnce([
      {
        id: "answer1",
        question: "Test question",
        answer: "Test answer",
      },
    ]);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: {
        answerIds: "answer1",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["answer1"]);
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
          }),
        },
      ],
    };

    mockDb.get.mockResolvedValueOnce(mockSnapshot);
    mockGetTotalDocuments.mockResolvedValueOnce(1);
    jest.requireMock("@/utils/server/answersUtils").mapAnswerDocToAnswer.mockImplementation(
      (doc: { id: string; data: () => Record<string, unknown> }) => ({
        id: doc.id,
        question: doc.data().question,
        answer: doc.data().answer,
      })
    );

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
  });
});
