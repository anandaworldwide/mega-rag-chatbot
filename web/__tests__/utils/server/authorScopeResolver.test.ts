/** @jest-environment node */

import { findExplicitAuthorMatch, resolveAuthorScope } from "@/utils/server/authorScopeResolver";
import type { SiteConfig } from "@/types/siteConfig";

const baseSiteConfig = {
  enableAutoAuthorScope: true,
  authorScopeBlend: {
    masterSwamiWeight: 0.7,
    broadMasterSwamiWeight: 0.3,
  },
  authorAliases: {
    asha: "Asha Nayaswami",
    devi: "Devi Novak",
    jyotish: "Jyotish Novak",
  },
} as SiteConfig;

describe("findExplicitAuthorMatch", () => {
  it("matches author aliases in the query", () => {
    expect(
      findExplicitAuthorMatch("Tell me about meditation topics from Asha's book", baseSiteConfig)
    ).toBe("Asha Nayaswami");
  });

  it("matches Jyotish via alias even when Nayaswami appears in the full name", () => {
    expect(findExplicitAuthorMatch("What did Jyotish Nayaswami teach about leadership?", baseSiteConfig)).toBe(
      "Jyotish Novak"
    );
  });

  it("does not map bare Nayaswami to Asha", () => {
    expect(findExplicitAuthorMatch("Tell me about Nayaswami ministers in general", baseSiteConfig)).toBeNull();
  });

  it("does not map lightbearer entitlement language to an author", () => {
    expect(findExplicitAuthorMatch("I'm a lightbearer, what content can I access?", baseSiteConfig)).toBeNull();
  });

  it("matches known author names directly", () => {
    expect(findExplicitAuthorMatch("What did Swami Kriyananda teach about devotion?", baseSiteConfig, [
      "Swami Kriyananda",
    ])).toBe("Swami Kriyananda");
  });

  it("prefers longer alias matches first", () => {
    const configWithOverlappingAliases = {
      ...baseSiteConfig,
      authorAliases: {
        dev: "Wrong Author",
        devi: "Devi Novak",
      },
    } as SiteConfig;

    expect(findExplicitAuthorMatch("What did Devi teach?", configWithOverlappingAliases)).toBe("Devi Novak");
  });

  it("returns null when no author is named", () => {
    expect(findExplicitAuthorMatch("What is meditation?", baseSiteConfig)).toBeNull();
  });
});

describe("resolveAuthorScope", () => {
  it("returns blend with default weight for auto mode", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      scopeHint: "default",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "blend", masterSwamiWeight: 0.7 });
  });

  it("returns blend with broad weight when scope hint is broad", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      scopeHint: "broad",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "blend", masterSwamiWeight: 0.3 });
  });

  it("returns named scope when Asha is explicitly mentioned", () => {
    const result = resolveAuthorScope({
      question: "Topics from Asha about meditation",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "named", author: "Asha Nayaswami" });
  });

  it("returns hard master_swami when user explicitly selects that collection", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      siteConfig: baseSiteConfig,
      collectionMode: "master_swami",
    });

    expect(result).toEqual({ kind: "hard", collection: "master_swami" });
  });

  it("returns hard whole_library when user explicitly selects all authors", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      siteConfig: baseSiteConfig,
      collectionMode: "whole_library",
    });

    expect(result).toEqual({ kind: "hard", collection: "whole_library" });
  });
});
