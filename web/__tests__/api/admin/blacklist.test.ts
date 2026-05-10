import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/admin/blacklist";
import * as authz from "@/utils/server/authz";
import * as genericRateLimiter from "@/utils/server/genericRateLimiter";
import * as blacklistMod from "@/utils/server/blacklist";
import * as loadSiteConfig from "@/utils/server/loadSiteConfig";

const mockGetTokenFromRequest = jest.fn();
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: (h: unknown) => h,
  getTokenFromRequest: (req: unknown) => mockGetTokenFromRequest(req),
}));

jest.mock("@/utils/server/authz");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/blacklist", () => ({
  getBlacklistText: jest.fn(),
  setBlacklistText: jest.fn(),
  parseBlacklistContent: jest.requireActual("@/utils/server/blacklist").parseBlacklistContent,
  validateBlacklistContent: jest.requireActual("@/utils/server/blacklist").validateBlacklistContent,
}));
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const mockRequireSuperuser = authz.requireSuperuserRoleFromFirestore as jest.MockedFunction<
  typeof authz.requireSuperuserRoleFromFirestore
>;
const mockRate = genericRateLimiter.genericRateLimiter as jest.MockedFunction<
  typeof genericRateLimiter.genericRateLimiter
>;
const mockGetText = blacklistMod.getBlacklistText as jest.MockedFunction<typeof blacklistMod.getBlacklistText>;
const mockSetText = blacklistMod.setBlacklistText as jest.MockedFunction<typeof blacklistMod.setBlacklistText>;
const mockLoadSync = loadSiteConfig.loadSiteConfigSync as jest.MockedFunction<
  typeof loadSiteConfig.loadSiteConfigSync
>;

describe("/api/admin/blacklist", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SITE_ID: "login-site" };
    mockRate.mockResolvedValue(true as never);
    mockRequireSuperuser.mockResolvedValue(undefined);
    mockLoadSync.mockReturnValue({ requireLogin: true } as never);
    mockGetTokenFromRequest.mockReturnValue({ client: "web", email: "admin@example.com" });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 403 when site does not require login", async () => {
    mockLoadSync.mockReturnValue({ requireLogin: false } as never);
    const { req, res } = createMocks({ method: "GET" });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(JSON.parse(res._getData()).error).toBe("Blacklist is not enabled for this site");
  });

  it("returns 403 when login site disables email blacklist", async () => {
    mockLoadSync.mockReturnValue({ requireLogin: true, enableEmailBlacklist: false } as never);
    const { req, res } = createMocks({ method: "GET" });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect(JSON.parse(res._getData()).error).toBe("Blacklist is not enabled for this site");
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it("returns 403 for non-superuser", async () => {
    mockRequireSuperuser.mockRejectedValue(new Error("Unauthorized: Superuser privileges required"));
    const { req, res } = createMocks({ method: "GET" });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
  });

  it("GET returns blacklist payload", async () => {
    mockGetText.mockResolvedValue({
      text: "a@b.com\n",
      emails: ["a@b.com"],
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const { req, res } = createMocks({ method: "GET" });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getData());
    expect(body.text).toBe("a@b.com\n");
    expect(body.emailCount).toBe(1);
    expect(mockGetText).toHaveBeenCalledWith("login-site");
  });

  it("PUT validates body and saves", async () => {
    mockSetText.mockResolvedValue({ text: "x@y.com\n", emails: ["x@y.com"] });
    const { req, res } = createMocks({
      method: "PUT",
      body: { text: "x@y.com" },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSetText).toHaveBeenCalledWith("x@y.com", "login-site");
  });

  it("returns 405 for unsupported method", async () => {
    const { req, res } = createMocks({ method: "DELETE" });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
  });

  it("PUT rejects malformed lines with line-level details", async () => {
    const { req, res } = createMocks({
      method: "PUT",
      body: { text: "good@x.com\nnot-an-email\n# comment\n\nalso bad\n" },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    const body = JSON.parse(res._getData());
    expect(body.error).toBe("Invalid blacklist content");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.map((d: { line: number }) => d.line)).toEqual([2, 5]);
    expect(mockSetText).not.toHaveBeenCalled();
  });

  it("PUT accepts comments and blank lines alongside valid emails", async () => {
    mockSetText.mockResolvedValue({ text: "a@b.com\n", emails: ["a@b.com"] });
    const { req, res } = createMocks({
      method: "PUT",
      body: { text: "# header comment\n\na@b.com\n  # indented\n\n" },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(mockSetText).toHaveBeenCalled();
  });

  it("PUT rejects when caller tries to blacklist their own email", async () => {
    mockGetTokenFromRequest.mockReturnValue({ client: "web", email: "admin@example.com" });
    const { req, res } = createMocks({
      method: "PUT",
      body: { text: "  ADMIN@example.com  \nother@x.com\n" },
    });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData()).error).toMatch(/your own email/i);
    expect(mockSetText).not.toHaveBeenCalled();
  });
});
