/** @jest-environment node */

import { findExplicitAuthorMatch, clampMasterSwamiBoost, getMasterSwamiBoost, resolveAuthorScope } from "@/utils/server/authorScopeResolver";
import type { SiteConfig } from "@/types/siteConfig";

const baseSiteConfig = {
  enableAutoAuthorScope: true,
  authorScopeBlend: {
    masterSwamiBoost: 0.2,
    broadMasterSwamiBoost: 0.08,
  },
  authorAliases: {
    asha: "Asha Nayaswami",
    devi: "Nayaswami Devi Novak",
    jyotish: "Nayaswami Jyotish Novak",
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
      "Nayaswami Jyotish Novak"
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
        devi: "Nayaswami Devi Novak",
      },
    } as SiteConfig;

    expect(findExplicitAuthorMatch("What did Devi teach?", configWithOverlappingAliases)).toBe(
      "Nayaswami Devi Novak"
    );
  });

  it("returns null when no author is named", () => {
    expect(findExplicitAuthorMatch("What is meditation?", baseSiteConfig)).toBeNull();
  });

  it("matches Gyandev via generated alias index", () => {
    const generatedAliasIndex = {
      gyandev: "Nayaswami Gyandev McCord",
      "gyandev mccord": "Nayaswami Gyandev McCord",
    };

    expect(
      findExplicitAuthorMatch(
        "what did Nayaswami Gyandev say about mantras?",
        baseSiteConfig,
        ["Nayaswami Gyandev McCord"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Gyandev McCord");
  });

  it("does not match ambiguous Novak surname from generated index", () => {
    const generatedAliasIndex = {
      devi: "Nayaswami Devi Novak",
      jyotish: "Nayaswami Jyotish Novak",
    };

    expect(
      findExplicitAuthorMatch("What did Novak teach?", baseSiteConfig, ["Nayaswami Devi Novak", "Nayaswami Jyotish Novak"], [], generatedAliasIndex)
    ).toBeNull();
  });

  it("matches first names via generated alias index", () => {
    const generatedAliasIndex = {
      devi: "Nayaswami Devi Novak",
      jyotish: "Nayaswami Jyotish Novak",
    };

    expect(
      findExplicitAuthorMatch(
        "What did Devi teach about marriage?",
        { enableAutoAuthorScope: true } as SiteConfig,
        ["Nayaswami Devi Novak", "Nayaswami Jyotish Novak", "Devi Mukherjee"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Devi Novak");

    expect(
      findExplicitAuthorMatch(
        "What did Jyotish say about leadership?",
        { enableAutoAuthorScope: true } as SiteConfig,
        ["Nayaswami Devi Novak", "Nayaswami Jyotish Novak"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Jyotish Novak");
  });

  it("prefers manual authorAliases over generated alias index on conflict", () => {
    const generatedAliasIndex = {
      asha: "Wrong Asha Author",
    };

    expect(
      findExplicitAuthorMatch("Topics from Asha about meditation", baseSiteConfig, [], [], generatedAliasIndex)
    ).toBe("Asha Nayaswami");
  });
});

describe("getMasterSwamiBoost", () => {
  it("returns default and broad boost values from config", () => {
    expect(getMasterSwamiBoost("default", baseSiteConfig)).toBe(0.2);
    expect(getMasterSwamiBoost("broad", baseSiteConfig)).toBe(0.08);
  });

  it("falls back to built-in defaults when config is missing", () => {
    expect(getMasterSwamiBoost("default", null)).toBe(0.2);
    expect(getMasterSwamiBoost("broad", null)).toBe(0.08);
  });

  it("clamps configured boost values to the range 0..1", () => {
    const extremeConfig = {
      ...baseSiteConfig,
      authorScopeBlend: {
        masterSwamiBoost: 5,
        broadMasterSwamiBoost: -0.5,
      },
    } as SiteConfig;

    expect(getMasterSwamiBoost("default", extremeConfig)).toBe(1);
    expect(getMasterSwamiBoost("broad", extremeConfig)).toBe(0);
  });
});

describe("clampMasterSwamiBoost", () => {
  it("returns 0 for non-finite values", () => {
    expect(clampMasterSwamiBoost(Number.NaN)).toBe(0);
    expect(clampMasterSwamiBoost(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("resolveAuthorScope", () => {
  it("returns blend with default boost for auto mode", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      scopeHint: "default",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });

  it("returns blend with lower boost when scope hint is broad", () => {
    const result = resolveAuthorScope({
      question: "What is meditation?",
      scopeHint: "broad",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "blend", masterSwamiBoost: 0.08 });
  });

  it("returns named scope when Asha is explicitly mentioned", () => {
    const result = resolveAuthorScope({
      question: "Topics from Asha about meditation",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "named", author: "Asha Nayaswami" });
  });

  it("returns named scope for Gyandev via generated alias index", () => {
    const result = resolveAuthorScope({
      question: "what did Nayaswami Gyandev say about mantras?",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
      knownAuthors: ["Nayaswami Gyandev McCord"],
      generatedAliasIndex: {
        gyandev: "Nayaswami Gyandev McCord",
        "gyandev mccord": "Nayaswami Gyandev McCord",
      },
    });

    expect(result).toEqual({ kind: "named", author: "Nayaswami Gyandev McCord" });
  });

  it("returns named scope for Anandi on first turn after variant merge", () => {
    const result = resolveAuthorScope({
      question: "what did Anandi say about meditation?",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
      knownAuthors: ["Nayaswami Anandi"],
      generatedAliasIndex: {
        anandi: "Nayaswami Anandi",
        "nayaswami anandi": "Nayaswami Anandi",
        "anandi cornell": "Nayaswami Anandi",
      },
    });

    expect(result).toEqual({ kind: "named", author: "Nayaswami Anandi" });
  });

  it("matches Anandi Cornell variant before bare cornell surname", () => {
    const generatedAliasIndex = {
      anandi: "Nayaswami Anandi",
      "anandi cornell": "Nayaswami Anandi",
      "bharat cornell": "Joseph Bharat Cornell",
    };

    expect(
      findExplicitAuthorMatch(
        "what did anandi Cornell say about anger?",
        baseSiteConfig,
        ["Nayaswami Anandi", "Joseph Bharat Cornell"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Anandi");
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
