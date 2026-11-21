/** @jest-environment node */
/**
 * Adversarial safe-failure tests for shared Pages Router API routes.
 * Hostile input must return 4xx with no stack trace. External services are mocked.
 */

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
        set: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      })),
      add: jest.fn().mockResolvedValue({ id: "mock-id" }),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    })),
    runTransaction: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  __esModule: true,
  default: jest.fn(),
  runMiddleware: jest.fn().mockResolvedValue(undefined),
  setCorsHeaders: jest.fn(),
  handleCorsOptions: jest.fn(),
  handleCors: jest.fn().mockReturnValue(null),
  addCorsHeaders: jest.fn((response) => response),
  createErrorCorsHeaders: jest.fn().mockReturnValue({}),
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/outbound", () => ({
  sendOutboundEmail: jest.fn().mockResolvedValue({ MessageId: "synthetic-message-id" }),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
  checkEmailBlacklist: jest.fn().mockResolvedValue({ blocked: false }),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
  firestoreSet: jest.fn().mockResolvedValue(undefined),
  firestoreAdd: jest.fn().mockResolvedValue({ id: "mock-id" }),
  firestoreUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/titleCatalog", () => ({
  suggestTitleScopes: jest.fn(async () => {
    throw new Error("Real network call attempted: title catalog");
  }),
}));

jest.mock("@/utils/server/emailTemplates", () => ({
  generateEmailContent: jest.fn().mockReturnValue({ text: "t", html: "<p>t</p>" }),
}));

jest.mock("bcryptjs", () => ({
  compare: jest.fn().mockResolvedValue(false),
}));

jest.mock("cookies", () =>
  jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    get: jest.fn(),
  }))
);

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import { JWT_SIGN_OPTIONS } from "@/utils/server/jwtUtils";
import voteHandler from "@/pages/api/vote";
import contactHandler from "@/pages/api/contact";
import loginHandler from "@/pages/api/login";
import loginWithPasswordHandler from "@/pages/api/auth/loginWithPassword";
import checkAuthMethodHandler from "@/pages/api/auth/checkAuthMethod";
import webTokenHandler from "@/pages/api/web-token";
import getTokenHandler from "@/pages/api/get-token";
import libraryStatsHandler from "@/pages/api/libraryStats";
import npsAvailableHandler from "@/pages/api/npsAvailable";
import titleScopeHandler from "@/pages/api/titleScope/suggest";
import profileHandler from "@/pages/api/profile";

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

const HUGE = "A".repeat(20000);
const INJECTION = "'; DROP TABLE users; -- <script>alert(1)</script> ${7*7}";
const UNICODE = "\u202E\u0000🔥\u0301";

function looksLikeStackTrace(text: string): boolean {
  return /\n\s+at\s+\S+/.test(text) || /\/src\/.+:\d+:\d+/.test(text);
}

function signWebToken(): string {
  return jwt.sign({ client: "web", iat: Math.floor(Date.now() / 1000) }, process.env.SECURE_TOKEN as string, {
    algorithm: JWT_SIGN_OPTIONS.algorithm as jwt.Algorithm,
    issuer: JWT_SIGN_OPTIONS.issuer,
    audience: JWT_SIGN_OPTIONS.audience,
    expiresIn: "15m",
  });
}

async function invoke(
  handler: Handler,
  options: Parameters<typeof createMocks>[0]
): Promise<{ status: number; bodyText: string; threw: boolean }> {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(options);
  let threw = false;
  try {
    await handler(req, res);
  } catch {
    threw = true;
  }
  let bodyText = "";
  try {
    bodyText = res._getData();
  } catch {
    bodyText = "";
  }
  return { status: res.statusCode, bodyText: String(bodyText), threw };
}

function assertSafeClientFailure(result: { status: number; bodyText: string; threw: boolean }): void {
  expect(result.threw).toBe(false);
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
  expect(looksLikeStackTrace(result.bodyText)).toBe(false);
}

describe("shared API routes adversarial safe failure", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SITE_ID = "ananda";
    process.env.SECURE_TOKEN = "test-adversarial-secure-token";
    process.env.SECURE_TOKEN_HASH = "hashed";
    process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";
    process.env.CONTACT_EMAIL = "ops@example.com";
    process.env.NEXT_PUBLIC_BASE_URL = "https://luca.example.test";
    global.fetch = jest.fn(async () => {
      throw new Error("Real network call attempted: fetch");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("wrong HTTP methods", () => {
    it.each([
      ["vote", voteHandler, "GET"],
      ["vote", voteHandler, "PUT"],
      ["vote", voteHandler, "DELETE"],
      ["contact", contactHandler, "GET"],
      ["contact", contactHandler, "PUT"],
      ["login", loginHandler, "GET"],
      ["login", loginHandler, "DELETE"],
      ["loginWithPassword", loginWithPasswordHandler, "GET"],
      ["checkAuthMethod", checkAuthMethodHandler, "GET"],
      ["web-token", webTokenHandler, "POST"],
      ["web-token", webTokenHandler, "PUT"],
      ["get-token", getTokenHandler, "GET"],
      ["get-token", getTokenHandler, "PUT"],
      ["libraryStats", libraryStatsHandler, "POST"],
      ["npsAvailable", npsAvailableHandler, "POST"],
      ["titleScope/suggest", titleScopeHandler, "POST"],
    ] as const)("%s rejects %s", async (_name, handler, method) => {
      const result = await invoke(handler, {
        method,
        headers: { authorization: `Bearer ${signWebToken()}` },
        body: {},
      });
      assertSafeClientFailure(result);
    });
  });

  describe("missing auth on protected routes", () => {
    it.each([
      ["vote", voteHandler, "POST"],
      ["contact", contactHandler, "POST"],
      ["libraryStats", libraryStatsHandler, "GET"],
      ["profile", profileHandler, "GET"],
    ] as const)("%s returns 4xx without Authorization", async (_name, handler, method) => {
      const result = await invoke(handler, { method, headers: {}, body: {} });
      assertSafeClientFailure(result);
      expect(result.status).toBe(401);
    });

    it.each([
      ["vote", voteHandler, "POST"],
      ["contact", contactHandler, "POST"],
      ["libraryStats", libraryStatsHandler, "GET"],
    ] as const)("%s returns 4xx for a garbage bearer token", async (_name, handler, method) => {
      const result = await invoke(handler, {
        method,
        headers: { authorization: "Bearer not-a-jwt" },
        body: {},
      });
      assertSafeClientFailure(result);
      expect(result.status).toBe(401);
    });
  });

  describe("hostile bodies", () => {
    const authHeaders = () => ({ authorization: `Bearer ${signWebToken()}` });

    it.each([
      ["vote missing docId", voteHandler, { vote: 1 }],
      ["vote wrong-type docId", voteHandler, { docId: 123, vote: 1 }],
      ["vote array docId", voteHandler, { docId: ["abc"], vote: 1 }],
      ["vote invalid vote", voteHandler, { docId: "abcdefghij1234567890", vote: 2 }],
      ["vote string vote", voteHandler, { docId: "abcdefghij1234567890", vote: "up" }],
      ["vote huge comment", voteHandler, { docId: "abcdefghij1234567890", vote: -1, reason: "inaccurate", comment: HUGE }],
      ["vote injection comment", voteHandler, { docId: INJECTION, vote: -1, reason: "inaccurate", comment: INJECTION }],
      ["contact missing name", contactHandler, { email: "user@example.com", message: "hello" }],
      ["contact wrong-type name", contactHandler, { name: 1, email: "user@example.com", message: "hello" }],
      ["contact invalid email", contactHandler, { name: "Ada", email: "not-an-email", message: "hello" }],
      ["contact header-inject email", contactHandler, { name: "Ada", email: "a@b.com\nBcc:evil@x.com", message: "hello" }],
      ["contact huge message", contactHandler, { name: "Ada", email: "user@example.com", message: HUGE }],
      ["login missing email", loginHandler, { password: "Password1!" }],
      ["login invalid email", loginHandler, { email: "nope", password: "Password1!" }],
      ["login huge password", loginHandler, { email: "user@example.com", password: HUGE }],
      ["login injection email", loginHandler, { email: INJECTION, password: "Password1!" }],
      ["loginWithPassword missing password", loginWithPasswordHandler, { email: "user@example.com" }],
      ["loginWithPassword wrong-type email", loginWithPasswordHandler, { email: 1, password: "Password1!" }],
      ["checkAuthMethod missing email", checkAuthMethodHandler, {}],
      ["checkAuthMethod wrong-type email", checkAuthMethodHandler, { email: ["a@b.com"] }],
      ["get-token missing secret", getTokenHandler, {}],
      ["get-token huge secret", getTokenHandler, { secret: HUGE }],
    ])("%s", async (_name, handler, body) => {
      const result = await invoke(handler, { method: "POST", headers: authHeaders(), body });
      assertSafeClientFailure(result);
    });

    it("titleScope rejects a huge query string", async () => {
      const result = await invoke(titleScopeHandler, {
        method: "GET",
        headers: authHeaders(),
        query: { q: HUGE },
      });
      assertSafeClientFailure(result);
    });

    it("titleScope rejects a non-string query array", async () => {
      const result = await invoke(titleScopeHandler, {
        method: "GET",
        headers: authHeaders(),
        query: { q: ["a", "b"] },
      });
      expect(result.threw).toBe(false);
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(500);
      expect(looksLikeStackTrace(result.bodyText)).toBe(false);
    });

    it("contact injection-looking name/message does not 500", async () => {
      const result = await invoke(contactHandler, {
        method: "POST",
        headers: authHeaders(),
        body: { name: INJECTION, email: "user@example.com", message: INJECTION },
      });
      expect(result.threw).toBe(false);
      expect(result.status).not.toBe(500);
      expect(looksLikeStackTrace(result.bodyText)).toBe(false);
    });
  });

  describe("unicode and control characters", () => {
    it("login unicode email returns 4xx", async () => {
      const result = await invoke(loginHandler, {
        method: "POST",
        headers: { authorization: `Bearer ${signWebToken()}` },
        body: { email: UNICODE, password: "Password1!" },
      });
      assertSafeClientFailure(result);
    });

    it("vote unicode docId does not 500", async () => {
      const result = await invoke(voteHandler, {
        method: "POST",
        headers: { authorization: `Bearer ${signWebToken()}` },
        body: { docId: UNICODE, vote: 1 },
      });
      expect(result.threw).toBe(false);
      expect(result.status).not.toBe(500);
      expect(looksLikeStackTrace(result.bodyText)).toBe(false);
    });

    it("contact unicode name does not 500", async () => {
      const result = await invoke(contactHandler, {
        method: "POST",
        headers: { authorization: `Bearer ${signWebToken()}` },
        body: { name: UNICODE, email: "user@example.com", message: "hello" },
      });
      expect(result.threw).toBe(false);
      expect(result.status).not.toBe(500);
      expect(looksLikeStackTrace(result.bodyText)).toBe(false);
    });
  });
});
