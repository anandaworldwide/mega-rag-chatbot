import { loadCategorizedQueries, CategorizedQueries } from "./categorizedQueries";

let cachedQueries: Record<string, Record<string, string[]>> | null = null;
let cachedCategorizedQueries: Record<string, Record<string, CategorizedQueries | null>> | null = null;

/** Auto mode has no query file; reuse Master/Swami prompts when available. */
export function resolveSuggestedQueriesCollectionKey(
  collectionKey: string,
  collectionConfig?: Record<string, string> | null
): string {
  if (collectionKey !== "auto") {
    return collectionKey;
  }
  if (collectionConfig && "master_swami" in collectionConfig) {
    return "master_swami";
  }
  const fallbackKey = Object.keys(collectionConfig ?? {}).find((key) => key !== "auto");
  return fallbackKey || "whole_library";
}

export async function loadQueries(siteId: string, collection: string): Promise<string[]> {
  if (cachedQueries && cachedQueries[siteId] && cachedQueries[siteId][collection]) {
    return cachedQueries[siteId][collection];
  }

  try {
    // First try to load as categorized queries
    const categorized = await loadCategorizedQueries(siteId, collection);

    if (categorized) {
      // Cache categorized queries
      if (!cachedCategorizedQueries) {
        cachedCategorizedQueries = {};
      }
      if (!cachedCategorizedQueries[siteId]) {
        cachedCategorizedQueries[siteId] = {};
      }
      cachedCategorizedQueries[siteId][collection] = categorized;

      // For backward compatibility, return flat list by combining all categories
      const flatQueries = [...categorized.general, ...categorized.location, ...categorized.resources];

      if (!cachedQueries) {
        cachedQueries = {};
      }
      if (!cachedQueries[siteId]) {
        cachedQueries[siteId] = {};
      }
      cachedQueries[siteId][collection] = flatQueries;

      return flatQueries;
    }

    // Fall back to flat format
    const response = await fetch(`/data/${siteId}/${collection}_queries.txt`);

    if (!response.ok) {
      // Return a helpful message when the file doesn't exist
      const fallbackQueries = ["(Suggested queries not set up yet)"];

      if (!cachedQueries) {
        cachedQueries = {};
      }
      if (!cachedQueries[siteId]) {
        cachedQueries[siteId] = {};
      }
      cachedQueries[siteId][collection] = fallbackQueries;

      return fallbackQueries;
    }

    const text = await response.text();
    const queries = text.split("\n").filter((query) => query.trim() !== "");

    if (!cachedQueries) {
      cachedQueries = {};
    }
    if (!cachedQueries[siteId]) {
      cachedQueries[siteId] = {};
    }
    cachedQueries[siteId][collection] = queries;

    return queries;
  } catch (error) {
    // Handle any other errors (network issues, etc.)
    console.error(`Error loading queries for ${siteId}/${collection}:`, error);
    const fallbackQueries = ["(Suggested queries not set up yet)"];

    if (!cachedQueries) {
      cachedQueries = {};
    }
    if (!cachedQueries[siteId]) {
      cachedQueries[siteId] = {};
    }
    cachedQueries[siteId][collection] = fallbackQueries;

    return fallbackQueries;
  }
}

/**
 * Get categorized queries for a collection if available
 */
export async function getCategorizedQueries(
  siteId: string,
  collection: string,
  collectionConfig?: Record<string, string> | null
): Promise<CategorizedQueries | null> {
  const resolvedCollection = resolveSuggestedQueriesCollectionKey(collection, collectionConfig);

  // Check cache first
  if (
    cachedCategorizedQueries &&
    cachedCategorizedQueries[siteId] &&
    cachedCategorizedQueries[siteId][resolvedCollection]
  ) {
    return cachedCategorizedQueries[siteId][resolvedCollection];
  }

  // Try to load
  const categorized = await loadCategorizedQueries(siteId, resolvedCollection);

  if (categorized) {
    if (!cachedCategorizedQueries) {
      cachedCategorizedQueries = {};
    }
    if (!cachedCategorizedQueries[siteId]) {
      cachedCategorizedQueries[siteId] = {};
    }
    cachedCategorizedQueries[siteId][resolvedCollection] = categorized;
  }

  return categorized;
}

export async function getCollectionQueries(siteId: string, collectionConfig: Record<string, string>) {
  if (cachedQueries && cachedQueries[siteId]) {
    return cachedQueries[siteId];
  }

  const queries: Record<string, string[]> = {};
  for (const [key] of Object.entries(collectionConfig)) {
    if (key === "auto") {
      continue;
    }
    queries[key] = await loadQueries(siteId, key);
  }

  if ("auto" in collectionConfig) {
    const sourceKey = resolveSuggestedQueriesCollectionKey("auto", collectionConfig);
    queries.auto = queries[sourceKey] ?? (await loadQueries(siteId, sourceKey));
  }

  if (!cachedQueries) {
    cachedQueries = {};
  }
  cachedQueries[siteId] = queries;
  return queries;
}
