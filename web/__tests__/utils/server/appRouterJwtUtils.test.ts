/** @jest-environment node */

import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromAppRequest, withAppRouterJwtAuth } from "@/utils/server/appRouterJwtUtils";
import * as blacklistMod from "@/utils/server/blacklist";
import * as loadSiteConfigMod from "@/utils/server/loadSiteConfig";
import * as corsMiddleware from "@/utils/server/corsMiddleware";
import * as envMod from "@/utils/env";

jest.mock("@/utils/server/blacklist", () => ({
  checkEmailBlacklist: jest.fn().mockResolvedValue({
    blocked: false,
    skipped: false,
    cacheHit: true,
    fetchMs: 0,
  }),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue(null),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  addCorsHeaders: jest.fn((response: NextResponse) => response),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(false),
}));

const mockCheckEmailBlacklist = blacklistMod.checkEmailBlacklist as jest.MockedFunction<
  typeof blacklistMod.checkEmailBlacklist
>;
const mockLoadSiteConfigSync = loadSiteConfigMod.loadSiteConfigSync as jest.MockedFunction<
  typeof loadSiteConfigMod.loadSiteConfigSync
>;
const mockIsDevelopment = envMod.isDevelopment as jest.MockedFunction<typeof envMod.isDevelopment>;

function makeReq(authHeader: string | null, origin: string | null = null): NextRequest {
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "authorization") return authHeader;
        if (key === "origin") return origin;
        if (key === "x-forwarded-proto") return "https";
        return null;
      },
    },
  } as unknown as NextRequest;
}

describe("appRouterJwtUtils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SECURE_TOKEN: "test-secure-token", SITE_ID: "ananda" };
    mockLoadSiteConfigSync.mockReturnValue(null);
    mockIsDevelopment.mockReturnValue(false);
    mockCheckEmailBlacklist.mockResolvedValue({
      blocked: false,
      skipped: false,
      cacheHit: true,
      fetchMs: 0,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects empty Bearer token payloads", () => {
    expect(() => getTokenFromAppRequest(makeReq("Bearer "))).toThrow("No token provided");
    expect(() => getTokenFromAppRequest(makeReq("Bearer"))).toThrow("No token provided");
  });

  it("rejects alg:none and wrong-issuer forged tokens", () => {
    const noneToken = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          client: "web",
          iss: "mega-rag-chatbot",
          aud: "mega-rag-chatbot-users",
        })
      ).toString("base64url"),
      "",
    ].join(".");

    expect(() => getTokenFromAppRequest(makeReq(`Bearer ${noneToken}`))).toThrow("Invalid or expired token");

    const wrongIssuer = jwt.sign({ client: "web" }, "test-secure-token", {
      algorithm: "HS256",
      issuer: "evil-issuer",
      audience: "mega-rag-chatbot-users",
      expiresIn: "15m",
    });
    expect(() => getTokenFromAppRequest(makeReq(`Bearer ${wrongIssuer}`))).toThrow("Invalid or expired token");
  });

  it("revokes blacklisted sessions", async () => {
    mockCheckEmailBlacklist.mockResolvedValueOnce({
      blocked: true,
      skipped: false,
      cacheHit: true,
      fetchMs: 0,
    });

    const token = jwt.sign(
      { client: "web", email: "blocked@example.com", role: "user" },
      "test-secure-token",
      {
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
        expiresIn: "15m",
      }
    );

    const handler = jest.fn();
    const result = (await withAppRouterJwtAuth(handler)(makeReq(`Bearer ${token}`), {})) as NextResponse;

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe(401);
    const body = await result.json();
    expect(body).toEqual({ message: "session_revoked" });
    expect(mockCheckEmailBlacklist).toHaveBeenCalledWith("blocked@example.com", "ananda");
  });

  it("does not reflect Origin in production when site config is missing", async () => {
    const handler = jest.fn();
    const result = (await withAppRouterJwtAuth(handler)(
      makeReq(null, "https://evil.example"),
      {}
    )) as NextResponse;

    expect(result.status).toBe(401);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(corsMiddleware.addCorsHeaders).not.toHaveBeenCalled();
  });

  it("uses site-config CORS helper when available", async () => {
    mockLoadSiteConfigSync.mockReturnValue({ siteId: "ananda" } as ReturnType<typeof loadSiteConfigMod.loadSiteConfigSync>);
    const handler = jest.fn();
    const result = await withAppRouterJwtAuth(handler)(makeReq(null, "https://evil.example"), {});

    expect(corsMiddleware.addCorsHeaders).toHaveBeenCalled();
    expect((result as NextResponse).status).toBe(401);
  });
});
