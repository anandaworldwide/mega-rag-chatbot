/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/email/click";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { generateClickRedirectSignature } from "@/utils/server/emailTokenUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
}));
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    fromDate: jest.fn((date: Date) => ({
      seconds: Math.floor(date.getTime() / 1000),
      nanoseconds: 0,
    })),
  };

  const firestoreFn = jest.fn(() => ({}));
  (firestoreFn as any).Timestamp = mockTimestamp;

  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: { cert: jest.fn() },
    initializeApp: jest.fn(),
  };
});

const { db } = jest.requireMock("@/services/firebase");
const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockLoadSiteConfigSync = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockGetUsersCollectionName = getUsersCollectionName as jest.MockedFunction<typeof getUsersCollectionName>;

const SITE_CONFIG = {
  allowedFrontEndDomains: [
    "luca.ananda.org",
    "localhost:3000",
    "**-ananda-web-services-projects.vercel.app",
  ],
  accessControl: { originUrl: "https://luca.ananda.org" },
  parent_site_url: "https://www.ananda.org",
  help_url: "https://anandafamily.notion.site/luca-help",
  redirectMappings: {
    mg: { url: "https://www.ananda.org/contact-us/", event: "x", description: "x" },
  },
};

describe("/api/email/click", () => {
  const originalSecret = process.env.SECURE_TOKEN;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECURE_TOKEN = "test-secret";
    delete process.env.NEXT_PUBLIC_BASE_URL;
    db.collection = jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({}),
        }),
      }),
    });
    genericRateLimiter.mockResolvedValue(true);
    mockFirestoreSet.mockResolvedValue(undefined);
    mockLoadSiteConfigSync.mockReturnValue(SITE_CONFIG as any);
    mockGetUsersCollectionName.mockReturnValue("test_users");
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SECURE_TOKEN;
    } else {
      process.env.SECURE_TOKEN = originalSecret;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  function createClickRequest(
    targetUrl: string,
    options: { email?: string; sig?: string | null; host?: string } = {}
  ) {
    const email = options.email ?? "test@example.com";
    const query: Record<string, string> = {
      url: targetUrl,
      email,
      campaign: "specialDay",
      campaignId: "sri-yukteswar-birthday-2026",
      type: "question",
      id: "Question",
    };
    if (options.sig !== null) {
      query.sig = options.sig ?? generateClickRedirectSignature(email, targetUrl);
    }

    return createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { host: options.host ?? "luca.ananda.org" },
      query,
    });
  }

  function redirectUrl(res: NextApiResponse): string {
    return (res as any)._getRedirectUrl();
  }

  it("redirects a valid signed link and writes a click record", async () => {
    const targetUrl = "https://luca.ananda.org/?q=test&submit=true";
    const { req, res } = createClickRequest(targetUrl);

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl,
      }),
      {},
      "log email click for test@example.com"
    );
  });

  it("upgrades same-host HTTP redirect URLs to HTTPS when signed", async () => {
    const { req, res } = createClickRequest("http://luca.ananda.org/?q=test&submit=true");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("https://luca.ananda.org/?q=test&submit=true");
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl: "https://luca.ananda.org/?q=test&submit=true",
      }),
      {},
      "log email click for test@example.com"
    );
  });

  it("does not follow a tampered URL and writes no record", async () => {
    const sig = generateClickRedirectSignature("test@example.com", "https://luca.ananda.org/ok");
    const { req, res } = createClickRequest("https://evil.example/phish", { sig });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("does not follow a link with a tampered email and writes no record", async () => {
    const targetUrl = "https://luca.ananda.org/ok";
    const sig = generateClickRedirectSignature("test@example.com", targetUrl);
    const { req, res } = createClickRequest(targetUrl, { email: "other@example.com", sig });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("redirects an unsigned relative path and writes no click record", async () => {
    const targetUrl = "/api/unsubscribe?token=abc";
    const { req, res } = createClickRequest(targetUrl, { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("redirects an unsigned allowlisted host and writes no click record", async () => {
    const targetUrl = "https://luca.ananda.org/ok";
    const { req, res } = createClickRequest(targetUrl, { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("sends an unsigned host that is not allowlisted to the site home", async () => {
    const { req, res } = createClickRequest("https://evil.example/phish", { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("sends an unsigned /%09/evil.example relative target to the site home", async () => {
    const { req, res } = createClickRequest("/%09/evil.example", { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("sends an unsigned /%0a/evil.example relative target to the site home", async () => {
    const { req, res } = createClickRequest("/%0a/evil.example", { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("sends an unsigned /%0d/evil.example relative target to the site home", async () => {
    const { req, res } = createClickRequest("/%0d/evil.example", { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("does not follow a protocol-relative // target and writes no record", async () => {
    const { req, res } = createClickRequest("//evil.example");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("does not follow a backslash target and writes no record", async () => {
    const { req, res } = createClickRequest("\\\\evil");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).not.toMatch(/evil/i);
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("does not follow a javascript: target and writes no record", async () => {
    const { req, res } = createClickRequest("javascript:alert(1)");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toMatch(/javascript:/i);
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("does not follow the raw url when the handler throws", async () => {
    mockGetUsersCollectionName.mockImplementation(() => {
      throw new Error("db boom");
    });
    const targetUrl = "https://evil.example/phish";
    const { req, res } = createClickRequest(targetUrl);

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("evil.example");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("redirects a signed https host outside the allowlist and writes a click record", async () => {
    const targetUrl = "https://newsletter.example/cta";
    const { req, res } = createClickRequest(targetUrl);

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl,
      }),
      {},
      "log email click for test@example.com"
    );
  });

  it("sends a signed http link to a host that is not allowlisted to the site home", async () => {
    const { req, res } = createClickRequest("http://example.com/phishing");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("example.com");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("rejects an unsigned evil-ananda-web-services-projects.vercel.app host", async () => {
    const { req, res } = createClickRequest("https://evil-ananda-web-services-projects.vercel.app/", {
      sig: null,
    });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(redirectUrl(res)).not.toContain("vercel.app");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });

  it("redirects a signed same-site relative path and writes a click record", async () => {
    const targetUrl = "/api/unsubscribe?token=abc";
    const { req, res } = createClickRequest(targetUrl);

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe(targetUrl);
    expect(mockFirestoreSet).toHaveBeenCalled();
  });

  it("keeps rejecting unsigned external HTTP redirect URLs", async () => {
    const { req, res } = createClickRequest("http://example.com/phishing", { sig: null });

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(redirectUrl(res)).toBe("/");
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });
});
