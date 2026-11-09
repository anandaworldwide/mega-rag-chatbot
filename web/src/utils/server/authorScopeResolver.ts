import type { SiteConfig } from "@/types/siteConfig";
import { hasWeightedLibraries } from "@/utils/libraryEntries";
import {
  AuthorScopeDescriptor,
  AuthorScopeHint,
  AuthorScopeMode,
  MASTER_SWAMI_AUTHORS,
} from "@/utils/server/authorConstants";
import { isSiteLibraryBrandToken, isSiteLibraryName } from "@/utils/server/siteLibraryName";
import {
  normalizeAuthorQueryText,
  selectSourceAuthorMatches,
  type AuthorMatch,
} from "@/utils/server/authorMentionIntent";

export type ResolveAuthorScopeInput = {
  question: string;
  scopeHint?: AuthorScopeHint;
  siteConfig?: SiteConfig | null;
  collectionMode: AuthorScopeMode;
  knownAuthors?: string[];
  knownTitles?: string[];
  generatedAliasIndex?: Record<string, string>;
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
  return pattern.test(normalizeAuthorQueryText(text));
}

function siteHasWeightedLibraries(siteConfig?: SiteConfig | null): boolean {
  return hasWeightedLibraries(siteConfig?.includedLibraries);
}

/**
 * Named-author detection must use the current user utterance, not the history-rewritten
 * retrieval query. Rephrase often injects Master/Swami names from prior turns.
 */
export function getAuthorMatchQuestion(
  userUtterance: string | undefined,
  retrievalQuestion: string
): string {
  const utterance = userUtterance?.trim();
  return utterance ? utterance : retrievalQuestion;
}

function addAuthorMatch(matches: AuthorMatch[], seen: Set<string>, author: string, matchedTerm: string): void {
  if (seen.has(author)) {
    return;
  }
  seen.add(author);
  matches.push({ author, matchedTerm });
}

/** Finds every explicitly named author or title in the query (deterministic, conservative). */
export function collectExplicitAuthorMatches(
  question: string,
  siteConfig?: SiteConfig | null,
  knownAuthors: string[] = [],
  knownTitles: string[] = [],
  generatedAliasIndex: Record<string, string> = {}
): AuthorMatch[] {
  const aliases = {
    ...generatedAliasIndex,
    ...(siteConfig?.authorAliases ?? {}),
  };
  const matches: AuthorMatch[] = [];
  const seen = new Set<string>();
  const aliasEntries = Object.entries(aliases).sort(([left], [right]) => right.length - left.length);
  for (const [alias, author] of aliasEntries) {
    if (isSiteLibraryBrandToken(alias) || isSiteLibraryName(author)) {
      continue;
    }
    if (hasWordBoundaryMatch(question, alias)) {
      addAuthorMatch(matches, seen, author, alias);
    }
  }

  const authorCandidates = [...new Set([...knownAuthors, ...MASTER_SWAMI_AUTHORS])].sort(
    (a, b) => b.length - a.length
  );
  for (const author of authorCandidates) {
    if (isSiteLibraryBrandToken(author)) {
      continue;
    }
    if (hasWordBoundaryMatch(question, author)) {
      addAuthorMatch(matches, seen, author, author);
    }
  }

  const titleCandidates = [...knownTitles].sort((a, b) => b.length - a.length);
  for (const title of titleCandidates) {
    if (isSiteLibraryName(title)) {
      continue;
    }
    if (hasWordBoundaryMatch(question, title)) {
      const mappedAuthor = aliases[title.toLowerCase()];
      if (mappedAuthor && !isSiteLibraryName(mappedAuthor)) {
        addAuthorMatch(matches, seen, mappedAuthor, title);
      }
    }
  }

  return matches;
}

/** Finds an explicitly named author or title in the query (deterministic, conservative). */
export function findExplicitAuthorMatch(
  question: string,
  siteConfig?: SiteConfig | null,
  knownAuthors: string[] = [],
  knownTitles: string[] = [],
  generatedAliasIndex: Record<string, string> = {}
): string | null {
  return collectExplicitAuthorMatches(question, siteConfig, knownAuthors, knownTitles, generatedAliasIndex)[0]
    ?.author ?? null;
}

const MIN_MASTER_SWAMI_BOOST = 0;
const MAX_MASTER_SWAMI_BOOST = 1;

/** Clamps configured boost δ to [0, 1] before it is applied to similarity scores. */
export function clampMasterSwamiBoost(boost: number): number {
  if (!Number.isFinite(boost)) {
    return MIN_MASTER_SWAMI_BOOST;
  }
  return Math.min(MAX_MASTER_SWAMI_BOOST, Math.max(MIN_MASTER_SWAMI_BOOST, boost));
}

export function getMasterSwamiBoost(scopeHint: AuthorScopeHint, siteConfig?: SiteConfig | null): number {
  const blend = siteConfig?.authorScopeBlend;
  const rawBoost =
    scopeHint === "broad" ? (blend?.broadMasterSwamiBoost ?? 0.08) : (blend?.masterSwamiBoost ?? 0.2);
  return clampMasterSwamiBoost(rawBoost);
}

export function resolveAuthorScope(input: ResolveAuthorScopeInput): AuthorScopeDescriptor {
  const {
    question,
    scopeHint = "default",
    siteConfig,
    collectionMode,
    knownAuthors = [],
    knownTitles = [],
    generatedAliasIndex = {},
  } = input;

  if (collectionMode === "master_swami") {
    return { kind: "hard", collection: "master_swami" };
  }
  if (collectionMode === "whole_library") {
    return { kind: "hard", collection: "whole_library" };
  }

  const sourceAuthors = selectSourceAuthorMatches(
    question,
    collectExplicitAuthorMatches(question, siteConfig, knownAuthors, knownTitles, generatedAliasIndex)
  );
  if (sourceAuthors.authors.length > 0) {
    return {
      kind: "named",
      author: sourceAuthors.authors[0],
      authors: sourceAuthors.authors,
      sourceMode: sourceAuthors.sourceMode,
    };
  }

  if (siteHasWeightedLibraries(siteConfig)) {
    return { kind: "hard", collection: "master_swami" };
  }

  return {
    kind: "blend",
    masterSwamiBoost: getMasterSwamiBoost(scopeHint, siteConfig),
  };
}
