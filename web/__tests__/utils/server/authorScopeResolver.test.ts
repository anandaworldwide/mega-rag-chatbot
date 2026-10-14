/** @jest-environment node */

import {
  findExplicitAuthorMatch,
  clampMasterSwamiBoost,
  getAuthorMatchQuestion,
  getMasterSwamiBoost,
  resolveAuthorScope,
} from "@/utils/server/authorScopeResolver";
import { buildAliasIndex } from "@/utils/server/authorIndex";
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
    expect(findExplicitAuthorMatch("Tell me about meditation topics from Asha's book", baseSiteConfig)).toBe(
      "Asha Nayaswami"
    );
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
    expect(
      findExplicitAuthorMatch("What did Swami Kriyananda teach about devotion?", baseSiteConfig, ["Swami Kriyananda"])
    ).toBe("Swami Kriyananda");
  });

  it("prefers longer alias matches first", () => {
    const configWithOverlappingAliases = {
      ...baseSiteConfig,
      authorAliases: {
        dev: "Wrong Author",
        devi: "Nayaswami Devi Novak",
      },
    } as SiteConfig;

    expect(findExplicitAuthorMatch("What did Devi teach?", configWithOverlappingAliases)).toBe("Nayaswami Devi Novak");
  });

  it("returns null when no author is named", () => {
    expect(findExplicitAuthorMatch("What is meditation?", baseSiteConfig)).toBeNull();
  });

  it("does not treat Ananda Libraries as a named author or title scope", () => {
    const generatedAliasIndex = {
      ananda: "Radio Ananda",
      "ananda libraries": "Radio Ananda",
      "ananda library": "Radio Ananda",
    };

    expect(
      findExplicitAuthorMatch(
        'What is "the Ananda Libraries"?',
        baseSiteConfig,
        ["Ananda", "Radio Ananda"],
        ["Ananda Libraries", "Ananda Library"],
        generatedAliasIndex
      )
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "What sources do you use from the Ananda Libraries?",
        baseSiteConfig,
        ["Ananda"],
        ["Ananda Libraries"],
        { ananda: "Radio Ananda" }
      )
    ).toBeNull();
  });

  it("does not treat the site name Ananda as Radio Ananda", () => {
    const generatedAliasIndex = buildAliasIndex(["Radio Ananda"], {}, "ananda");

    expect(
      findExplicitAuthorMatch(
        "What is the Ananda Spiritual Counseling training program, and who teaches it?",
        baseSiteConfig,
        ["Radio Ananda"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "What does Ananda say about screen time and television for children?",
        baseSiteConfig,
        ["Radio Ananda"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "How do different Ananda teachers explain karma?",
        baseSiteConfig,
        ["Radio Ananda"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
  });

  it("does not map Bhagavad Gita questions to Gita Matlock", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(
      findExplicitAuthorMatch("What is the Bhagavad Gita?", baseSiteConfig, ["Gita Matlock"], [], generatedAliasIndex)
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "What did Master teach about the Bhagavad Gita?",
        baseSiteConfig,
        ["Gita Matlock"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
  });

  it("does not map bare Gita in scripture context to Gita Matlock", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(
      findExplicitAuthorMatch(
        "What does the Gita say about patience?",
        baseSiteConfig,
        ["Gita Matlock"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
  });

  it("still matches Gita Matlock when the person is named", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(
      findExplicitAuthorMatch(
        "What did Gita Matlock teach about devotion?",
        baseSiteConfig,
        ["Gita Matlock"],
        [],
        generatedAliasIndex
      )
    ).toBe("Gita Matlock");
  });

  it("matches Nayaswami Gyandev via an explicit mapping variant", () => {
    const generatedAliasIndex = buildAliasIndex(["Nayaswami Gyandev McCord"], {
      "Nayaswami Gyandev": "Nayaswami Gyandev McCord",
    });

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

  it("does not match a surname from canonical names", () => {
    const generatedAliasIndex = buildAliasIndex(["Nayaswami Devi Novak", "Nayaswami Jyotish Novak"]);

    expect(
      findExplicitAuthorMatch(
        "What did Novak teach?",
        { enableAutoAuthorScope: true } as SiteConfig,
        ["Nayaswami Devi Novak", "Nayaswami Jyotish Novak"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
  });

  it("does not lock a lone first name that is not in site config", () => {
    const generatedAliasIndex = buildAliasIndex(
      ["Gita Matlock", "Nayaswami Gyandev McCord", "Nayaswami Devi Novak"],
      {},
      "ananda"
    );
    const emptyAliasConfig = { enableAutoAuthorScope: true } as SiteConfig;

    expect(
      findExplicitAuthorMatch(
        "What did Gita teach about devotion?",
        emptyAliasConfig,
        ["Gita Matlock", "Nayaswami Gyandev McCord", "Nayaswami Devi Novak"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "What did Gyandev say about mantras?",
        emptyAliasConfig,
        ["Gita Matlock", "Nayaswami Gyandev McCord", "Nayaswami Devi Novak"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
    expect(
      findExplicitAuthorMatch(
        "What did Devi teach about marriage?",
        emptyAliasConfig,
        ["Gita Matlock", "Nayaswami Gyandev McCord", "Nayaswami Devi Novak"],
        [],
        generatedAliasIndex
      )
    ).toBeNull();
  });

  it("locks a full canonical author name", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock", "Nayaswami Gyandev McCord"], {}, "ananda");
    const emptyAliasConfig = { enableAutoAuthorScope: true } as SiteConfig;

    expect(
      findExplicitAuthorMatch(
        "What did Gita Matlock teach about devotion?",
        emptyAliasConfig,
        ["Gita Matlock", "Nayaswami Gyandev McCord"],
        [],
        generatedAliasIndex
      )
    ).toBe("Gita Matlock");
    expect(
      findExplicitAuthorMatch(
        "What did Nayaswami Gyandev McCord say about mantras?",
        emptyAliasConfig,
        ["Gita Matlock", "Nayaswami Gyandev McCord"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Gyandev McCord");
  });

  it("locks a configured author alias", () => {
    const generatedAliasIndex = buildAliasIndex(["Nayaswami Gyandev McCord", "Paramhansa Yogananda"]);
    const configWithAliases = {
      enableAutoAuthorScope: true,
      authorAliases: {
        gyandev: "Nayaswami Gyandev McCord",
        yogananda: "Paramhansa Yogananda",
        master: "Paramhansa Yogananda",
        jyotish: "Nayaswami Jyotish Novak",
      },
    } as SiteConfig;

    expect(
      findExplicitAuthorMatch(
        "What did Gyandev say about mantras?",
        configWithAliases,
        ["Nayaswami Gyandev McCord", "Paramhansa Yogananda"],
        [],
        generatedAliasIndex
      )
    ).toBe("Nayaswami Gyandev McCord");
    expect(
      findExplicitAuthorMatch(
        "What did Yogananda teach about devotion?",
        configWithAliases,
        ["Nayaswami Gyandev McCord", "Paramhansa Yogananda"],
        [],
        generatedAliasIndex
      )
    ).toBe("Paramhansa Yogananda");
    expect(
      findExplicitAuthorMatch(
        "What did Master teach about the Bhagavad Gita?",
        configWithAliases,
        ["Nayaswami Gyandev McCord", "Paramhansa Yogananda", "Gita Matlock"],
        [],
        generatedAliasIndex
      )
    ).toBe("Paramhansa Yogananda");
    expect(findExplicitAuthorMatch("What did Jyotish say about leadership?", configWithAliases)).toBe(
      "Nayaswami Jyotish Novak"
    );
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

describe("getAuthorMatchQuestion", () => {
  it("prefers the current user utterance over the history-rewritten retrieval query", () => {
    expect(
      getAuthorMatchQuestion(
        "How does Kundalini relate to music?",
        "How does Kundalini relate to music according to Paramhansa Yogananda and Swami Kriyananda?"
      )
    ).toBe("How does Kundalini relate to music?");
  });

  it("falls back to the retrieval query when the user utterance is missing", () => {
    expect(getAuthorMatchQuestion(undefined, "What did Asha teach about meditation?")).toBe(
      "What did Asha teach about meditation?"
    );
    expect(getAuthorMatchQuestion("   ", "What did Asha teach about meditation?")).toBe(
      "What did Asha teach about meditation?"
    );
  });
});

describe("resolveAuthorScope", () => {
  it("stays in blend when the question uses the site name Ananda", () => {
    const generatedAliasIndex = buildAliasIndex(["Radio Ananda"], {}, "ananda");

    expect(
      resolveAuthorScope({
        question: "What does Ananda say about screen time and television for children?",
        siteConfig: baseSiteConfig,
        collectionMode: "auto",
        knownAuthors: ["Radio Ananda"],
        generatedAliasIndex,
      })
    ).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });

  it("stays in blend for Bhagavad Gita questions when Gita Matlock is a known author", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(
      resolveAuthorScope({
        question: "What is the Bhagavad Gita?",
        siteConfig: baseSiteConfig,
        collectionMode: "auto",
        knownAuthors: ["Gita Matlock"],
        generatedAliasIndex,
      })
    ).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
    expect(
      resolveAuthorScope({
        question: "What did Master teach about the Bhagavad Gita?",
        siteConfig: baseSiteConfig,
        collectionMode: "auto",
        knownAuthors: ["Gita Matlock"],
        generatedAliasIndex,
      })
    ).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });

  it("returns named scope when Gita Matlock is explicitly named", () => {
    const generatedAliasIndex = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(
      resolveAuthorScope({
        question: "What did Gita Matlock teach about devotion?",
        siteConfig: baseSiteConfig,
        collectionMode: "auto",
        knownAuthors: ["Gita Matlock"],
        generatedAliasIndex,
      })
    ).toEqual({ kind: "named", author: "Gita Matlock" });
  });

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

  it("returns named scope for Gyandev via an explicit mapping variant", () => {
    const result = resolveAuthorScope({
      question: "what did Nayaswami Gyandev say about mantras?",
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
      knownAuthors: ["Nayaswami Gyandev McCord"],
      generatedAliasIndex: buildAliasIndex(["Nayaswami Gyandev McCord"], {
        "Nayaswami Gyandev": "Nayaswami Gyandev McCord",
      }),
    });

    expect(result).toEqual({ kind: "named", author: "Nayaswami Gyandev McCord" });
  });

  it("returns named scope for Anandi on first turn via configured alias", () => {
    const result = resolveAuthorScope({
      question: "what did Anandi say about meditation?",
      siteConfig: {
        ...baseSiteConfig,
        authorAliases: {
          ...baseSiteConfig.authorAliases,
          anandi: "Nayaswami Anandi",
        },
      } as SiteConfig,
      collectionMode: "auto",
      knownAuthors: ["Nayaswami Anandi"],
      generatedAliasIndex: buildAliasIndex(["Nayaswami Anandi"], { "Anandi Cornell": "Nayaswami Anandi" }),
    });

    expect(result).toEqual({ kind: "named", author: "Nayaswami Anandi" });
  });

  it("matches Anandi Cornell variant before bare cornell surname", () => {
    const generatedAliasIndex = buildAliasIndex(["Nayaswami Anandi", "Joseph Bharat Cornell"], {
      "Anandi Cornell": "Nayaswami Anandi",
      "Bharat Cornell": "Joseph Bharat Cornell",
    });

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

  it("still blends when includedLibraries has a wiki object without weight", () => {
    const result = resolveAuthorScope({
      question: "Who is Jairam?",
      siteConfig: {
        ...baseSiteConfig,
        includedLibraries: ["Ananda Library", { name: "Ananda Family Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" }],
      } as SiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });

  it("bypasses blend only when a library has a real weight", () => {
    const result = resolveAuthorScope({
      question: "Who is Jairam?",
      siteConfig: {
        ...baseSiteConfig,
        includedLibraries: [
          { name: "ananda.org", weight: 67 },
          { name: "Crystal Clarity", weight: 33 },
        ],
      } as SiteConfig,
      collectionMode: "auto",
    });

    expect(result).toEqual({ kind: "hard", collection: "master_swami" });
  });

  it("does not hard-filter Master/Swami when only the retrieval rewrite names them", () => {
    const userUtterance = "How does Kundalini relate to music?";
    const retrievalQuery = "How does Kundalini relate to music according to Paramhansa Yogananda and Swami Kriyananda?";
    const result = resolveAuthorScope({
      question: getAuthorMatchQuestion(userUtterance, retrievalQuery),
      siteConfig: baseSiteConfig,
      collectionMode: "auto",
    });

    expect(findExplicitAuthorMatch(retrievalQuery, baseSiteConfig)).toBe("Paramhansa Yogananda");
    expect(result).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });
});
