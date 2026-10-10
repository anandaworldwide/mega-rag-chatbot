/** @jest-environment node */

import bundledSiteConfigs from "../../../site-config/config.json";
import { applyLibraryAccessGate } from "@/utils/server/libraryAccess";
import { buildLibraryFilter } from "@/utils/server/authorScopeRetrieval";
import { warnAutoAuthorScopeConfigConflict } from "@/utils/server/loadSiteConfig";
import { calculateSources, planLibraryRetrieval } from "@/utils/server/ragDocumentUtils";
import type { SiteConfig } from "@/types/siteConfig";
import {
  hasWeightedLibraries,
  libraryEntryName,
  normalizeLibraryEntries,
} from "@/utils/libraryEntries";
import type { LibraryConfigEntry } from "@/types/siteConfig";

const lucaLibraries = bundledSiteConfigs.ananda.includedLibraries as LibraryConfigEntry[];
const anandaPublicLibraries = bundledSiteConfigs["ananda-public"].includedLibraries as LibraryConfigEntry[];
const lucaSourceCount = bundledSiteConfigs.ananda.defaultNumSources ?? 4;
const anandaPublicSourceCount = bundledSiteConfigs["ananda-public"].defaultNumSources ?? 4;

const LUCA_LIBRARY_NAMES = [
  "Ananda Library",
  "Ananda Youtube",
  "Treasures",
  "The Bhaktan Files",
  "ananda.org",
  "Crystal Clarity",
  "Ananda Family Wiki",
];

describe("library retrieval planning", () => {
  const originalWikiEmails = process.env.WIKI_LIBRARY_EMAILS;

  afterEach(() => {
    if (originalWikiEmails === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = originalWikiEmails;
    }
  });

  test("hasWeightedLibraries is false for objects that only have accessEmailsEnv", () => {
    expect(hasWeightedLibraries(lucaLibraries)).toBe(false);
    expect(hasWeightedLibraries(anandaPublicLibraries)).toBe(true);
    expect(hasWeightedLibraries([{ name: "Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" }])).toBe(false);
    expect(hasWeightedLibraries([{ name: "Weighted", weight: 2 }])).toBe(true);
    expect(hasWeightedLibraries(["plain", { name: "also-plain" }])).toBe(false);
  });

  test("normalizeLibraryEntries never leaves name undefined for mixed string and object entries", () => {
    const normalized = normalizeLibraryEntries(lucaLibraries);
    expect(normalized.map((entry) => entry.name)).toEqual(LUCA_LIBRARY_NAMES);
    expect(normalized.every((entry) => typeof entry.name === "string" && entry.name.length > 0)).toBe(true);
    expect(normalized[normalized.length - 1]).toEqual({ name: "Ananda Family Wiki" });
    expect(normalized.some((entry) => "weight" in entry && entry.weight != null)).toBe(false);
  });

  test("Luca's real config.json uses one unweighted Pinecone query with all 7 libraries and the normal source count", () => {
    expect(lucaLibraries).toEqual([
      "Ananda Library",
      "Ananda Youtube",
      "Treasures",
      "The Bhaktan Files",
      "ananda.org",
      "Crystal Clarity",
      { name: "Ananda Family Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" },
    ]);
    expect(lucaSourceCount).toBe(4);

    const plan = planLibraryRetrieval(lucaLibraries, lucaSourceCount);
    expect(plan).toEqual({
      mode: "unweighted",
      libraryNames: LUCA_LIBRARY_NAMES,
      sourceCount: 4,
    });

    const filter = buildLibraryFilter(plan.mode === "unweighted" ? plan.libraryNames : [], undefined);
    const libraryClause = (filter.$and as Array<Record<string, unknown>>).find((clause) => "library" in clause);
    expect(libraryClause).toEqual({ library: { $in: LUCA_LIBRARY_NAMES } });
    expect(plan.mode === "unweighted" && plan.libraryNames.includes("Ananda Family Wiki")).toBe(true);

    // The old object-means-weighted path split 4 sources across 7 libraries and left wiki at 0.
    const buggyAllocation = calculateSources(lucaSourceCount, lucaLibraries);
    expect(buggyAllocation.find((entry) => entry.name === "Ananda Family Wiki")?.sources).toBe(0);
  });

  test("a config with real weights still uses weighted allocation exactly as before", () => {
    expect(anandaPublicLibraries).toEqual([
      { name: "ananda.org", weight: 67 },
      { name: "Crystal Clarity", weight: 33 },
    ]);
    expect(anandaPublicSourceCount).toBe(6);

    const plan = planLibraryRetrieval(anandaPublicLibraries, anandaPublicSourceCount);
    expect(plan.mode).toBe("weighted");
    if (plan.mode !== "weighted") {
      throw new Error("expected weighted plan");
    }
    expect(plan.allocations).toEqual([
      { name: "ananda.org", sources: 4 },
      { name: "Crystal Clarity", sources: 2 },
    ]);
    expect(plan.allocations).toEqual(calculateSources(anandaPublicSourceCount, anandaPublicLibraries));
    expect(plan.allocations.reduce((sum, entry) => sum + entry.sources, 0)).toBe(6);
  });

  test("an allowed user includes the wiki and a non-allowed user excludes it while the other libraries keep the same allocation", () => {
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
    const siteConfig = { includedLibraries: lucaLibraries };

    const allowed = applyLibraryAccessGate(siteConfig, "allowed@ananda.org", undefined);
    const denied = applyLibraryAccessGate(siteConfig, "visitor@ananda.org", undefined);

    const allowedPlan = planLibraryRetrieval(allowed.siteConfig.includedLibraries, lucaSourceCount);
    const deniedPlan = planLibraryRetrieval(denied.siteConfig.includedLibraries, lucaSourceCount);

    expect(allowedPlan.mode).toBe("unweighted");
    expect(deniedPlan.mode).toBe("unweighted");
    if (allowedPlan.mode !== "unweighted" || deniedPlan.mode !== "unweighted") {
      throw new Error("expected unweighted plans");
    }

    expect(allowedPlan.libraryNames).toEqual(LUCA_LIBRARY_NAMES);
    expect(deniedPlan.libraryNames).toEqual(LUCA_LIBRARY_NAMES.filter((name) => name !== "Ananda Family Wiki"));
    expect(allowedPlan.sourceCount).toBe(4);
    expect(deniedPlan.sourceCount).toBe(4);

    const publicFromAllowed = allowedPlan.libraryNames.filter((name) => name !== "Ananda Family Wiki");
    expect(deniedPlan.libraryNames).toEqual(publicFromAllowed);
    expect(publicFromAllowed).toEqual(denied.siteConfig.includedLibraries?.map(libraryEntryName));
  });

  test("a wiki object without weight does not trip the auto-author-scope weighted-library warning", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnAutoAuthorScopeConfigConflict({
        siteId: "ananda",
        enableAutoAuthorScope: true,
        includedLibraries: lucaLibraries,
      } as SiteConfig);
      expect(warn).not.toHaveBeenCalled();

      warn.mockClear();
      warnAutoAuthorScopeConfigConflict({
        siteId: "ananda-public",
        enableAutoAuthorScope: true,
        includedLibraries: anandaPublicLibraries,
      } as SiteConfig);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("enableAutoAuthorScope=true"));
    } finally {
      warn.mockRestore();
    }
  });
});
