/**
 * Public page and endpoint checks for the answers list.
 */

import { isPublicEndpoint, isPublicPage } from "@/utils/client/authConfig";
import { PUBLIC_PATHS } from "@/config/publicPaths";
import { SiteConfig } from "@/types/siteConfig";

const noLoginConfig = { requireLogin: false } as SiteConfig;
const loginConfig = { requireLogin: true } as SiteConfig;

describe("authConfig answers list access", () => {
  it("keeps /api/answers out of always-public APIs", () => {
    expect(PUBLIC_PATHS.alwaysPublicApis).not.toContain("/api/answers");
    expect(PUBLIC_PATHS.noLoginPublicApis).toContain("/api/answers");
    expect(PUBLIC_PATHS.noLoginPublicPages).toContain("/answers");
  });

  it("treats GET /api/answers as public on no-login sites", () => {
    expect(isPublicEndpoint("/api/answers", "GET", noLoginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/answers?page=1", "GET", noLoginConfig)).toBe(true);
  });

  it("refuses GET /api/answers as a public endpoint on login-required sites", () => {
    expect(isPublicEndpoint("/api/answers", "GET", loginConfig)).toBe(false);
    expect(isPublicEndpoint("/api/answers", "GET", null)).toBe(false);
    expect(isPublicEndpoint("/api/answers", "GET")).toBe(false);
  });

  it("does not treat DELETE /api/answers as public on no-login sites", () => {
    expect(isPublicEndpoint("/api/answers", "DELETE", noLoginConfig)).toBe(false);
  });

  it("treats /answers as a public page on no-login sites", () => {
    expect(isPublicPage("/answers", noLoginConfig)).toBe(true);
  });

  it("does not treat /answers as a public page on login-required sites", () => {
    expect(isPublicPage("/answers", loginConfig)).toBe(false);
  });
});
