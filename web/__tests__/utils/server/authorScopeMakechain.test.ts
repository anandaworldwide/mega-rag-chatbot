/** @jest-environment node */

import { isAutoAuthorScopeActive } from "@/utils/server/makechain";
import { buildAliasIndex } from "@/utils/server/authorIndex";
import { resolveAuthorScope } from "@/utils/server/authorScopeResolver";
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

describe("makechain author index wiring contract", () => {
  const autoSiteConfig = {
    siteId: "ananda",
    enableAutoAuthorScope: true,
    authorScopeBlend: {
      masterSwamiBoost: 0.2,
      broadMasterSwamiBoost: 0.08,
    },
    authorAliases: {
      asha: "Asha Nayaswami",
    },
  } as SiteConfig;

  it("resolves Gyandev the same way makechain passes Firestore index into resolveAuthorScope", () => {
    const canonicalAuthors = ["Nayaswami Gyandev McCord", "Nayaswami Devi Novak", "Nayaswami Jyotish Novak"];
    const generatedAliasIndex = buildAliasIndex(canonicalAuthors);

    const result = resolveAuthorScope({
      question: "what did Nayaswami Gyandev say about mantras?",
      scopeHint: "default",
      siteConfig: autoSiteConfig,
      collectionMode: "auto",
      knownAuthors: canonicalAuthors,
      generatedAliasIndex,
    });

    expect(result).toEqual({ kind: "named", author: "Nayaswami Gyandev McCord" });
  });
});
