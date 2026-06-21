import type { Document } from "@langchain/core/documents";
import type { VectorStoreRetriever } from "@langchain/core/vectorstores";
import { MASTER_SWAMI_AUTHORS } from "@/utils/server/authorConstants";

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

export function buildLibraryFilter(
  libraryNames: string[],
  baseFilter?: Record<string, unknown>
): Record<string, unknown> {
  return mergeFilterClauses(baseFilter ?? { $and: [] }, {
    library: { $in: libraryNames },
  });
}

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
  libraryNames?: string[]
): Promise<{ documents: Document[]; debug: AuthorScopeBlendRetrievalDebug }> {
  const scopedBase = libraryNames?.length ? buildLibraryFilter(libraryNames, baseFilter) : baseFilter;
  const fetchCount = computeBlendFetchCount(sourceCount);

  const rawResults = await retriever.vectorStore.similaritySearchWithScore(question, fetchCount, scopedBase);
  const boostedResults = applyMasterSwamiScoreBoost(rawResults, masterSwamiBoost);
  const documents = rankBoostedDocuments(boostedResults, sourceCount);

  return {
    documents,
    debug: buildBlendRetrievalDebug(rawResults, boostedResults, documents, masterSwamiBoost, fetchCount),
  };
}
