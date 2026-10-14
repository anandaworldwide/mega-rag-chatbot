/**
 * Middleware regressions from the per-fix security list.
 *
 * @jest-environment node
 */

import { NextRequest } from "next/server";
import {
  middleware,
  sensitiveFiles,
  isStaticAsset,
  isSensitiveFilePath,
  buildContentSecurityPolicy,
  createCspNonce,
  logSuspiciousActivity,
} from "../middleware";

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/libraryAccessMiddlewareGate", () => ({
  applyComputedLibraryAccessOverrides: jest.fn((_headers: Headers) => []),
}));

jest.mock("@/config/publicPaths", () => ({
  getAllPublicPaths: jest.fn(() => ["/login", "/share/", "/answers/"]),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  createErrorCorsHeaders: jest.fn(() => ({})),
  handleCors: jest.fn(() => null),
  addCorsHeaders: jest.fn((response: Response) => response),
}));

jest.mock("@/utils/server/ipUtils", () => ({
  getClientIp: jest.fn(() => "127.0.0.1"),
}));

const { loadSiteConfigSync } = jest.requireMock("@/utils/server/loadSiteConfig") as {
  loadSiteConfigSync: jest.Mock;
};

function makeRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

function loginRequiredConfig() {
  return {
    siteId: "ananda",
    requireLogin: true,
    allowedFrontEndDomains: ["localhost:3000"],
  };
}

describe("middleware exports", () => {
  it("exports a non-empty sensitiveFiles list", () => {
    expect(Array.isArray(sensitiveFiles)).toBe(true);
    expect(sensitiveFiles.length).toBeGreaterThan(0);
    expect(sensitiveFiles).toEqual(
      expect.arrayContaining([".env", ".git", "package.json", "firebase.prod.json"])
    );
  });

  it("unit-tests isStaticAsset(path)", () => {
    expect(isStaticAsset("/logo.png")).toBe(true);
    expect(isStaticAsset("/foo/app.js")).toBe(true);
    expect(isStaticAsset("/styles.css")).toBe(true);
    expect(isStaticAsset("/admin")).toBe(false);
    expect(isStaticAsset("/apipng")).toBe(false);
    expect(isStaticAsset("/x.php")).toBe(false);
    expect(isStaticAsset("/secret.png.html")).toBe(false);
    expect(isStaticAsset("/folder\\png")).toBe(false);
  });
});

describe("middleware fail-closed config and sensitive files", () => {
  const originalSiteId = process.env.SITE_ID;

  beforeEach(() => {
    loadSiteConfigSync.mockReset();
    loadSiteConfigSync.mockReturnValue({
      siteId: "ananda",
      requireLogin: false,
      allowedFrontEndDomains: ["localhost:3000"],
    });
    process.env.SITE_ID = "ananda";
  });

  afterEach(() => {
    if (originalSiteId === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSiteId;
    }
  });

  it("does not return 200 when siteConfig is null on a private path", () => {
    loadSiteConfigSync.mockReturnValue(null);
    const response = middleware(makeRequest("/admin"));
    expect(response.status).not.toBe(200);
    expect([500, 503, 307, 308].includes(response.status) || (response.headers.get("location") || "").includes("/login")).toBe(
      true
    );
    expect(response.status).toBe(503);
  });

  it.each(["/.env", "/.git/config", "/package.json", "/firebase.prod.json", "/.ENV"])(
    "blocks %s and logs suspicious activity",
    (path) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const response = middleware(makeRequest(path));
      expect([403, 404]).toContain(response.status);
      expect(isSensitiveFilePath(path)).toBe(true);
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.some((args) => String(args[0]).includes("Attempt to access potentially sensitive file"));
      expect(logged).toBe(true);
      warn.mockRestore();
    }
  );

  it("logSuspiciousActivity is exported and writes a warning", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    logSuspiciousActivity(makeRequest("/admin"), "unit-test");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("middleware requireLogin static vs private paths", () => {
  beforeEach(() => {
    loadSiteConfigSync.mockReset();
    loadSiteConfigSync.mockReturnValue(loginRequiredConfig());
    process.env.SITE_ID = "ananda";
  });

  it("lets static assets through without a cookie", () => {
    for (const path of ["/logo.png", "/foo/app.js"]) {
      const response = middleware(makeRequest(path));
      expect(response.status).not.toBe(401);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("still requires auth for non-static lookalikes", () => {
    for (const path of ["/admin", "/apipng", "/x.php", "/secret.png.html"]) {
      const response = middleware(makeRequest(path));
      const location = response.headers.get("location") || "";
      expect(response.status === 401 || location.includes("/login")).toBe(true);
    }
  });
});

describe("middleware CSP nonce", () => {
  beforeEach(() => {
    loadSiteConfigSync.mockReset();
    loadSiteConfigSync.mockReturnValue({
      siteId: "ananda",
      requireLogin: false,
      allowedFrontEndDomains: ["localhost:3000"],
    });
    process.env.SITE_ID = "ananda";
  });

  it("puts script-src 'nonce-<x>' equal to the x-nonce header", () => {
    const response = middleware(makeRequest("/"));
    const nonce = response.headers.get("x-nonce");
    const csp = response.headers.get("content-security-policy") || "";
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`script-src`);
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it("omits unsafe-inline and unsafe-eval from production script-src", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce, true);
    const scriptSrc = csp.split(";").find((part) => part.trim().startsWith("script-src")) || "";
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("uses a distinct base64 nonce of 16 bytes per request", () => {
    const first = createCspNonce();
    const second = createCspNonce();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64").length).toBe(16);
    expect(Buffer.from(second, "base64").length).toBe(16);

    const a = middleware(makeRequest("/"));
    const b = middleware(makeRequest("/"));
    expect(a.headers.get("x-nonce")).toBeTruthy();
    expect(a.headers.get("x-nonce")).not.toBe(b.headers.get("x-nonce"));
  });
});
