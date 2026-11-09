import type { Document } from "@langchain/core/documents";
import type { VectorStoreRetriever } from "@langchain/core/vectorstores";
import type { LibraryConfigEntry } from "@/types/siteConfig";
import { libraryEntryName } from "@/utils/libraryEntries";
import type { AuthorSourceMode } from "@/utils/server/authorConstants";
import { MASTER_SWAMI_AUTHORS } from "@/utils/server/authorConstants";
import { extractTopicTokens } from "@/utils/server/authorMentionIntent";
import { attachRetrievalScore, filterScoredDocuments, type RelevanceStats } from "@/utils/server/retrievalRelevance";

export function mergeFilterClauses(
  baseFilter: Record<string, unknown> | undefined,
  extraClause: Record<string, unknown>
): Record<string, unknown> {
  if (!baseFilter) {
    return { $and: [extraClause] };
  }
  if ("$and" in baseFilter && Array.isArray(baseFilter.$and)) {
    return {
      ...baseFilter,
      $and: [...(baseFilter.$and as Array<Record<string, unknown>>), extraClause],
    };
  }
  return {
    $and: [baseFilter, extraClause],
  };
}

export function buildMasterSwamiFilter(baseFilter?: Record<string, unknown>): Record<string, unknown> {
  return mergeFilterClauses(baseFilter ?? { $and: [] }, {
    author: { $in: [...MASTER_SWAMI_AUTHORS] },
  });
}

export function buildNamedAuthorFilter(
  author: string,
  baseFilter?: Record<string, unknown>
): Record<string, unknown> {
  return mergeFilterClauses(baseFilter ?? { $and: [] }, {
    author: { $eq: author },
  });
}

export function buildNamedAuthorsFilter(
  authors: string[],
  baseFilter?: Record<string, unknown>
): Record<string, unknown> {
  const unique = [...new Set(authors.map((author) => author.trim()).filter(Boolean))];
  if (unique.length <= 1) {
    return buildNamedAuthorFilter(unique[0] ?? "", baseFilter);
  }
  return mergeFilterClauses(baseFilter ?? { $and: [] }, {
    author: { $in: unique },
  });
}

function isAuthorObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True for a hard query-inferred author `$eq`. Master/Swami `$in` is not this clause. */
export function isNamedAuthorEqClause(clause: unknown): boolean {
  if (!isAuthorObject(clause)) {
    return false;
  }
  const author = clause.author;
  if (!isAuthorObject(author)) {
    return false;
  }
  return typeof author.$eq === "string";
}

function isNamedAuthorInClause(clause: unknown, inferredAuthors?: string[]): boolean {
  if (!inferredAuthors || inferredAuthors.length === 0 || !isAuthorObject(clause)) {
    return false;
  }
  const author = clause.author;
  if (!isAuthorObject(author) || !Array.isArray(author.$in)) {
    return false;
  }
  const inferred = new Set(inferredAuthors);
  return author.$in.every((value) => typeof value === "string" && inferred.has(value));
}

function isDroppableNamedAuthorClause(clause: unknown, inferredAuthors?: string[]): boolean {
  return isNamedAuthorEqClause(clause) || isNamedAuthorInClause(clause, inferredAuthors);
}

/**
 * Removes a query-inferred author `$eq` or matching `$in` from a Pinecone filter.
 * Keeps user-set clauses (type, library, title) and Master/Swami `$in`.
 */
export function dropNamedAuthorClause(
  filter: Record<string, unknown> | undefined,
  inferredAuthors?: string[]
): Record<string, unknown> | undefined {
  if (!filter) {
    return undefined;
  }
  if (isDroppableNamedAuthorClause(filter, inferredAuthors)) {
    return undefined;
  }
  if (!("$and" in filter) || !Array.isArray(filter.$and)) {
    return filter;
  }

  const remaining = (filter.$and as unknown[]).filter(
    (clause) => !isDroppableNamedAuthorClause(clause, inferredAuthors)
  );
  if (remaining.length === filter.$and.length) {
    return filter;
  }
  if (remaining.length === 0) {
    const rest = { ...filter };
    delete rest.$and;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...filter, $and: remaining };
}

export type NamedAuthorFallbackOptions = {
  question?: string;
  authors?: string[];
  sourceMode?: AuthorSourceMode;
};

export type NamedAuthorFallbackResult = {
  documents: Document[];
  relevance: RelevanceStats;
  droppedNamedAuthor: boolean;
  searchFilter: Record<string, unknown> | undefined;
};

export function namedAuthorHitsAreUsable(
  documents: Document[],
  options: NamedAuthorFallbackOptions = {}
): boolean {
  if (options.sourceMode === "strict") {
    return documents.length > 0;
  }
  if (documents.length === 0) {
    return false;
  }
  const topicTokens = extractTopicTokens(options.question ?? "", options.authors ?? []);
  if (topicTokens.length === 0) {
    return true;
  }
  const haystack = documents
    .map((doc) => `${doc.metadata?.title ?? ""} ${doc.pageContent ?? ""}`)
    .join(" ")
    .toLowerCase();
  return topicTokens.some((token) => haystack.includes(token));
}

/**
 * Search with the named-author filter. Preferred mode retries without that author
 * when hits are empty or unusable. Strict `only by` / `only from` does not retry.
 */
export async function retrieveWithNamedAuthorFallback(
  retrieve: (
    filter: Record<string, unknown> | undefined
  ) => Promise<{ documents: Document[]; relevance: RelevanceStats }>,
  namedAuthorFilter: Record<string, unknown>,
  options: NamedAuthorFallbackOptions = {}
): Promise<NamedAuthorFallbackResult> {
  const first = await retrieve(namedAuthorFilter);
  const sourceMode = options.sourceMode ?? "preferred";
  if (sourceMode === "strict" || namedAuthorHitsAreUsable(first.documents, { ...options, sourceMode })) {
    return {
      documents: first.documents,
      relevance: first.relevance,
      droppedNamedAuthor: false,
      searchFilter: namedAuthorFilter,
    };
  }

  const fallbackFilter = dropNamedAuthorClause(namedAuthorFilter, options.authors);
  const second = await retrieve(fallbackFilter);
  return {
    documents: second.documents,
    relevance: second.relevance,
    droppedNamedAuthor: true,
    searchFilter: fallbackFilter,
  };
}

export function buildLibraryFilter(
  libraryNames: string[],
  baseFilter?: Record<string, unknown>
): Record<string, unknown> {
  return mergeFilterClauses(baseFilter ?? { $and: [] }, {
    library: { $in: libraryNames },
  });
}

/**
 * Filter used by mid-answer search_more_sources so it matches initial retrieval constraints
 * (named author / Master-Swami hard scope plus selected libraries).
 */
export function buildRetrievalToolFilter(
  searchFilter: Record<string, unknown> | undefined,
  includedLibraries?: LibraryConfigEntry[]
): Record<string, unknown> | undefined {
  if (!includedLibraries || includedLibraries.length === 0) {
    return searchFilter;
  }
  return buildLibraryFilter(includedLibraries.map(libraryEntryName), searchFilter);
}

/** Mutable capture so makeChain can hand the effective Pinecone filter to RetrievalToolContext. */
export type RetrievalFilterCapture = {
  filter?: Record<string, unknown>;
  inferredAuthor?: string;
  broadenedFromAuthors?: string[];
};

function getDocumentKey(doc: Document): string {
  return (
    doc.id ?? `${doc.metadata?.title ?? ""}:${doc.metadata?.author ?? ""}:${doc.pageContent?.slice(0, 64) ?? ""}`
  );
}

export function dedupeDocuments(documents: Document[], maxCount: number): Document[] {
  const seen = new Set<string>();
  const merged: Document[] = [];

  for (const doc of documents) {
    const key = getDocumentKey(doc);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(doc);
    if (merged.length >= maxCount) {
      break;
    }
  }

  return merged;
}

export function isMasterSwamiAuthor(author: unknown): boolean {
  return typeof author === "string" && (MASTER_SWAMI_AUTHORS as readonly string[]).includes(author);
}

/** Multiplicative score boost for Master/Swami documents: adjustedScore = score × (1 + δ). */
export function applyMasterSwamiScoreBoost(
  results: Array<[Document, number]>,
  masterSwamiBoost: number
): Array<[Document, number]> {
  if (masterSwamiBoost <= 0) {
    return results;
  }

  return results.map(([doc, score]) => {
    if (isMasterSwamiAuthor(doc.metadata?.author)) {
      return [doc, score * (1 + masterSwamiBoost)];
    }
    return [doc, score];
  });
}

export function rankBoostedDocuments(results: Array<[Document, number]>, sourceCount: number): Document[] {
  const sorted = [...results].sort((left, right) => right[1] - left[1]);
  return dedupeDocuments(
    sorted.map(([doc]) => doc),
    sourceCount
  );
}

export type AuthorScopeBlendRetrievalDebug = {
  masterSwamiBoost: number;
  fetchCount: number;
  rankedSamples: Array<{
    author?: string;
    library?: string;
    rawScore: number;
    boostedScore: number;
  }>;
};

function buildBlendRetrievalDebug(
  rawResults: Array<[Document, number]>,
  boostedResults: Array<[Document, number]>,
  documents: Document[],
  masterSwamiBoost: number,
  fetchCount: number
): AuthorScopeBlendRetrievalDebug {
  const rawByKey = new Map(rawResults.map(([doc, score]) => [getDocumentKey(doc), score]));
  const boostedByKey = new Map(boostedResults.map(([doc, score]) => [getDocumentKey(doc), score]));

  return {
    masterSwamiBoost,
    fetchCount,
    rankedSamples: documents.map((doc) => {
      const key = getDocumentKey(doc);
      return {
        author: typeof doc.metadata?.author === "string" ? doc.metadata.author : undefined,
        library: typeof doc.metadata?.library === "string" ? doc.metadata.library : undefined,
        rawScore: rawByKey.get(key) ?? 0,
        boostedScore: boostedByKey.get(key) ?? 0,
      };
    }),
  };
}

export function computeBlendFetchCount(sourceCount: number): number {
  return Math.max(sourceCount * 3, 12);
}

/**
 * Relevance-first retrieval with a multiplicative Master/Swami score boost (B1).
 * One broad similaritySearchWithScore over the scoped filter; M/S docs get score × (1 + δ).
 */
export async function retrieveWithAuthorScopeBlend(
  retriever: VectorStoreRetriever,
  question: string,
  sourceCount: number,
  baseFilter: Record<string, unknown> | undefined,
  masterSwamiBoost: number,
  libraryNames?: string[],
  minRetrievalScore?: number
): Promise<{ documents: Document[]; debug: AuthorScopeBlendRetrievalDebug; relevance: RelevanceStats }> {
  const scopedBase = libraryNames?.length ? buildLibraryFilter(libraryNames, baseFilter) : baseFilter;
  const fetchCount = computeBlendFetchCount(sourceCount);

  const rawResults = await retriever.vectorStore.similaritySearchWithScore(question, fetchCount, scopedBase);
  const rawHitCount = rawResults.length;
  const topScore = rawHitCount > 0 ? Math.max(...rawResults.map(([, score]) => score)) : null;

  const passingResults =
    minRetrievalScore !== undefined
      ? filterScoredDocuments(rawResults, minRetrievalScore).passing
      : rawResults;
  const rejectedLowRelevance = rawHitCount - passingResults.length;

  const boostedResults = applyMasterSwamiScoreBoost(passingResults, masterSwamiBoost);
  const rankedDocuments = rankBoostedDocuments(boostedResults, sourceCount);
  const rawScoreByKey = new Map(passingResults.map(([doc, score]) => [getDocumentKey(doc), score]));
  const documents = rankedDocuments.map((doc) => {
    const rawScore = rawScoreByKey.get(getDocumentKey(doc));
    return rawScore != null ? attachRetrievalScore(doc, rawScore) : doc;
  });

  return {
    documents,
    debug: buildBlendRetrievalDebug(rawResults, boostedResults, documents, masterSwamiBoost, fetchCount),
    relevance: { rawHitCount, rejectedLowRelevance, topScore },
  };
}
