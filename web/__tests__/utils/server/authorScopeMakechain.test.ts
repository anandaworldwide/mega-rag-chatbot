/** @jest-environment node */

import { isAutoAuthorScopeActive } from "@/utils/server/makechain";
import type { SiteConfig } from "@/types/siteConfig";

const autoSiteConfig = {
  siteId: "ananda",
  enableAutoAuthorScope: true,
} as SiteConfig;

describe("isAutoAuthorScopeActive", () => {
  it("is true only when flag is on and collection is auto", () => {
    expect(isAutoAuthorScopeActive(autoSiteConfig, "auto")).toBe(true);
    expect(isAutoAuthorScopeActive(autoSiteConfig, undefined)).toBe(false);
    expect(isAutoAuthorScopeActive(autoSiteConfig, "whole_library")).toBe(false);
    expect(isAutoAuthorScopeActive(autoSiteConfig, "master_swami")).toBe(false);
    expect(isAutoAuthorScopeActive({ ...autoSiteConfig, enableAutoAuthorScope: false }, "auto")).toBe(false);
  });

  it("does not activate for a site that has not enabled auto author scope", () => {
    const nonAutoSite = { siteId: "crystal", enableAutoAuthorScope: false } as SiteConfig;
    // Even if a stray collection="auto" arrives, the gate stays false so blend is never triggered.
    expect(isAutoAuthorScopeActive(nonAutoSite, "auto")).toBe(false);
  });
});
