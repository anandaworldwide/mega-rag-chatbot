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
  return pattern.test(text);
}

function siteHasWeightedLibraries(siteConfig?: SiteConfig | null): boolean {
  return (
    siteConfig?.includedLibraries?.some((entry) => typeof entry === "object" && entry.weight != null) ?? false
  );
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

/** Finds an explicitly named author or title in the query (deterministic, conservative). */
export function findExplicitAuthorMatch(
  question: string,
  siteConfig?: SiteConfig | null,
  knownAuthors: string[] = [],
  knownTitles: string[] = [],
  generatedAliasIndex: Record<string, string> = {}
): string | null {
  const aliases = {
    ...generatedAliasIndex,
    ...(siteConfig?.authorAliases ?? {}),
  };
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

  const explicitAuthor = findExplicitAuthorMatch(
    question,
    siteConfig,
    knownAuthors,
    knownTitles,
    generatedAliasIndex
  );
  if (explicitAuthor) {
    return { kind: "named", author: explicitAuthor };
  }

  if (siteHasWeightedLibraries(siteConfig)) {
    return { kind: "hard", collection: "master_swami" };
  }

  return {
    kind: "blend",
    masterSwamiBoost: getMasterSwamiBoost(scopeHint, siteConfig),
  };
}
