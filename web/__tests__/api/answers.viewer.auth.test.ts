/**
 * Viewer password and read-only checks for /api/answers on login and no-login sites.
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

const mockCookieGet = jest.fn();
const mockCookieSet = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    get: mockCookieGet,
    set: mockCookieSet,
  }));
});

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

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
import answersHandler from "@/pages/api/answers";
import viewerHandler from "@/pages/api/answers/viewer";
import {
  ANSWERS_VIEWER_COOKIE_MAX_AGE_MS,
  ANSWERS_VIEWER_COOKIE_NAME,
  createAnswersViewerCookieValue,
} from "@/utils/server/answersViewerAuth";

const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;
const mockGetAnswersByIds = jest.requireMock("@/utils/server/answersUtils").getAnswersByIds;
const mockLoadSiteConfigSync = jest.requireMock("@/utils/server/loadSiteConfig").loadSiteConfigSync;
const mockGetRequesterRole = jest.requireMock("@/utils/server/authz").getRequesterRole;
const mockRequireAdminRole = jest.requireMock("@/utils/server/authz").requireAdminRole;
const mockDb = jest.requireMock("@/services/firebase").db;

const VIEWER_PASSWORD = "viewer-secret-never-log-xyz";
const SITE_TYPES = [
  { name: "login-required", requireLogin: true },
  { name: "no-login", requireLogin: false },
] as const;

const VISITOR_FIELDS = {
  ip: "203.0.113.10",
  uuid: "secret-visitor-uuid",
  history: [{ role: "user", content: "prior turn" }],
};

function answersByIdsWithOption(ids: string[], options: { includeVisitorFields?: boolean } = {}) {
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

function expectLogsNeverContainPassword(...spies: Array<jest.SpyInstance>) {
  for (const spy of spies) {
    for (const args of spy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain(VIEWER_PASSWORD);
    }
  }
}

describe.each(SITE_TYPES)("answers viewer access ($name)", ({ requireLogin }) => {
  const originalPassword = process.env.ANSWERS_VIEWER_PASSWORD;
  let logSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANSWERS_VIEWER_PASSWORD = VIEWER_PASSWORD;
    mockCookieGet.mockReturnValue(undefined);
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "",
      message: "No sudo cookie",
    });
    mockGetRequesterRole.mockReturnValue("user");
    mockRequireAdminRole.mockReturnValue(false);
    mockLoadSiteConfigSync.mockReturnValue({ requireLogin });
    mockGetAnswersByIds.mockImplementation(answersByIdsWithOption);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    if (originalPassword === undefined) {
      delete process.env.ANSWERS_VIEWER_PASSWORD;
    } else {
      process.env.ANSWERS_VIEWER_PASSWORD = originalPassword;
    }
  });

  it("blocks GET /api/answers when no viewer cookie is present", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { answerIds: "blocked-answer" },
    });

    await answersHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockGetAnswersByIds).not.toHaveBeenCalled();
  });

  it("lets a viewer read answers without visitor fields", async () => {
    mockCookieGet.mockReturnValue(createAnswersViewerCookieValue());

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { answerIds: "viewer-answer" },
    });

    await answersHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["viewer-answer"], { includeVisitorFields: false });
    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toMatch(/secret-visitor-uuid/);
    expect(body).not.toMatch(/203\.0\.113\.10/);
    expect(body).not.toMatch(/"history"/);
  });

  it("returns visitor fields to a privileged caller", async () => {
    if (requireLogin) {
      mockGetRequesterRole.mockReturnValue("admin");
    } else {
      mockGetSudoCookie.mockReturnValue({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });
    }

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { answerIds: "privileged-answer" },
    });

    await answersHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetAnswersByIds).toHaveBeenCalledWith(["privileged-answer"], { includeVisitorFields: true });
    expect(res._getJSONData()[0]).toMatchObject(VISITOR_FIELDS);
  });

  it("refuses a wrong viewer password and does not set a cookie", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { password: "wrong-viewer-password" },
    });

    await viewerHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(mockCookieSet).not.toHaveBeenCalled();
    expectLogsNeverContainPassword(logSpy, infoSpy, warnSpy, errorSpy, debugSpy);
  });

  it("disables viewer access when the env password is unset", async () => {
    delete process.env.ANSWERS_VIEWER_PASSWORD;

    const post = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { password: VIEWER_PASSWORD },
    });
    await viewerHandler(post.req, post.res);
    expect(post.res.statusCode).toBe(403);
    expect(mockCookieSet).not.toHaveBeenCalled();

    mockCookieGet.mockReturnValue("stale-cookie");
    const get = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { answerIds: "disabled-answer" },
    });
    await answersHandler(get.req, get.res);
    expect(get.res.statusCode).toBe(403);
    expect(mockGetAnswersByIds).not.toHaveBeenCalled();
  });

  it("sets an httpOnly Secure SameSite cookie with an expiry after a correct password", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
      body: { password: VIEWER_PASSWORD },
    });

    await viewerHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockCookieSet).toHaveBeenCalledWith(
      ANSWERS_VIEWER_COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        expires: expect.any(Date),
        maxAge: ANSWERS_VIEWER_COOKIE_MAX_AGE_MS,
      })
    );
    expectLogsNeverContainPassword(logSpy, infoSpy, warnSpy, errorSpy, debugSpy);
  });

  it("rejects a password in the URL query string even when the body is correct", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { password: VIEWER_PASSWORD },
      body: { password: VIEWER_PASSWORD },
    });

    await viewerHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Password must be sent in the request body",
    });
    expect(mockCookieSet).not.toHaveBeenCalled();
    expectLogsNeverContainPassword(logSpy, infoSpy, warnSpy, errorSpy, debugSpy);
  });

  it("never logs the password on a query-only attempt", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { password: VIEWER_PASSWORD },
    });

    await viewerHandler(req, res);

    expect(res.statusCode).toBe(400);
    expectLogsNeverContainPassword(logSpy, infoSpy, warnSpy, errorSpy, debugSpy);
  });

  it("refuses DELETE for a viewer", async () => {
    mockCookieGet.mockReturnValue(createAnswersViewerCookieValue());

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "DELETE",
      query: { answerId: "viewer-cannot-delete" },
    });

    await answersHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("refuses POST and PUT writes for a viewer", async () => {
    mockCookieGet.mockReturnValue(createAnswersViewerCookieValue());

    for (const method of ["POST", "PUT"] as const) {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method,
        query: { answerId: "viewer-cannot-write" },
      });

      await answersHandler(req, res);

      expect(res.statusCode).toBe(405);
      expect(mockDb.delete).not.toHaveBeenCalled();
    }
  });
});
