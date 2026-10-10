import type { Document } from "@langchain/core/documents";
import type { SiteConfig } from "@/types/siteConfig";

export type RelevanceStats = {
  rawHitCount: number;
  rejectedLowRelevance: number;
  topScore: number | null;
};

export type RelevanceSearchResult = RelevanceStats & {
  documents: Document[];
};

export type ScoredVectorStore = {
  similaritySearchWithScore(
    query: string,
    k: number,
    filter?: Record<string, unknown>
  ): Promise<Array<[Document, number]>>;
};

export type NoSourcesReason = "empty" | "low_relevance";

function getDocumentKey(doc: Document): string {
  return (
    doc.id ?? `${doc.metadata?.title ?? ""}:${doc.metadata?.author ?? ""}:${doc.pageContent?.slice(0, 64) ?? ""}`
  );
}

/** Clamps configured cutoff to [0, 1]. Non-finite values become NaN for caller handling. */
export function clampMinRetrievalScore(score: number): number {
  if (!Number.isFinite(score)) {
    return Number.NaN;
  }
  return Math.min(1, Math.max(0, score));
}

export function getMinRetrievalScore(siteConfig?: SiteConfig | null): number | undefined {
  const score = siteConfig?.minRetrievalScore;
  if (score == null || !Number.isFinite(score)) {
    return undefined;
  }
  const clamped = clampMinRetrievalScore(score);
  // Treat 0 (or any non-positive / clamped-to-zero value) as "disabled": every cosine score
  // is >= 0, so a floor of 0 would never reject anything and only adds overhead.
  if (!Number.isFinite(clamped) || clamped <= 0) {
    return undefined;
  }
  return clamped;
}

/** True for a positive title `$eq` / `$in`. `$ne`, `$nin`, and bare values do not count. */
function isPositiveTitleMatch(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const match = value as Record<string, unknown>;
  if (typeof match.$eq === "string" && match.$eq.length > 0) {
    return true;
  }
  return Array.isArray(match.$in) && match.$in.length > 0 && match.$in.every((item) => typeof item === "string");
}

/**
 * True when the filter that Pinecone will run already restricts by title.
 * Walks only the top level and `$and` so merged author/library clauses do not hide
 * a required title term. A title clause only inside `$or` is not a hard restriction.
 * A display label alone is not enough: if catalog load fails, no title clause is added.
 */
export function pineconeFilterHasTitleCondition(
  filter?: Record<string, unknown> | null
): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(filter, "title")) {
    return isPositiveTitleMatch(filter.title);
  }
  const andClauses = filter.$and;
  if (!Array.isArray(andClauses)) {
    return false;
  }
  return andClauses.some(
    (clause) =>
      clause != null &&
      typeof clause === "object" &&
      !Array.isArray(clause) &&
      pineconeFilterHasTitleCondition(clause as Record<string, unknown>)
  );
}

/**
 * Corpus-wide cutoff rejects unrelated libraries. Skip it only when the live
 * Pinecone filter already has a title condition. Deictic questions
 * ("In this source...") can score below the floor even when the top chunk is
 * the right chapter. A title-scope label without that filter must keep the floor.
 */
export function getEffectiveMinRetrievalScore(
  siteConfig?: SiteConfig | null,
  filter?: Record<string, unknown> | null
): number | undefined {
  if (pineconeFilterHasTitleCondition(filter)) {
    return undefined;
  }
  return getMinRetrievalScore(siteConfig);
}

export function attachRetrievalScore(doc: Document, score: number): Document {
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      retrievalScore: score,
    },
  };
}

export function filterScoredDocuments(
  results: Array<[Document, number]>,
  minScore: number
): { passing: Array<[Document, number]>; topScore: number | null; rejectedLowRelevance: number; rawHitCount: number } {
  const rawHitCount = results.length;
  const topScore = rawHitCount > 0 ? Math.max(...results.map(([, score]) => score)) : null;
  const passing = results.filter(([, score]) => score >= minScore);

  return {
    passing,
    topScore,
    rejectedLowRelevance: rawHitCount - passing.length,
    rawHitCount,
  };
}

export function documentsFromScoredResults(results: Array<[Document, number]>, maxCount: number): Document[] {
  const sorted = [...results].sort((left, right) => right[1] - left[1]);
  const seen = new Set<string>();
  const documents: Document[] = [];

  for (const [doc, score] of sorted) {
    const key = getDocumentKey(doc);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    documents.push(attachRetrievalScore(doc, score));
    if (documents.length >= maxCount) {
      break;
    }
  }

  return documents;
}

export function mergeRelevanceStats(left: RelevanceStats, right: RelevanceStats): RelevanceStats {
  const topScores = [left.topScore, right.topScore].filter((score): score is number => score != null);
  return {
    rawHitCount: left.rawHitCount + right.rawHitCount,
    rejectedLowRelevance: left.rejectedLowRelevance + right.rejectedLowRelevance,
    topScore: topScores.length > 0 ? Math.max(...topScores) : null,
  };
}

export function resolveNoSourcesReason(stats: RelevanceStats): NoSourcesReason {
  if (stats.rawHitCount > 0) {
    return "low_relevance";
  }
  return "empty";
}

export function formatRelevanceCutoffLog(minScore: number, stats: RelevanceStats): string {
  const topScoreStr = stats.topScore != null ? stats.topScore.toFixed(4) : "n/a";
  return `[RAG] Relevance cutoff: min=${minScore}, topScore=${topScoreStr}, rejected=${stats.rejectedLowRelevance}`;
}

export async function similaritySearchWithRelevance(
  vectorStore: ScoredVectorStore,
  query: string,
  k: number,
  filter: Record<string, unknown> | undefined,
  minScore?: number
): Promise<RelevanceSearchResult> {
  const rawResults = await vectorStore.similaritySearchWithScore(query, k, filter);

  if (minScore === undefined) {
    const topScore = rawResults.length > 0 ? Math.max(...rawResults.map(([, score]) => score)) : null;
    return {
      documents: documentsFromScoredResults(rawResults, k),
      topScore,
      rejectedLowRelevance: 0,
      rawHitCount: rawResults.length,
    };
  }

  const { passing, topScore, rejectedLowRelevance, rawHitCount } = filterScoredDocuments(rawResults, minScore);
  return {
    documents: documentsFromScoredResults(passing, k),
    topScore,
    rejectedLowRelevance,
    rawHitCount,
  };
}
