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
  countCookiesInHeader,
  requestHasTrustedNavigationOrigin,
  EXCESSIVE_COOKIE_COUNT,
} from "../../../src/proxy";
import { getRequestNonce } from "@/utils/server/cspNonce";

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));

jest.mock("@/utils/server/libraryAccessMiddlewareGate", () => ({
  applyComputedLibraryAccessOverrides: jest.fn((_headers: Headers) => []),
}));

jest.mock("@/config/publicPaths", () => ({
  getAllPublicPaths: jest.fn(() => ["/login", "/share/", "/answers/"]),
  PUBLIC_PATHS: {
    noLoginPublicPages: ["/answers"],
    noLoginPublicApis: ["/api/answers"],
  },
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

describe("cookie and referer security checks", () => {
  const originalSiteId = process.env.SITE_ID;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    loadSiteConfigSync.mockReset();
    loadSiteConfigSync.mockReturnValue({
      siteId: "ananda-public",
      requireLogin: false,
      allowedFrontEndDomains: ["vivek.ananda.org"],
    });
    process.env.SITE_ID = "ananda-public";
    process.env.NEXT_PUBLIC_BASE_URL = "https://vivek.ananda.org";
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalSiteId === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSiteId;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  function cookieWarningCalls(): string[] {
    return warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("Excessive number of cookies"));
  }

  function refererWarningCalls(): string[] {
    return warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("Missing or suspicious referer"));
  }

  it("counts name=value cookies and ignores reconstructed attribute tokens", () => {
    expect(EXCESSIVE_COOKIE_COUNT).toBe(30);
    expect(countCookiesInHeader("uuid=a; libraryAccess=b; answersViewer=c")).toBe(3);
    expect(countCookiesInHeader("uuid=a; Path=/; HttpOnly; libraryAccess=b; Path=/; SameSite=Lax")).toBe(2);
    expect(countCookiesInHeader("a=1; ; HttpOnly; Path=/")).toBe(1);

    const elevenCookiesWithAttributes = Array.from({ length: 11 }, (_, index) => `c${index}=v${index}; Path=/; HttpOnly`).join(
      "; "
    );
    expect(elevenCookiesWithAttributes.split(";").length).toBeGreaterThan(30);
    expect(countCookiesInHeader(elevenCookiesWithAttributes)).toBe(11);
    expect(countCookiesInHeader(Array.from({ length: 31 }, (_, index) => `c${index}=v`).join("; "))).toBe(31);
  });

  it("does not log or block a normal browser cookie header that includes attributes", () => {
    const cookieHeader = Array.from({ length: 11 }, (_, index) => `c${index}=v${index}; Path=/; HttpOnly`).join("; ");
    const response = middleware(makeRequest("/", { headers: { cookie: cookieHeader } }));

    expect(cookieWarningCalls()).toEqual([]);
    expect(response.status).not.toBe(403);
  });

  it("logs more than 30 real cookies but still allows the request", () => {
    const cookieHeader = Array.from({ length: 31 }, (_, index) => `c${index}=v`).join("; ");
    const response = middleware(makeRequest("/answers", { headers: { cookie: cookieHeader } }));

    expect(cookieWarningCalls().length).toBe(1);
    expect(response.status).not.toBe(403);
  });

  it("treats Origin as a trusted same-site POST signal when Referer is missing", () => {
    expect(
      requestHasTrustedNavigationOrigin(
        makeRequest("/api/chat/v1", {
          method: "POST",
          headers: { origin: "https://vivek.ananda.org" },
        })
      )
    ).toBe(true);

    const response = middleware(
      makeRequest("/api/chat/v1", {
        method: "POST",
        headers: {
          origin: "https://vivek.ananda.org",
          "content-type": "application/json",
        },
      })
    );

    expect(refererWarningCalls()).toEqual([]);
    expect(response.status).not.toBe(403);
  });

  it("logs a POST with no Referer and no Origin but does not block it", () => {
    const response = middleware(
      makeRequest("/api/chat/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
      })
    );

    expect(refererWarningCalls().length).toBe(1);
    expect(response.status).not.toBe(403);
  });
});
