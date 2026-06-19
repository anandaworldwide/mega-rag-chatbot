// Search API endpoint for semantic vector search
// Allows users to explore the knowledge base directly through semantic search
// without LLM answer generation

import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getCachedPineconeIndex } from "@/utils/server/pinecone-client";
import { getPineconeIndexName } from "@/utils/server/pinecone-config";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Index, RecordMetadata } from "@pinecone-database/pinecone";
import { DocMetadata } from "@/types/DocMetadata";
import { getFromCache, setInCache } from "@/utils/server/redisUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import { verifyToken } from "@/utils/server/jwtUtils";
import { buildPineconeAccessFilterClauses, resolveEffectiveAccessLevelForEmail } from "@/utils/server/accessLevelUtils";

// Hardcoded shared defaults (not per-site config)
// We fetch a fixed top window for faceting/pagination.
const SEARCH_WINDOW_SIZE = 200;
const DEFAULT_SEARCH_RESULTS_LIMIT = 30;
const DEFAULT_MAX_SEARCH_RESULTS = SEARCH_WINDOW_SIZE;
const DEFAULT_SEARCH_QUERIES_PER_USER_PER_DAY = 500;

type PineconeFilter = {
  $and?: Array<Record<string, any>>;
  [key: string]: any;
};

interface SearchRequest {
  query: string;
  limit?: number;
  offset?: number;
  filters?: {
    title?: string;
    author?: string;
    type?: ("text" | "audio" | "youtube")[];
    library?: string;
  };
}

interface SearchResult {
  pageContent: string;
  metadata: DocMetadata;
  score: number;
}

interface SearchFacets {
  titles: { name: string; count: number }[];
  authors: { name: string; count: number }[];
  types: { name: string; count: number }[];
  libraries: { name: string; count: number }[];
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  facets: SearchFacets;
  windowSize: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse<SearchResponse | { error: string }>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  // Check if search page is enabled
  if (!siteConfig.enableSearchPage) {
    return res.status(403).json({ error: "Search page is not enabled for this site" });
  }

  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: DEFAULT_SEARCH_QUERIES_PER_USER_PER_DAY,
    name: "searchQueriesPerUserPerDay",
    message: "Daily search query limit exceeded. Please try again tomorrow.",
  });
  if (!allowed) return;

  const body = req.body as SearchRequest;

  // Validate query
  if (!body.query || typeof body.query !== "string" || body.query.trim().length === 0) {
    return res.status(400).json({ error: "Query is required and must be a non-empty string" });
  }

  if (body.query.length > 1000) {
    return res.status(400).json({ error: "Query must be 1000 characters or less" });
  }

  // Validate and set limits (for client pagination within the window)
  const limit = Math.min(Math.max(body.limit || DEFAULT_SEARCH_RESULTS_LIMIT, 1), DEFAULT_MAX_SEARCH_RESULTS);
  const offset = Math.max(body.offset || 0, 0);

  try {
    // Setup Pinecone
    const indexName = getPineconeIndexName() || "";
    const index = (await getCachedPineconeIndex(indexName)) as Index<RecordMetadata>;

    // Build filter - use a mutable array then assign to filter
    const filterConditions: Array<Record<string, any>> = [];

    const userEmail = getAuthenticatedEmail(req);
    const effectiveAccess = await resolveEffectiveAccessLevelForEmail(userEmail, siteConfig);
    filterConditions.push(...buildPineconeAccessFilterClauses(effectiveAccess.level, siteConfig));

    // Add user-provided filters
    if (body.filters) {
      if (body.filters.title) {
        filterConditions.push({ title: { $eq: body.filters.title } });
      }

      if (body.filters.author) {
        if (body.filters.author === "(No author)") {
          // Don't add author filter for "(No author)" - we'll post-filter results instead
          // This handles cases where Pinecone doesn't store the author field for missing authors
        } else {
          filterConditions.push({ author: { $eq: body.filters.author } });
        }
      }

      if (body.filters.type && body.filters.type.length > 0) {
        filterConditions.push({ type: { $in: body.filters.type } });
      }

      if (body.filters.library && Array.isArray(body.filters.library) && body.filters.library.length > 0) {
        filterConditions.push({ library: { $in: body.filters.library } });
      }
    }

    // Build final filter object
    const filter: PineconeFilter = filterConditions.length > 0 ? { $and: filterConditions } : {};

    // Setup vector store
    const vectorStore = await PineconeStore.fromExistingIndex(
      new OpenAIEmbeddings({
        model:
          process.env.OPENAI_EMBEDDINGS_MODEL ||
          (() => {
            console.warn("OPENAI_EMBEDDINGS_MODEL not set, using default text-embedding-ada-002");
            return "text-embedding-ada-002";
          })(),
      }),
      {
        pineconeIndex: index,
        textKey: "text",
      }
    );

    // Caching key based on query + filters + site
    const normalizedQuery = body.query.trim().toLowerCase();
    const cacheKeyFilters = body.filters
      ? JSON.stringify({
          title: body.filters.title || null,
          author: body.filters.author || null,
          type: body.filters.type ? [...body.filters.type].sort() : null,
          library: body.filters.library ? [...body.filters.library].sort() : null,
        })
      : "none";
    const cacheKey = `search:${siteConfig.siteId || "default"}:access-${effectiveAccess.level}:${normalizedQuery}:${cacheKeyFilters}`;

    // Try cache first
    let cachedResponse: SearchResponse | null = null;
    try {
      cachedResponse = await getFromCache<SearchResponse>(cacheKey);
    } catch (e) {
      console.warn("Search cache unavailable:", e);
    }

    if (cachedResponse) {
      console.log(`[Search API] Cache HIT for query: "${body.query.trim()}" - skipping Pinecone`);
      const paginatedResults = cachedResponse.results.slice(offset, offset + limit);
      return res.status(200).json({
        results: paginatedResults,
        total: cachedResponse.total,
        facets: cachedResponse.facets,
        windowSize: cachedResponse.windowSize,
      });
    }

    // Perform similarity search with scores over a fixed window
    const searchLimit = SEARCH_WINDOW_SIZE;
    console.log(`[Search API] Pinecone query: "${body.query.trim()}", limit: ${searchLimit}, filters:`, filter);
    const searchResults = await vectorStore.similaritySearchWithScore(body.query.trim(), searchLimit, filter);
    console.log(`[Search API] Pinecone returned ${searchResults.length} results`);

    // Convert to SearchResult format
    let allResults: SearchResult[] = searchResults.map(([doc, score]) => ({
      pageContent: doc.pageContent,
      metadata: doc.metadata as DocMetadata,
      score: score,
    }));

    // Post-filter for "(No author)" if needed (handles missing author fields in Pinecone)
    // Pinecone might not store the author field when it's undefined, so we filter client-side
    if (body.filters?.author === "(No author)") {
      allResults = allResults.filter((result) => {
        const author = result.metadata.author;
        return !author || author.trim() === "";
      });
      console.log(`[Search API] Post-filtered to ${allResults.length} results with no author`);
    }

    // Apply pagination
    const paginatedResults = allResults.slice(offset, offset + limit);

    // Extract facets from all results (before pagination)
    const facets: SearchFacets = {
      titles: [],
      authors: [],
      types: [],
      libraries: [],
    };

    const titleCounts: Record<string, number> = {};
    const authorCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    const libraryCounts: Record<string, number> = {};

    allResults.forEach((result) => {
      if (result.metadata.title) {
        titleCounts[result.metadata.title] = (titleCounts[result.metadata.title] || 0) + 1;
      }
      // Count blank/undefined authors as "(No author)" for display purposes
      // The actual metadata remains blank/undefined - this is just for facet counting
      const author = result.metadata.author?.trim() || "(No author)";
      authorCounts[author] = (authorCounts[author] || 0) + 1;
      if (result.metadata.type) {
        typeCounts[result.metadata.type] = (typeCounts[result.metadata.type] || 0) + 1;
      }
      if (result.metadata.library) {
        libraryCounts[result.metadata.library] = (libraryCounts[result.metadata.library] || 0) + 1;
      }
    });

    facets.titles = Object.entries(titleCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    facets.authors = Object.entries(authorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    facets.types = Object.entries(typeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    facets.libraries = Object.entries(libraryCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const responsePayload: SearchResponse = {
      results: allResults,
      total: allResults.length,
      facets,
      windowSize: SEARCH_WINDOW_SIZE,
    };

    // Cache full window for 5 minutes
    try {
      await setInCache(cacheKey, responsePayload, 300);
    } catch (e) {
      console.warn("Failed to cache search results:", e);
    }

    // Track user activity - MUST await to prevent Vercel from terminating before completion
    // Use Promise.race with timeout to avoid blocking the response too long
    let uuid: string | null = null;
    try {
      // Extract UUID - try JWT token first, then fall back to getSecureUUID
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.substring(7);
          const userPayload = verifyToken(token);
          if (userPayload?.uuid) {
            uuid = userPayload.uuid;
          }
        } catch {
          // Token verification failed, try getSecureUUID
        }
      }

      // If UUID not found from JWT, try getSecureUUID (handles cookies for anonymous sites)
      if (!uuid) {
        const uuidResult = getSecureUUID(req, res);
        if (uuidResult.success) {
          uuid = uuidResult.uuid;
        }
      }

      if (uuid) {
        // Await with 3s timeout to prevent Vercel from killing the operation
        await Promise.race([
          updateUserActivity(uuid, "search-api"),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } catch {
      // Silently handle errors - activity tracking is non-critical
    }

    return res.status(200).json({
      results: paginatedResults,
      total: responsePayload.total,
      facets: responsePayload.facets,
      windowSize: responsePayload.windowSize,
    });
  } catch (error: any) {
    console.error("Search API error:", error);
    const errorMessage = error?.message || "An error occurred while searching";
    return res.status(500).json({ error: errorMessage });
  }
}

export default withApiMiddleware(handler);

function getAuthenticatedEmail(req: NextApiRequest): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(authHeader.substring(7));
      return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    } catch {
      // Fall through to cookie token.
    }
  }

  const authCookie = req.cookies?.["authToken"];
  if (authCookie) {
    try {
      const payload = verifyToken(authCookie);
      return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  return null;
}
