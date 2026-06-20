import type { Document } from "@langchain/core/documents";
import type { VectorStoreRetriever } from "@langchain/core/vectorstores";
import { MASTER_SWAMI_AUTHORS } from "@/utils/server/authorConstants";
import { calculateSources } from "@/utils/server/ragDocumentUtils";

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

export function allocateAuthorBlendSlots(
  sourceCount: number,
  masterSwamiWeight: number
): { masterSwamiSlots: number; broadSlots: number } {
  const [masterSwamiAllocation, broadAllocation] = calculateSources(sourceCount, [
    { name: "master_swami", weight: masterSwamiWeight },
    { name: "broad", weight: 1 - masterSwamiWeight },
  ]);

  return {
    masterSwamiSlots: masterSwamiAllocation.sources,
    broadSlots: broadAllocation.sources,
  };
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

/**
 * Merges the two author-scope legs while honoring their slot quotas and guaranteeing the result
 * fills `sourceCount` whenever enough unique documents exist. The broad leg is an unfiltered
 * superset of the Master/Swami leg, so the legs routinely overlap; taking only the quota from each
 * and deduping would shrink the result below `sourceCount`. We therefore take the quota first
 * (Master/Swami preferred), then backfill any remaining slots from the leftover documents.
 */
export function mergeAuthorBlendResults(
  masterSwamiDocs: Document[],
  broadDocs: Document[],
  masterSwamiSlots: number,
  broadSlots: number,
  sourceCount: number
): Document[] {
  const seen = new Set<string>();
  const merged: Document[] = [];

  const take = (docs: Document[], limit: number) => {
    let added = 0;
    for (const doc of docs) {
      if (added >= limit || merged.length >= sourceCount) {
        break;
      }
      const key = getDocumentKey(doc);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(doc);
      added += 1;
    }
  };

  take(masterSwamiDocs, masterSwamiSlots);
  take(broadDocs, broadSlots);

  // Backfill any slots lost to cross-leg overlap, Master/Swami first to preserve the default lens.
  // Only backfill from a leg that had a positive quota so a single-leg blend (weight 0 or 1) never
  // leaks documents from the leg it intentionally excluded.
  if (merged.length < sourceCount) {
    if (masterSwamiSlots > 0) {
      take(masterSwamiDocs, sourceCount);
    }
    if (broadSlots > 0) {
      take(broadDocs, sourceCount);
    }
  }

  return merged;
}

export async function retrieveWithAuthorScopeBlend(
  retriever: VectorStoreRetriever,
  question: string,
  sourceCount: number,
  baseFilter: Record<string, unknown> | undefined,
  masterSwamiWeight: number,
  libraryNames?: string[]
): Promise<Document[]> {
  const scopedBase = libraryNames?.length ? buildLibraryFilter(libraryNames, baseFilter) : baseFilter;

  const { masterSwamiSlots, broadSlots } = allocateAuthorBlendSlots(sourceCount, masterSwamiWeight);

  // Over-fetch each active leg up to sourceCount so cross-leg overlap can be backfilled without
  // dropping below the requested source count.
  const masterSwamiPromise =
    masterSwamiSlots > 0
      ? retriever.vectorStore.similaritySearch(question, sourceCount, buildMasterSwamiFilter(scopedBase))
      : Promise.resolve<Document[]>([]);
  const broadPromise =
    broadSlots > 0
      ? retriever.vectorStore.similaritySearch(question, sourceCount, scopedBase)
      : Promise.resolve<Document[]>([]);

  const [masterSwamiDocs, broadDocs] = await Promise.all([masterSwamiPromise, broadPromise]);

  return mergeAuthorBlendResults(masterSwamiDocs, broadDocs, masterSwamiSlots, broadSlots, sourceCount);
}
