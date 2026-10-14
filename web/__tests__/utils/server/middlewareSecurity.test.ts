/** @jest-environment node */

jest.unmock("next/server");

import { NextRequest } from "next/server";
import {
  middleware,
  isSensitiveFilePath,
  isStaticAssetPath,
  SENSITIVE_FILE_MARKERS,
  buildContentSecurityPolicy,
  createCspNonce,
} from "../../../middleware";
import { getRequestNonce } from "@/utils/server/cspNonce";

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

const { loadSiteConfigSync } = jest.requireMock("@/utils/server/loadSiteConfig") as {
  loadSiteConfigSync: jest.Mock;
};

function makeRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

describe("middleware security helpers", () => {
  it("lists env, git, and secret config markers", () => {
    expect(SENSITIVE_FILE_MARKERS).toEqual(
      expect.arrayContaining([".env", ".git", "wp-config.php", "secrets.json", "credentials.json"])
    );
    expect(SENSITIVE_FILE_MARKERS.length).toBeGreaterThan(0);
  });

  it("detects sensitive file paths", () => {
    expect(isSensitiveFilePath("/.env")).toBe(true);
    expect(isSensitiveFilePath("/.env.local")).toBe(true);
    expect(isSensitiveFilePath("/.git/config")).toBe(true);
    expect(isSensitiveFilePath("/wp-config.php")).toBe(true);
    expect(isSensitiveFilePath("/secrets.json")).toBe(true);
    expect(isSensitiveFilePath("/login")).toBe(false);
    expect(isSensitiveFilePath("/answers/123")).toBe(false);
    expect(isSensitiveFilePath("/x.envelope")).toBe(false);
    expect(isSensitiveFilePath("/.github")).toBe(false);
  });

  it("matches static files with a literal dot, not a backslash", () => {
    expect(isStaticAssetPath("/logo.png")).toBe(true);
    expect(isStaticAssetPath("/styles.css")).toBe(true);
    expect(isStaticAssetPath("/app.js")).toBe(true);
    expect(isStaticAssetPath("/folder\\png")).toBe(false);
    expect(isStaticAssetPath("/answers/123")).toBe(false);
  });

  it("puts the nonce into the CSP script-src directive", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("script-src");
  });

  it("reads x-nonce from request-like headers", () => {
    expect(getRequestNonce({ "x-nonce": "abc123" })).toBe("abc123");
    expect(getRequestNonce({ get: (name: string) => (name === "x-nonce" ? "from-get" : null) })).toBe("from-get");
    expect(getRequestNonce(undefined)).toBeUndefined();
  });
});

describe("middleware security behavior", () => {
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

  it("returns 403 for sensitive file paths", () => {
    const response = middleware(makeRequest("/.env.production"));
    expect(response.status).toBe(403);
  });

  it("fails closed with 503 when site config is missing", () => {
    loadSiteConfigSync.mockReturnValue(null);
    const response = middleware(makeRequest("/"));
    expect(response.status).toBe(503);
  });

  it("forwards the same CSP nonce on the request and in Content-Security-Policy", () => {
    const response = middleware(makeRequest("/"));
    const forwarded = response.headers.get("x-middleware-request-x-nonce");
    const csp = response.headers.get("content-security-policy") || "";

    expect(forwarded).toBeTruthy();
    expect(response.headers.get("x-nonce")).toBeNull();
    expect(csp).toContain(`'nonce-${forwarded}'`);
  });

  it("does not treat a path ending in .png as private when login is required", () => {
    loadSiteConfigSync.mockReturnValue({
      siteId: "ananda",
      requireLogin: true,
      allowedFrontEndDomains: ["localhost:3000"],
    });
    const response = middleware(makeRequest("/logo.png"));
    expect(response.status).not.toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });
});
