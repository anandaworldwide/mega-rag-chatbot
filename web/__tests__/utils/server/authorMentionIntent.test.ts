/** @jest-environment node */

import fs from "fs";
import path from "path";
import type { SiteConfig } from "@/types/siteConfig";
import { resolveCanonicalAuthorName } from "@/utils/server/authorIndex";
import {
  classifyAuthorMention,
  extractTopicTokens,
  normalizeAuthorQueryText,
  selectSourceAuthorMatches,
} from "@/utils/server/authorMentionIntent";
import { namedAuthorHitsAreUsable } from "@/utils/server/authorScopeRetrieval";
import { resolveAuthorScope } from "@/utils/server/authorScopeResolver";

const ashaConfig = {
  enableAutoAuthorScope: true,
  authorAliases: {
    asha: "Asha Nayaswami",
    jyotish: "Nayaswami Jyotish Novak",
    yogananda: "Paramhansa Yogananda",
  },
} as SiteConfig;

function loadAnandaConfigAliases(): Record<string, string> {
  const configPath = path.join(process.cwd(), "site-config", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    ananda?: { authorAliases?: Record<string, string> };
  };
  return config.ananda?.authorAliases ?? {};
}

describe("normalizeAuthorQueryText", () => {
  it("maps curly apostrophes to a straight apostrophe", () => {
    expect(normalizeAuthorQueryText("Asha\u2019s example")).toBe("Asha's example");
  });
});

describe("finding 3: Asha as subject vs source", () => {
  const ashaMatch = { author: "Asha Nayaswami", matchedTerm: "asha" };

  it("treats Asha's example as a subject mention for straight and curly apostrophes", () => {
    const straight = "Tell me how Asha's example of discipleship affected people's lives";
    const curly = "Tell me how Asha\u2019s example of discipleship affected people\u2019s lives";
    expect(classifyAuthorMention(straight, ashaMatch).role).toBe("subject");
    expect(classifyAuthorMention(curly, ashaMatch).role).toBe("subject");
    expect(
      resolveAuthorScope({
        question: straight,
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
    expect(
      resolveAuthorScope({
        question: curly,
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({ kind: "blend", masterSwamiBoost: 0.2 });
  });

  it("keeps explicit by/from Asha as preferred source", () => {
    expect(
      resolveAuthorScope({
        question: "What did Asha teach about meditation?",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({
      kind: "named",
      author: "Asha Nayaswami",
      authors: ["Asha Nayaswami"],
      sourceMode: "preferred",
    });
    expect(
      resolveAuthorScope({
        question: "Find articles from Asha about discipleship",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toMatchObject({ kind: "named", author: "Asha Nayaswami", sourceMode: "preferred" });
    expect(
      resolveAuthorScope({
        question: "Quotes by Asha on discipleship",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toMatchObject({ kind: "named", author: "Asha Nayaswami", sourceMode: "preferred" });
  });

  it("keeps only-by Asha as a strict source", () => {
    expect(
      resolveAuthorScope({
        question: "Find passages only by Asha about discipleship",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({
      kind: "named",
      author: "Asha Nayaswami",
      authors: ["Asha Nayaswami"],
      sourceMode: "strict",
    });
  });

  it("locks mixed subject/source to the source author only", () => {
    expect(
      resolveAuthorScope({
        question: "How did Asha's example of discipleship affect people, from Jyotish?",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({
      kind: "named",
      author: "Nayaswami Jyotish Novak",
      authors: ["Nayaswami Jyotish Novak"],
      sourceMode: "preferred",
    });
  });
});

describe("finding 4: OR across named authors", () => {
  it("keeps Jyotish or Asha as an OR source list", () => {
    expect(
      resolveAuthorScope({
        question: "look for articles about karma from Jyotish or Asha",
        siteConfig: ashaConfig,
        collectionMode: "auto",
      })
    ).toEqual({
      kind: "named",
      author: "Nayaswami Jyotish Novak",
      authors: ["Nayaswami Jyotish Novak", "Asha Nayaswami"],
      sourceMode: "preferred",
    });
  });

  it("does not add an author under a negative scope", () => {
    expect(
      selectSourceAuthorMatches("articles from Jyotish, not from Asha", [
        { author: "Nayaswami Jyotish Novak", matchedTerm: "jyotish" },
        { author: "Asha Nayaswami", matchedTerm: "asha" },
      ]).authors
    ).toEqual(["Nayaswami Jyotish Novak"]);
  });
});

describe("finding 2: Yogananda catalog identity", () => {
  it("maps Yogananda to the same catalog author as Paramhansa Yogananda", () => {
    const aliases = loadAnandaConfigAliases();
    expect(aliases.yogananda).toBe("Paramhansa Yogananda");
    expect(resolveCanonicalAuthorName("Yogananda", "ananda")).toBe("Paramhansa Yogananda");
    expect(resolveCanonicalAuthorName("Paramhansa Yogananda", "ananda")).toBe("Paramhansa Yogananda");
    expect(resolveCanonicalAuthorName("Paramahansa Yogananda", "ananda")).toBe("Paramhansa Yogananda");

    const siteConfig = {
      enableAutoAuthorScope: true,
      authorAliases: aliases,
    } as SiteConfig;
    expect(
      resolveAuthorScope({
        question: "What did Yogananda teach about devotion?",
        siteConfig,
        collectionMode: "auto",
      })
    ).toMatchObject({ kind: "named", author: "Paramhansa Yogananda" });
    expect(
      resolveAuthorScope({
        question: "What did Paramhansa Yogananda teach about devotion?",
        siteConfig,
        collectionMode: "auto",
      })
    ).toMatchObject({ kind: "named", author: "Paramhansa Yogananda" });
  });
});

describe("finding 1: unusable preferred hits", () => {
  it("extracts topic tokens after stripping author names", () => {
    expect(extractTopicTokens("What did Asha teach about discipleship", ["Asha Nayaswami"])).toContain(
      "discipleship"
    );
  });

  it("does not treat yoga inside Yogananda or kriya inside Kriyananda as topic evidence", () => {
    const yoganandaKitchen = [
      {
        pageContent: "Kitchen notes and a cooking class schedule.",
        metadata: { author: "Paramhansa Yogananda", title: "Yogananda kitchen notes" },
      },
    ];
    const kriyanandaKitchen = [
      {
        pageContent: "Kitchen notes and a cooking class schedule.",
        metadata: { author: "Swami Kriyananda", title: "Kriyananda kitchen notes" },
      },
    ];
    expect(
      namedAuthorHitsAreUsable(yoganandaKitchen, {
        question: "What did Paramhansa Yogananda teach about yoga",
        authors: ["Paramhansa Yogananda"],
        sourceMode: "preferred",
      })
    ).toBe(false);
    expect(
      namedAuthorHitsAreUsable(kriyanandaKitchen, {
        question: "What did Swami Kriyananda teach about kriya",
        authors: ["Swami Kriyananda"],
        sourceMode: "preferred",
      })
    ).toBe(false);
  });

  it("keeps preferred hits when the question has no remaining topic tokens", () => {
    expect(extractTopicTokens("What did Asha teach", ["Asha Nayaswami"])).toEqual([]);
    expect(
      namedAuthorHitsAreUsable(
        [
          {
            pageContent: "Kitchen notes and a cooking class schedule.",
            metadata: { author: "Asha Nayaswami", title: "Kitchen notes" },
          },
        ],
        {
          question: "What did Asha teach",
          authors: ["Asha Nayaswami"],
          sourceMode: "preferred",
        }
      )
    ).toBe(true);
  });

  it("treats off-topic preferred hits as unusable and keeps strict hits", () => {
    const docs = [
      {
        pageContent: "A cooking class schedule and kitchen notes.",
        metadata: { author: "Asha Nayaswami", title: "Kitchen notes" },
      },
    ];
    expect(
      namedAuthorHitsAreUsable(docs, {
        question: "What did Asha teach about discipleship",
        authors: ["Asha Nayaswami"],
        sourceMode: "preferred",
      })
    ).toBe(false);
    expect(
      namedAuthorHitsAreUsable(docs, {
        question: "Find passages only by Asha about discipleship",
        authors: ["Asha Nayaswami"],
        sourceMode: "strict",
      })
    ).toBe(true);
    expect(
      namedAuthorHitsAreUsable(
        [
          {
            pageContent: "A talk on discipleship and living the teachings.",
            metadata: { author: "Asha Nayaswami", title: "Discipleship talk" },
          },
        ],
        {
          question: "What did Asha teach about discipleship",
          authors: ["Asha Nayaswami"],
          sourceMode: "preferred",
        }
      )
    ).toBe(true);
  });
});
