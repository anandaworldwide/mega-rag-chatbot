/**
 * Logged-out proxy() access on real requireLogin site configs (ananda, jairam).
 * Does not mock publicPaths or loadSiteConfig.
 *
 * @jest-environment node
 */

jest.unmock("next/server");

import { NextRequest } from "next/server";
import { proxy, buildContentSecurityPolicy, s3MediaOrigins } from "../../../src/proxy";
import { VERCEL_CRON_PATHS } from "../../../src/config/cronPaths";
import { loadSiteConfigSync } from "../../../src/utils/server/loadSiteConfig";

jest.mock("@/utils/server/libraryAccessMiddlewareGate", () => ({
  applyComputedLibraryAccessOverrides: jest.fn((_headers: Headers) => []),
}));

jest.mock("@/utils/server/corsMiddleware", () => ({
  createErrorCorsHeaders: jest.fn(() => ({ "content-type": "application/json" })),
  handleCors: jest.fn(() => null),
  addCorsHeaders: jest.fn((response: Response) => response),
}));

const LOGIN_SITES = ["ananda", "jairam"] as const;
const CRON_SECRET = "test-cron-secret-value-ok!!";

const PUBLIC_APIS: Array<{ path: string; method: string }> = [
  { path: "/api/verifyMagicLink", method: "POST" },
  { path: "/api/email/click", method: "GET" },
  { path: "/api/email/open", method: "GET" },
  { path: "/api/unsubscribe", method: "GET" },
  { path: "/api/share/share-doc-id", method: "GET" },
  { path: "/api/redirect/mg", method: "GET" },
  { path: "/api/manifest.json", method: "GET" },
  { path: "/api/apple-touch-icon", method: "GET" },
];

const PUBLIC_PAGES = ["/request-submitted", "/verify-email-change"];

function makeRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

function isDenied(response: { status: number; headers: { get(name: string): string | null } }): boolean {
  const location = response.headers.get("location") || "";
  return response.status === 401 || response.status === 307 || location.includes("/login");
}

describe("proxy login-site public access (real ananda/jairam config)", () => {
  const originalSiteId = process.env.SITE_ID;
  const originalCronSecret = process.env.CRON_SECRET;
  const originalBucket = process.env.NEXT_PUBLIC_S3_BUCKET_NAME;
  const originalS3Bucket = process.env.S3_BUCKET_NAME;
  const originalRegion = process.env.AWS_REGION;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
  });

  afterEach(() => {
    if (originalSiteId === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSiteId;
    }
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    if (originalBucket === undefined) {
      delete process.env.NEXT_PUBLIC_S3_BUCKET_NAME;
    } else {
      process.env.NEXT_PUBLIC_S3_BUCKET_NAME = originalBucket;
    }
    if (originalS3Bucket === undefined) {
      delete process.env.S3_BUCKET_NAME;
    } else {
      process.env.S3_BUCKET_NAME = originalS3Bucket;
    }
    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
  });

  it("loads requireLogin from the real site config for ananda and jairam", () => {
    for (const siteId of LOGIN_SITES) {
      const config = loadSiteConfigSync(siteId);
      expect(config).not.toBeNull();
      expect(config?.requireLogin).toBe(true);
    }
  });

  describe.each(LOGIN_SITES)("SITE_ID=%s", (siteId) => {
    beforeEach(() => {
      process.env.SITE_ID = siteId;
    });

    it("lets each vercel.json cron path through with a matching Bearer and rejects an invalid Bearer", () => {
      expect(VERCEL_CRON_PATHS.length).toBeGreaterThan(0);
      for (const cronPath of VERCEL_CRON_PATHS) {
        const allowed = proxy(
          makeRequest(cronPath, { headers: { authorization: `Bearer ${CRON_SECRET}` } })
        );
        expect(isDenied(allowed)).toBe(false);

        const denied = proxy(makeRequest(cronPath, { headers: { authorization: "Bearer wrong-secret" } }));
        expect(denied.status).toBe(401);

        const missing = proxy(makeRequest(cronPath));
        expect(missing.status).toBe(401);
      }
    });

    it("lets logged-out callers hit each public API", () => {
      for (const { path, method } of PUBLIC_APIS) {
        const response = proxy(makeRequest(path, { method }));
        expect({ path, status: response.status, denied: isDenied(response) }).toEqual({
          path,
          status: response.status,
          denied: false,
        });
      }
    });

    it("lets logged-out callers open /request-submitted and /verify-email-change", () => {
      for (const path of PUBLIC_PAGES) {
        const response = proxy(makeRequest(path));
        expect(response.status).not.toBe(401);
        expect(response.status).not.toBe(307);
        expect(isDenied(response)).toBe(false);
      }
    });

    it("still returns 401 for a protected API with no cookie", () => {
      const response = proxy(makeRequest("/api/chats"));
      expect(response.status).toBe(401);
    });

    it("does not let a CRON_SECRET Bearer skip the gate on a non-cron route", () => {
      const response = proxy(
        makeRequest("/api/chats", { headers: { authorization: `Bearer ${CRON_SECRET}` } })
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 for logged-out GET /api/document/{id} and 200 for /api/share/{id}", () => {
      const shareId = "OHXIZPKK5XAyj9f1vEXx";
      expect(proxy(makeRequest(`/api/document/${shareId}`)).status).toBe(401);
      const shareResponse = proxy(makeRequest(`/api/share/${shareId}`));
      expect(shareResponse.status).toBe(200);
      expect(isDenied(shareResponse)).toBe(false);
    });

    it("lets logged-out share and answer pages through, and still sends / and /settings to login", () => {
      const shareId = "OHXIZPKK5XAyj9f1vEXx";
      const shareAndAnswerRequests: Array<{ path: string; method?: string }> = [
        { path: `/share/${shareId}` },
        { path: `/api/share/${shareId}` },
        { path: "/api/web-token" },
        { path: `/data/${siteId}/whats-new.json`, method: "HEAD" },
        { path: `/data/${siteId}/whats-new.json` },
        { path: `/_next/data/test-build/share/${shareId}.json` },
        { path: "/api/manifest.json" },
        { path: "/api/apple-touch-icon" },
        { path: `/answers/${shareId}` },
        { path: `/_next/data/test-build/answers/${shareId}.json` },
        { path: `/api/answers?answerIds=${shareId}` },
      ];

      for (const { path, method } of shareAndAnswerRequests) {
        const response = proxy(makeRequest(path, method ? { method } : undefined));
        expect({ path, status: response.status, denied: isDenied(response) }).toEqual({
          path,
          status: response.status,
          denied: false,
        });
      }

      // Share loads /api/share only. These stay cookie-gated.
      expect(proxy(makeRequest("/api/chats")).status).toBe(401);
      expect(proxy(makeRequest("/api/profile")).status).toBe(401);
      expect(proxy(makeRequest("/api/relatedQuestions")).status).toBe(401);
      expect(proxy(makeRequest("/api/getAudioSignedUrl", { method: "POST" })).status).toBe(401);
      expect(proxy(makeRequest("/api/getPdfSignedUrl", { method: "POST" })).status).toBe(401);

      for (const path of ["/", "/settings"]) {
        const response = proxy(makeRequest(path));
        expect(response.status).toBe(307);
        expect(response.headers.get("location") || "").toContain("/login");
      }
    });
  });
});

describe("proxy no-login site public share (real ananda-public config)", () => {
  const originalSiteId = process.env.SITE_ID;

  afterEach(() => {
    if (originalSiteId === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSiteId;
    }
  });

  it("lets logged-out /share/{id} and /api/share/{id} through when requireLogin is false", () => {
    const config = loadSiteConfigSync("ananda-public");
    expect(config).not.toBeNull();
    expect(config?.requireLogin).toBe(false);

    process.env.SITE_ID = "ananda-public";
    const shareId = "OHXIZPKK5XAyj9f1vEXx";
    const page = proxy(makeRequest(`/share/${shareId}`));
    const shareApi = proxy(makeRequest(`/api/share/${shareId}`));
    expect(isDenied(page)).toBe(false);
    expect(shareApi.status).toBe(200);
    expect(isDenied(shareApi)).toBe(false);
  });
});

describe("CSP S3 media host", () => {
  it("derives virtual-hosted and regional S3 origins from bucket and region", () => {
    const origins = s3MediaOrigins("ananda-test-bucket", "us-west-2");
    expect(origins).toEqual([
      "https://ananda-test-bucket.s3.amazonaws.com",
      "https://ananda-test-bucket.s3.us-west-2.amazonaws.com",
      "https://s3.us-west-2.amazonaws.com",
    ]);
  });

  it("omits origins when the bucket is missing or not a hostname", () => {
    expect(s3MediaOrigins("", "us-west-2")).toEqual([]);
    expect(s3MediaOrigins("bad bucket", "us-west-2")).toEqual([]);
    expect(s3MediaOrigins("ok-bucket", "bad region!")).toEqual(["https://ok-bucket.s3.amazonaws.com"]);
  });

  it("puts those S3 hosts in media-src", () => {
    const origins = s3MediaOrigins("ananda-test-bucket", "us-west-2");
    const csp = buildContentSecurityPolicy("test-nonce", true, origins);
    const mediaSrc = csp.split(";").find((part) => part.trim().startsWith("media-src")) || "";
    expect(mediaSrc).toContain("media-src 'self' blob:");
    expect(mediaSrc).toContain("https://ananda-test-bucket.s3.amazonaws.com");
    expect(mediaSrc).toContain("https://ananda-test-bucket.s3.us-west-2.amazonaws.com");
  });

  it("adds the env-derived S3 host to the proxy CSP on a public page", () => {
    const originalSiteId = process.env.SITE_ID;
    const originalBucket = process.env.NEXT_PUBLIC_S3_BUCKET_NAME;
    const originalRegion = process.env.AWS_REGION;
    process.env.SITE_ID = "ananda";
    process.env.NEXT_PUBLIC_S3_BUCKET_NAME = "ananda-test-bucket";
    process.env.AWS_REGION = "us-west-2";

    try {
      const response = proxy(makeRequest("/login"));
      const csp = response.headers.get("content-security-policy") || "";
      expect(isDenied(response)).toBe(false);
      expect(csp).toContain("https://ananda-test-bucket.s3.us-west-2.amazonaws.com");
      expect(csp).toContain("https://ananda-test-bucket.s3.amazonaws.com");
    } finally {
      if (originalSiteId === undefined) {
        delete process.env.SITE_ID;
      } else {
        process.env.SITE_ID = originalSiteId;
      }
      if (originalBucket === undefined) {
        delete process.env.NEXT_PUBLIC_S3_BUCKET_NAME;
      } else {
        process.env.NEXT_PUBLIC_S3_BUCKET_NAME = originalBucket;
      }
      if (originalRegion === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = originalRegion;
      }
    }
  });
});
