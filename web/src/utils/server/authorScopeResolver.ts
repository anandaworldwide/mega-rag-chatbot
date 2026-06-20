import type { SiteConfig } from "@/types/siteConfig";
import {
  AuthorScopeDescriptor,
  AuthorScopeHint,
  AuthorScopeMode,
  MASTER_SWAMI_AUTHORS,
} from "@/utils/server/authorConstants";

export type ResolveAuthorScopeInput = {
  question: string;
  scopeHint?: AuthorScopeHint;
  siteConfig?: SiteConfig | null;
  collectionMode: AuthorScopeMode;
  knownAuthors?: string[];
  knownTitles?: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundaryMatch(text: string, term: string): boolean {
  const normalizedTerm = term.trim();
  if (!normalizedTerm) {
    return false;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "i");
  return pattern.test(text);
}

function siteHasWeightedLibraries(siteConfig?: SiteConfig | null): boolean {
  return (
    siteConfig?.includedLibraries?.some((entry) => typeof entry === "object" && entry.weight != null) ?? false
  );
}

/** Finds an explicitly named author or title in the query (deterministic, conservative). */
export function findExplicitAuthorMatch(
  question: string,
  siteConfig?: SiteConfig | null,
  knownAuthors: string[] = [],
  knownTitles: string[] = []
): string | null {
  const aliases = siteConfig?.authorAliases ?? {};
  const aliasEntries = Object.entries(aliases).sort(([left], [right]) => right.length - left.length);
  for (const [alias, author] of aliasEntries) {
    if (hasWordBoundaryMatch(question, alias)) {
      return author;
    }
  }

  const authorCandidates = [...new Set([...knownAuthors, ...MASTER_SWAMI_AUTHORS])].sort(
    (a, b) => b.length - a.length
  );
  for (const author of authorCandidates) {
    if (hasWordBoundaryMatch(question, author)) {
      return author;
    }
  }

  const titleCandidates = [...knownTitles].sort((a, b) => b.length - a.length);
  for (const title of titleCandidates) {
    if (hasWordBoundaryMatch(question, title)) {
      const mappedAuthor = aliases[title.toLowerCase()];
      if (mappedAuthor) {
        return mappedAuthor;
      }
    }
  }

  return null;
}

export function getDefaultMasterSwamiWeight(
  scopeHint: AuthorScopeHint,
  siteConfig?: SiteConfig | null
): number {
  const blend = siteConfig?.authorScopeBlend;
  if (scopeHint === "broad") {
    return blend?.broadMasterSwamiWeight ?? 0.3;
  }
  return blend?.masterSwamiWeight ?? 0.7;
}

export function resolveAuthorScope(input: ResolveAuthorScopeInput): AuthorScopeDescriptor {
  const { question, scopeHint = "default", siteConfig, collectionMode, knownAuthors = [], knownTitles = [] } =
    input;

  if (collectionMode === "master_swami") {
    return { kind: "hard", collection: "master_swami" };
  }
  if (collectionMode === "whole_library") {
    return { kind: "hard", collection: "whole_library" };
  }

  const explicitAuthor = findExplicitAuthorMatch(question, siteConfig, knownAuthors, knownTitles);
  if (explicitAuthor) {
    return { kind: "named", author: explicitAuthor };
  }

  if (siteHasWeightedLibraries(siteConfig)) {
    return { kind: "hard", collection: "master_swami" };
  }

  return {
    kind: "blend",
    masterSwamiWeight: getDefaultMasterSwamiWeight(scopeHint, siteConfig),
  };
}
