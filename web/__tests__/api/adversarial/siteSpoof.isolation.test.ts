/** @jest-environment node */
/**
 * Request-layer site spoof tests. SITE_ID must win over query, body, host, and headers.
 */

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn((id: string) => ({
        id,
        get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
      })),
    })),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  __esModule: true,
  default: jest.fn(),
  runMiddleware: jest.fn().mockResolvedValue(undefined),
  setCorsHeaders: jest.fn(),
  handleCorsOptions: jest.fn(),
  createErrorCorsHeaders: jest.fn().mockReturnValue({}),
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
  checkEmailBlacklist: jest.fn().mockResolvedValue({ blocked: false }),
}));

jest.mock("@/utils/server/titleCatalog", () => ({
  suggestTitleScopes: jest.fn().mockResolvedValue([]),
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
import getTokenHandler from "@/pages/api/get-token";
import loginWithPasswordHandler from "@/pages/api/auth/loginWithPassword";
import titleScopeHandler from "@/pages/api/titleScope/suggest";
import libraryStatsHandler from "@/pages/api/libraryStats";
import { db } from "@/services/firebase";

const SITES = ["ananda", "ananda-public", "crystal", "jairam"] as const;

function signWebToken(): string {
  return jwt.sign({ client: "web", iat: Math.floor(Date.now() / 1000) }, process.env.SECURE_TOKEN as string, {
    algorithm: JWT_SIGN_OPTIONS.algorithm as jwt.Algorithm,
    issuer: JWT_SIGN_OPTIONS.issuer,
    audience: JWT_SIGN_OPTIONS.audience,
    expiresIn: "15m",
  });
}

describe("request site spoof isolation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SECURE_TOKEN = "test-adversarial-secure-token";
    process.env.SECURE_TOKEN_HASH = "hashed";
    global.fetch = jest.fn(async () => {
      throw new Error("Real network call attempted: fetch");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("/api/get-token expectedSiteId", () => {
    it.each(SITES)("rejects a spoofed expectedSiteId when SITE_ID is %s", async (site) => {
      process.env.SITE_ID = site;
      const other = SITES.find((item) => item !== site) as string;
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: { host: "chat.crystalclarity.com", "x-site-id": other },
        query: { site: other, siteId: other },
        body: {
          secret: process.env.SECURE_TOKEN,
          expectedSiteId: other,
        },
      });
      await getTokenHandler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData().code).toBe("SITE_MISMATCH");
      expect(JSON.stringify(res._getJSONData())).toContain(site);
      expect(JSON.stringify(res._getJSONData())).not.toContain("at ");
    });

    it.each(SITES)("accepts a matching expectedSiteId for %s", async (site) => {
      process.env.SITE_ID = site;
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          secret: process.env.SECURE_TOKEN,
          expectedSiteId: site,
        },
      });
      await getTokenHandler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().token).toEqual(expect.any(String));
    });
  });

  describe("/api/auth/loginWithPassword requireLogin flag", () => {
    it.each(["ananda-public", "crystal"] as const)("blocks password login on %s", async (site) => {
      process.env.SITE_ID = site;
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: { "x-site-id": "ananda" },
        query: { site: "ananda" },
        body: { email: "user@example.com", password: "Password1!" },
      });
      await loginWithPasswordHandler(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData().error).toMatch(/not available/i);
    });

    it.each(["ananda", "jairam"] as const)("keeps password login available on %s", async (site) => {
      process.env.SITE_ID = site;
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: { "x-site-id": "crystal" },
        query: { site: "crystal" },
        body: { email: "not-an-email", password: "Password1!" },
      });
      await loginWithPasswordHandler(req, res);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("/api/titleScope/suggest feature flag", () => {
    it("returns 404 on crystal when title scope is off", async () => {
      process.env.SITE_ID = "crystal";
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: `Bearer ${signWebToken()}`, "x-site-id": "ananda" },
        query: { q: "synth", site: "ananda" },
      });
      await titleScopeHandler(req, res);
      expect(res.statusCode).toBe(404);
    });

    it("does not use query.site to enable title scope on crystal", async () => {
      process.env.SITE_ID = "crystal";
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: `Bearer ${signWebToken()}` },
        query: { q: "synth", siteId: "ananda", site: "ananda" },
      });
      await titleScopeHandler(req, res);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("/api/libraryStats site document", () => {
    it("reads the SITE_ID document and ignores query.site", async () => {
      process.env.SITE_ID = "ananda";
      const collection = db?.collection as jest.Mock;
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: `Bearer ${signWebToken()}`, host: "chat.crystalclarity.com" },
        query: { site: "crystal", siteId: "jairam" },
      });
      await libraryStatsHandler(req, res);
      expect(collection).toHaveBeenCalledWith("libraryStats");
      const doc = collection.mock.results[0].value.doc as jest.Mock;
      expect(doc).toHaveBeenCalledWith("ananda");
      expect(doc).not.toHaveBeenCalledWith("crystal");
    });
  });
});
