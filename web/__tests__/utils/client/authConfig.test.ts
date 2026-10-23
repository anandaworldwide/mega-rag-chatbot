/**
 * Public page and endpoint checks for the answers list.
 */

import { isPublicEndpoint, isPublicPage } from "@/utils/client/authConfig";
import { PUBLIC_PATHS } from "@/config/publicPaths";
import { SiteConfig } from "@/types/siteConfig";

const noLoginConfig = { requireLogin: false } as SiteConfig;
const loginConfig = { requireLogin: true } as SiteConfig;

describe("authConfig answers list access", () => {
  it("keeps the answers list and viewer password paths in always-public lists", () => {
    expect(PUBLIC_PATHS.alwaysPublicPages).toContain("/answers");
    expect(PUBLIC_PATHS.alwaysPublicApis).toContain("/api/answers");
    expect(PUBLIC_PATHS.alwaysPublicApis).toContain("/api/answers/viewer");
    expect(PUBLIC_PATHS.noLoginPublicApis).not.toContain("/api/answers");
    expect(PUBLIC_PATHS.noLoginPublicPages).not.toContain("/answers");
  });

  it("treats GET /api/answers as public on login and no-login sites", () => {
    expect(isPublicEndpoint("/api/answers", "GET", noLoginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/answers?page=1", "GET", noLoginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/answers", "GET", loginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/answers", "GET", null)).toBe(true);
  });

  it("treats POST /api/answers/viewer as public on login and no-login sites", () => {
    expect(isPublicEndpoint("/api/answers/viewer", "POST", noLoginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/answers/viewer", "POST", loginConfig)).toBe(true);
  });

  it("does not treat DELETE /api/answers as public on either site type", () => {
    expect(isPublicEndpoint("/api/answers", "DELETE", noLoginConfig)).toBe(false);
    expect(isPublicEndpoint("/api/answers", "DELETE", loginConfig)).toBe(false);
  });

  it("treats /answers as a public page on login and no-login sites", () => {
    expect(isPublicPage("/answers", noLoginConfig)).toBe(true);
    expect(isPublicPage("/answers", loginConfig)).toBe(true);
  });

  it("treats POST /api/clone-conversation as public so the share page can reach the handler", () => {
    expect(PUBLIC_PATHS.alwaysPublicApis).toContain("/api/clone-conversation");
    expect(isPublicEndpoint("/api/clone-conversation", "POST", noLoginConfig)).toBe(true);
    expect(isPublicEndpoint("/api/clone-conversation", "POST", loginConfig)).toBe(true);
  });
});
