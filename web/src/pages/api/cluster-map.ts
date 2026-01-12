// Cluster Map API endpoint
// Fetches vectors with precomputed visualization metadata and returns clusters
// based on UMAP spatial proximity

import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getCachedPineconeIndex } from "@/utils/server/pinecone-client";
import { getPineconeIndexName } from "@/utils/server/pinecone-config";
import { DocMetadata } from "@/types/DocMetadata";
import { getFromCache, setInCache } from "@/utils/server/redisUtils";
import { ClusterNode } from "@/types/cluster";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { verifyToken } from "@/utils/server/jwtUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import crypto from "crypto";

const CACHE_EXPIRATION = 3600; // 1 hour cache
const MAX_NEARBY_CLUSTERS = 3; // Number of nearby clusters to include

interface ClusterMapRequest {
  umap_x: number;
  umap_y: number;
  cluster_id: number;
  title: string;
  vectorId?: string; // Optional: Pinecone vector ID for exact matching
}

interface ClusterCentroid {
  clusterId: number;
  centroid_x: number;
  centroid_y: number;
  nodeCount: number;
}

interface ClusterMapResponse {
  nodes: ClusterNode[];
  centerNodeId: string;
  clusterCentroids: ClusterCentroid[];
}

/**
 * Generate a stable ID for a source document from metadata
 */
function generateNodeId(metadata: DocMetadata, vectorId?: string): string {
  // Use vectorId if provided
  if (vectorId) {
    return vectorId;
  }

  // Use file_hash for audio if available
  if (metadata.type === "audio" && metadata.file_hash) {
    return `audio-${metadata.file_hash}`;
  }

  // Use URL for YouTube
  if (metadata.type === "youtube" && metadata.url) {
    try {
      const urlObj = new URL(metadata.url);
      const videoId = urlObj.hostname === "youtu.be" ? urlObj.pathname.slice(1) : urlObj.searchParams.get("v") || "";
      if (videoId) {
        return `youtube-${videoId}`;
      }
    } catch (_e) {
      // Invalid URL, fall through
    }
  }

  // For text sources, use title + library hash
  const title = metadata.title || metadata["pdf.info.Title"] || "unknown";
  const library = metadata.library || "default";
  const hashInput = `${title}-${library}`;
  const hash = crypto.createHash("md5").update(hashInput).digest("hex").substring(0, 12);
  return `text-${hash}`;
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

/**
 * Calculate Euclidean distance between two points
 */
function euclideanDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

async function handler(req: NextApiRequest, res: NextApiResponse<ClusterMapResponse | { error: string }>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // 100 requests per hour per user
    name: "clusterMapPerHour",
    message: "Too many requests. Please wait a moment and try again.",
  });
  if (!allowed) return;

  // Authentication - extract UUID from JWT token or cookies
  let uuid: string | null = null;
  try {
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

    if (!uuid) {
      const uuidResult = getSecureUUID(req, res);
      if (uuidResult.success) {
        uuid = uuidResult.uuid;
      }
    }
  } catch (error) {
    console.error("[Cluster Map API] Error extracting UUID:", error);
    // Continue without UUID - some sites allow anonymous access
  }

  const body = req.body as ClusterMapRequest;

  // Validate request
  if (typeof body.umap_x !== "number" || typeof body.umap_y !== "number" || typeof body.cluster_id !== "number") {
    return res.status(400).json({ error: "umap_x, umap_y, and cluster_id are required" });
  }

  // Create cache key
  const cacheKey = `cluster-map:${siteConfig.siteId || "default"}:${body.cluster_id}:${Math.round(body.umap_x * 100)}:${Math.round(body.umap_y * 100)}`;

  // Try cache first
  try {
    const cachedData = await getFromCache<ClusterMapResponse>(cacheKey);
    if (cachedData) {
      console.log(`[Cluster Map API] Cache HIT for cluster ${body.cluster_id}`);
      return res.status(200).json(cachedData);
    }
  } catch (_e) {
    console.warn("Cluster map cache unavailable:", _e);
  }

  try {
    // Get Pinecone index
    const indexName = getPineconeIndexName() || "";
    const index = (await getCachedPineconeIndex(indexName)) as any;
    if (!index) {
      return res.status(500).json({ error: "Failed to connect to vector database" });
    }

    // Get vector dimension for dummy vector
    const vectorDimension = parseInt(process.env.OPENAI_EMBEDDING_DIMENSION || "3072", 10);
    const dummyVector = new Array(vectorDimension).fill(0.0);

    // Query Pinecone for ALL vectors with viz_subset=true
    // Cache this full result since it's expensive
    const fullVizCacheKey = `cluster-map-full-viz:${siteConfig.siteId || "default"}`;
    let allVizVectors: any[] = [];

    try {
      const cachedVizVectors = await getFromCache<any[]>(fullVizCacheKey);
      if (cachedVizVectors) {
        console.log(`[Cluster Map API] Using cached full viz_subset vectors (${cachedVizVectors.length})`);
        allVizVectors = cachedVizVectors;
      }
    } catch (_e) {
      // Cache miss, fetch from Pinecone
    }

    if (allVizVectors.length === 0) {
      console.log(`[Cluster Map API] Fetching all vectors with viz_subset=true from Pinecone...`);

      // Query with filter for viz_subset=true
      // Note: Pinecone query requires a vector, so we use a dummy vector
      // Try both filter syntaxes - Pinecone may accept boolean directly or need $eq
      let queryResponse;
      try {
        queryResponse = await index.query({
          vector: dummyVector,
          filter: { viz_subset: true }, // Try direct boolean first
          topK: 10000, // Maximum allowed by Pinecone
          includeMetadata: true,
          includeValues: false, // Don't need embeddings
        });
      } catch (filterError) {
        // Fallback to $eq syntax if direct boolean fails
        console.warn("[Cluster Map API] Direct boolean filter failed, trying $eq syntax:", filterError);
        queryResponse = await index.query({
          vector: dummyVector,
          filter: { viz_subset: { $eq: true } },
          topK: 10000,
          includeMetadata: true,
          includeValues: false,
        });
      }

      allVizVectors = queryResponse.matches || [];
      console.log(`[Cluster Map API] Fetched ${allVizVectors.length} vectors with viz_subset=true`);

      // Cache the full result
      try {
        await setInCache(fullVizCacheKey, allVizVectors, CACHE_EXPIRATION);
      } catch (_e) {
        console.warn("Failed to cache full viz vectors:", _e);
      }
    }

    // Group vectors by cluster_id and calculate centroids
    const clusterGroups = new Map<number, any[]>();
    for (const match of allVizVectors) {
      const metadata = match.metadata || {};
      const clusterId = metadata.cluster_id;
      if (typeof clusterId === "number") {
        if (!clusterGroups.has(clusterId)) {
          clusterGroups.set(clusterId, []);
        }
        clusterGroups.get(clusterId)!.push(match);
      }
    }

    // Calculate cluster centroids
    const centroids: ClusterCentroid[] = [];
    for (const [clusterId, vectors] of clusterGroups.entries()) {
      let sumX = 0;
      let sumY = 0;
      for (const vec of vectors) {
        const metadata = vec.metadata || {};
        if (typeof metadata.umap_x === "number" && typeof metadata.umap_y === "number") {
          sumX += metadata.umap_x;
          sumY += metadata.umap_y;
        }
      }
      const count = vectors.length;
      centroids.push({
        clusterId,
        centroid_x: sumX / count,
        centroid_y: sumY / count,
        nodeCount: count,
      });
    }

    // Find the clicked source's cluster centroid
    const sourceClusterId = body.cluster_id;
    const sourceCentroid = centroids.find((c) => c.clusterId === sourceClusterId);
    if (!sourceCentroid) {
      return res.status(404).json({ error: `Cluster ${sourceClusterId} not found in visualization subset` });
    }

    // Calculate distances from source cluster to all other clusters
    const clusterDistances = centroids
      .filter((c) => c.clusterId !== sourceClusterId)
      .map((c) => ({
        clusterId: c.clusterId,
        distance: euclideanDistance(sourceCentroid.centroid_x, sourceCentroid.centroid_y, c.centroid_x, c.centroid_y),
        centroid: c,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_NEARBY_CLUSTERS);

    // Collect cluster IDs to include
    const includedClusterIds = new Set<number>([sourceClusterId]);
    for (const { clusterId } of clusterDistances) {
      includedClusterIds.add(clusterId);
    }

    console.log(
      `[Cluster Map API] Including clusters: ${Array.from(includedClusterIds).join(", ")} (source: ${sourceClusterId})`
    );

    // Build nodes array from included clusters
    const nodes: ClusterNode[] = [];
    const seenIds = new Set<string>();
    let centerNodeId = "";

    for (const match of allVizVectors) {
      const metadata = match.metadata || {};
      const clusterId = metadata.cluster_id;

      if (typeof clusterId !== "number" || !includedClusterIds.has(clusterId)) {
        continue;
      }

      const umap_x = metadata.umap_x;
      const umap_y = metadata.umap_y;

      if (typeof umap_x !== "number" || typeof umap_y !== "number") {
        continue;
      }

      // Check if this is the clicked source
      const isCenterNode =
        Math.abs(umap_x - body.umap_x) < 0.001 &&
        Math.abs(umap_y - body.umap_y) < 0.001 &&
        clusterId === body.cluster_id;

      const nodeId = generateNodeId(metadata as DocMetadata, match.id);
      if (seenIds.has(nodeId)) continue;
      seenIds.add(nodeId);

      if (isCenterNode) {
        centerNodeId = nodeId;
      }

      const pageContent = (metadata.text as string) || "";
      const node: ClusterNode = {
        id: nodeId,
        title: metadata.title || metadata["pdf.info.Title"] || "Unknown source",
        type: (metadata.type as "text" | "audio" | "youtube") || "text",
        library: metadata.library || "Default Library",
        snippet: truncateText(pageContent),
        score: 1.0, // All nodes in cluster map have equal relevance
        clusterId: clusterId,
        umap_x: umap_x,
        umap_y: umap_y,
        viz_subset: true,
        x: umap_x, // Use UMAP coordinates directly
        y: umap_y,
        metadata: {
          author: metadata.author,
          source: metadata.source,
          url: metadata.url,
          filename: metadata.filename,
          start_time: metadata.start_time,
        },
      };

      nodes.push(node);
    }

    // If center node not found by coordinates, try to find by title
    if (!centerNodeId && body.title) {
      const matchingNode = nodes.find((n) => n.title === body.title);
      if (matchingNode) {
        centerNodeId = matchingNode.id;
      }
    }

    // Fallback: use first node if still no center found
    if (!centerNodeId && nodes.length > 0) {
      centerNodeId = nodes[0].id;
    }

    const response: ClusterMapResponse = {
      nodes,
      centerNodeId,
      clusterCentroids: centroids.filter((c) => includedClusterIds.has(c.clusterId)),
    };

    // Cache the result
    try {
      await setInCache(cacheKey, response, CACHE_EXPIRATION);
    } catch (e) {
      console.warn("Failed to cache cluster map result:", e);
    }

    console.log(`[Cluster Map API] Returning ${nodes.length} nodes from ${includedClusterIds.size} clusters`);

    // Track user activity
    if (uuid) {
      try {
        await Promise.race([
          updateUserActivity(uuid, "cluster_map_query"),
          new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
        ]);
      } catch (_error) {
        console.warn("[Cluster Map API] Failed to update user activity:", _error);
      }
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("[Cluster Map API] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

export default withApiMiddleware(handler);
