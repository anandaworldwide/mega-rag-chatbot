// Concept Graph API endpoint for expanding semantic relationships
// Expands source documents to show related concepts via similarity search

import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getCachedPineconeIndex } from "@/utils/server/pinecone-client";
import { getPineconeIndexName } from "@/utils/server/pinecone-config";
import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { Index, RecordMetadata } from "@pinecone-database/pinecone";
import { DocMetadata } from "@/types/DocMetadata";
import { ConceptGraphRequest, ConceptGraphResponse, GraphNode, GraphEdge, NodeMetadata } from "@/types/ConceptGraph";
import { getFromCache, setInCache } from "@/utils/server/redisUtils";
import { Document } from "langchain/document";
import crypto from "crypto";

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_NODES = 35;
const SECOND_DEGREE_LIMIT = 4; // Top 4 similar vectors per first-degree node
const CACHE_TTL = 300; // 5 minutes
const PHRASE_CACHE_TTL = 86400 * 7; // 7 days for generated phrases

type PineconeFilter = {
  $and?: Array<Record<string, any>>;
  [key: string]: any;
};

// Generate a hash for content to use as cache key
function generateContentHash(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex").substring(0, 16);
}

// Generate descriptive phrases for snippets using AI
async function generatePhrases(
  snippets: Array<{ id: string; content: string; title: string }>
): Promise<Map<string, string>> {
  const phrases = new Map<string, string>();

  if (snippets.length === 0) return phrases;

  // Check cache for each snippet first
  const uncachedSnippets: Array<{ id: string; content: string; title: string; hash: string }> = [];

  for (const snippet of snippets) {
    const hash = generateContentHash(snippet.content);
    const cacheKey = `phrase:${hash}`;

    try {
      const cached = await getFromCache<string>(cacheKey);
      if (cached) {
        phrases.set(snippet.id, cached);
        continue;
      }
    } catch (_e) {
      // Cache miss, will generate
    }

    uncachedSnippets.push({ ...snippet, hash });
  }

  if (uncachedSnippets.length === 0) {
    console.log(`[Concept Graph API] All ${snippets.length} phrases found in cache`);
    return phrases;
  }

  console.log(
    `[Concept Graph API] Generating phrases for ${uncachedSnippets.length} snippets (${snippets.length - uncachedSnippets.length} cached)`
  );

  try {
    const model = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3,
      maxTokens: 500,
      timeout: 15000,
    });

    // Batch the snippets into the prompt
    const snippetList = uncachedSnippets
      .map((s, i) => `${i + 1}. Title: "${s.title}"\n   Snippet: "${s.content.substring(0, 300)}"`)
      .join("\n\n");

    const prompt = `Generate a unique 6-8 word descriptive phrase for each snippet below. Each phrase should capture what makes this specific snippet unique and interesting - not just the general topic.

IMPORTANT:
- Each phrase must be distinct from the others
- Focus on the SPECIFIC content, not just the source title
- Don't start phrases with "The" or "A"
- Use active, engaging language

${snippetList}

Respond with ONLY a numbered list of phrases, one per line:
1. [phrase for snippet 1]
2. [phrase for snippet 2]
...`;

    const response = await model.invoke(prompt);
    const content = (response as any)?.content as string;

    if (content) {
      const lines = content.split("\n").filter((line: string) => line.trim());

      for (let i = 0; i < uncachedSnippets.length && i < lines.length; i++) {
        const line = lines[i];
        // Extract phrase from "1. phrase" or "1) phrase" format
        const match = line.match(/^\d+[.)]\s*(.+)$/);
        if (match) {
          let phrase = match[1].trim();
          // Remove quotes if present
          phrase = phrase.replace(/^["']|["']$/g, "");

          if (phrase.length > 0 && phrase.split(/\s+/).length <= 12) {
            phrases.set(uncachedSnippets[i].id, phrase);

            // Cache the generated phrase
            try {
              const cacheKey = `phrase:${uncachedSnippets[i].hash}`;
              await setInCache(cacheKey, phrase, PHRASE_CACHE_TTL);
            } catch (_e) {
              // Cache write failed, continue
            }
          }
        }
      }
    }
  } catch (error) {
    console.error("[Concept Graph API] Phrase generation failed:", error);
  }

  // Fill in any missing phrases with title-based fallbacks
  for (const snippet of uncachedSnippets) {
    if (!phrases.has(snippet.id)) {
      // Fallback: use first 8 words of content
      const words = snippet.content.split(/\s+/).slice(0, 8);
      phrases.set(snippet.id, words.join(" ") + (snippet.content.split(/\s+/).length > 8 ? "..." : ""));
    }
  }

  return phrases;
}

// Deduplicate documents by source, keeping the highest-scored one
function deduplicateBySource(docs: Array<[Document<DocMetadata>, number]>): Array<[Document<DocMetadata>, number]> {
  const sourceMap = new Map<string, [Document<DocMetadata>, number]>();

  for (const [doc, score] of docs) {
    // Create a source identifier based on title + author (not chunk-specific)
    const sourceKey = `${doc.metadata.title || ""}:${doc.metadata.author || ""}`;

    const existing = sourceMap.get(sourceKey);
    if (!existing || score > existing[1]) {
      sourceMap.set(sourceKey, [doc, score]);
    }
  }

  return Array.from(sourceMap.values());
}

async function handler(req: NextApiRequest, res: NextApiResponse<ConceptGraphResponse | { error: string }>) {
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
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute
    name: "conceptGraphQueriesPerMinute",
    message: "Rate limit exceeded. Please try again in a moment.",
  });
  if (!allowed) return;

  const body = req.body as ConceptGraphRequest;

  // Validate request
  if (!body.query || typeof body.query !== "string" || body.query.trim().length === 0) {
    return res.status(400).json({ error: "Query is required and must be a non-empty string" });
  }

  if (!body.sourceDocs && (!body.sourceIds || body.sourceIds.length === 0)) {
    return res.status(400).json({ error: "Either sourceDocs or sourceIds must be provided" });
  }

  const depth = body.depth || DEFAULT_DEPTH;
  const maxNodes = body.maxNodes || DEFAULT_MAX_NODES;

  try {
    // Setup Pinecone
    const indexName = getPineconeIndexName() || "";
    const index = (await getCachedPineconeIndex(indexName)) as Index<RecordMetadata>;

    // Build filter for access level exclusion
    const filterConditions: Array<Record<string, any>> = [];
    const excludedAccessLevels = (siteConfig as any).excludedAccessLevels;
    if (excludedAccessLevels && Array.isArray(excludedAccessLevels) && excludedAccessLevels.length > 0) {
      filterConditions.push({ access_level: { $nin: excludedAccessLevels } });
    }
    const baseFilter: PineconeFilter = filterConditions.length > 0 ? { $and: filterConditions } : {};

    // Setup vector store
    const embeddingsModel =
      process.env.OPENAI_EMBEDDINGS_MODEL ||
      (() => {
        console.warn("OPENAI_EMBEDDINGS_MODEL not set, using default text-embedding-ada-002");
        return "text-embedding-ada-002";
      })();

    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY not set - embeddings will fail");
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    const vectorStore = await PineconeStore.fromExistingIndex(
      new OpenAIEmbeddings({
        model: embeddingsModel,
        openAIApiKey: process.env.OPENAI_API_KEY,
      }),
      {
        pineconeIndex: index,
        textKey: "text",
      }
    );

    // Build cache key
    const sourceIdsKey = body.sourceIds ? body.sourceIds.sort().join(",") : "docs";
    const cacheKey = `concept-graph:${siteConfig.siteId || "default"}:${body.query.trim()}:${sourceIdsKey}:${depth}:${maxNodes}`;

    // Try cache first
    let cachedResponse: ConceptGraphResponse | null = null;
    try {
      cachedResponse = await getFromCache<ConceptGraphResponse>(cacheKey);
    } catch (e) {
      console.warn("Concept graph cache unavailable:", e);
    }

    if (cachedResponse) {
      console.log(`[Concept Graph API] Cache HIT for query: "${body.query.trim()}"`);
      return res.status(200).json(cachedResponse);
    }

    // Build initial set of source documents
    const sourceDocs: Document<DocMetadata>[] = body.sourceDocs || [];
    const sourceIds = new Set<string>();

    // If we have sourceIds but no sourceDocs, fetch them from Pinecone
    if (body.sourceIds && body.sourceIds.length > 0 && sourceDocs.length === 0) {
      try {
        const fetchResponse = await index.fetch(body.sourceIds);
        if (fetchResponse.records) {
          Object.values(fetchResponse.records).forEach((record) => {
            if (record.metadata) {
              sourceDocs.push({
                pageContent: (record.metadata.text as string) || "",
                metadata: record.metadata as DocMetadata,
              });
              sourceIds.add(record.id);
            }
          });
        }
      } catch (error) {
        console.error("Error fetching source documents:", error);
      }
    } else {
      // Extract source IDs from sourceDocs metadata
      sourceDocs.forEach((doc) => {
        const id = doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title;
        if (id) {
          sourceIds.add(id);
        }
      });
    }

    if (sourceDocs.length === 0) {
      return res.status(400).json({ error: "No source documents found" });
    }

    // Build graph nodes and edges
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIdMap = new Map<string, string>(); // Map from content identifiers to node IDs
    const seenNodeIds = new Set<string>();

    // Create query node
    const queryNodeId = "query-node";
    nodes.push({
      id: queryNodeId,
      label: body.query.length > 50 ? body.query.substring(0, 50) + "..." : body.query,
      type: "query",
      metadata: {
        title: body.query,
        library: "",
        contentType: "text",
        snippet: body.query,
      },
    });
    seenNodeIds.add(queryNodeId);

    // Helper to create node from document (phrase will be added later)
    const createNodeFromDoc = (doc: Document<DocMetadata>, type: "source" | "related", index: number): GraphNode => {
      const contentType = (doc.metadata.type as "text" | "audio" | "youtube") || "text";
      const nodeId = `node-${type}-${index}`;

      const metadata: NodeMetadata = {
        title: doc.metadata.title || "Untitled",
        author: doc.metadata.author,
        library: doc.metadata.library || "",
        contentType,
        snippet: doc.pageContent.length > 300 ? doc.pageContent.substring(0, 300) + "..." : doc.pageContent,
        sourceUrl: doc.metadata.source || doc.metadata.url,
        sourceId: doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title,
      };

      return {
        id: nodeId,
        label: doc.metadata.title || "Untitled", // Will be replaced with phrase
        type,
        metadata,
      };
    };

    // Track snippets for phrase generation
    const snippetsForPhrases: Array<{ id: string; content: string; title: string }> = [];

    // Deduplicate source docs by source (keep one chunk per source document)
    const sourceDocsWithScores: Array<[Document<DocMetadata>, number]> = sourceDocs.map((doc) => [doc, 1.0]);
    const deduplicatedSourceDocs = deduplicateBySource(sourceDocsWithScores);
    console.log(`[Concept Graph API] Deduplicated sources: ${sourceDocs.length} -> ${deduplicatedSourceDocs.length}`);

    // Add source nodes (first degree)
    const firstDegreeNodes: GraphNode[] = [];
    deduplicatedSourceDocs.forEach(([doc], index) => {
      const node = createNodeFromDoc(doc, "source", index);
      firstDegreeNodes.push(node);
      nodes.push(node);
      seenNodeIds.add(node.id);

      // Track for phrase generation
      snippetsForPhrases.push({
        id: node.id,
        content: doc.pageContent,
        title: doc.metadata.title || "Untitled",
      });

      // Create edge from query to source
      edges.push({
        source: queryNodeId,
        target: node.id,
        weight: 1.0,
      });

      // Track content identifier for deduplication
      const contentId = doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title;
      if (contentId) {
        nodeIdMap.set(contentId, node.id);
      }
      // Also track by source key for second-degree dedup
      const sourceKey = `${doc.metadata.title || ""}:${doc.metadata.author || ""}`;
      nodeIdMap.set(sourceKey, node.id);
    });

    // When recentering (1-2 sources), first find additional first-degree nodes
    // to create a proper hierarchical structure
    if (firstDegreeNodes.length <= 2 && firstDegreeNodes.length > 0 && depth >= 2) {
      const targetFirstDegree = 4; // Target 4 first-degree nodes
      const neededFirstDegree = targetFirstDegree - firstDegreeNodes.length;

      if (neededFirstDegree > 0) {
        console.log(
          `[Concept Graph API] Recentering: expanding from ${firstDegreeNodes.length} to ${targetFirstDegree} first-degree nodes`
        );

        // Use the first source to find similar documents as additional first-degree nodes
        const primarySource = deduplicatedSourceDocs[0][0];
        const queryText = primarySource.pageContent.substring(0, 1000);

        try {
          const similarDocs = await vectorStore.similaritySearchWithScore(
            queryText,
            neededFirstDegree + 10, // Fetch extra to account for duplicates
            baseFilter
          );

          const deduplicatedSimilar = deduplicateBySource(similarDocs as Array<[Document<DocMetadata>, number]>);

          let addedFirstDegree = 0;
          for (const [doc, score] of deduplicatedSimilar) {
            if (addedFirstDegree >= neededFirstDegree) break;

            // Check if this is a duplicate
            const contentId = doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title;
            const sourceKey = `${doc.metadata.title || ""}:${doc.metadata.author || ""}`;

            if ((contentId && nodeIdMap.has(contentId)) || nodeIdMap.has(sourceKey)) {
              continue;
            }
            if (sourceIds.has(contentId || "")) {
              continue;
            }

            // Create first-degree node
            const node = createNodeFromDoc(doc, "source", nodes.length);
            firstDegreeNodes.push(node);
            nodes.push(node);
            seenNodeIds.add(node.id);

            snippetsForPhrases.push({
              id: node.id,
              content: doc.pageContent,
              title: doc.metadata.title || "Untitled",
            });

            edges.push({
              source: queryNodeId,
              target: node.id,
              weight: Math.max(0.8, Math.min(1.0, score)),
            });

            if (contentId) {
              nodeIdMap.set(contentId, node.id);
            }
            nodeIdMap.set(sourceKey, node.id);
            addedFirstDegree++;
          }

          console.log(
            `[Concept Graph API] Added ${addedFirstDegree} additional first-degree nodes, total: ${firstDegreeNodes.length}`
          );
        } catch (error: any) {
          console.error("[Concept Graph API] Error finding additional first-degree nodes:", error?.message);
        }
      }
    }

    // Expand to second degree if depth >= 2
    if (depth >= 2 && nodes.length < maxNodes) {
      const remainingSlots = maxNodes - nodes.length;
      // Limit second-degree nodes per source for balanced layout
      const nodesPerSource = Math.max(
        1,
        Math.min(SECOND_DEGREE_LIMIT, Math.floor(remainingSlots / Math.max(1, firstDegreeNodes.length)))
      );

      console.log(
        `[Concept Graph API] Expanding to second degree: ${firstDegreeNodes.length} sources, ${nodesPerSource} nodes per source (limit: ${SECOND_DEGREE_LIMIT})`
      );

      let totalExpanded = 0;
      for (const sourceNode of firstDegreeNodes) {
        if (nodes.length >= maxNodes) break;

        try {
          // Query for similar vectors using the source document content
          const sourceDoc = sourceDocs.find((d) => {
            const docId = d.metadata.file_hash || d.metadata.filename || d.metadata.title;
            return docId === sourceNode.metadata.sourceId;
          });

          if (!sourceDoc) {
            console.warn(`[Concept Graph API] Source doc not found for node ${sourceNode.id}`);
            continue;
          }

          // Perform similarity search - use a reasonable query length
          const queryText = sourceDoc.pageContent.substring(0, 1000); // Limit query length
          console.log(
            `[Concept Graph API] Searching for similar to: ${sourceNode.metadata.title} (query length: ${queryText.length})`
          );

          const similarDocs = await vectorStore.similaritySearchWithScore(
            queryText,
            nodesPerSource + 20, // Fetch extra to account for duplicates and original sources
            baseFilter
          );

          console.log(
            `[Concept Graph API] Found ${similarDocs.length} similar documents for ${sourceNode.metadata.title}`
          );

          // Deduplicate similar docs by source
          const deduplicatedSimilar = deduplicateBySource(similarDocs as Array<[Document<DocMetadata>, number]>);
          console.log(`[Concept Graph API] After dedup: ${deduplicatedSimilar.length} unique sources`);

          // Process similar documents
          let addedCount = 0;
          for (const [doc, score] of deduplicatedSimilar) {
            if (addedCount >= nodesPerSource || nodes.length >= maxNodes) break;

            // Check if this is a duplicate by content ID
            const contentId = doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title;
            if (contentId && nodeIdMap.has(contentId)) {
              continue; // Skip duplicates
            }

            // Check if this source is already in the graph (by source key)
            const sourceKey = `${doc.metadata.title || ""}:${doc.metadata.author || ""}`;
            if (nodeIdMap.has(sourceKey)) {
              continue; // Skip - we already have this source
            }

            // Check if this is one of the original sources
            if (sourceIds.has(contentId || "")) {
              continue;
            }

            // Create related node
            const relatedNode = createNodeFromDoc(doc, "related", nodes.length);
            nodes.push(relatedNode);
            seenNodeIds.add(relatedNode.id);
            if (contentId) {
              nodeIdMap.set(contentId, relatedNode.id);
            }
            nodeIdMap.set(sourceKey, relatedNode.id);

            // Track for phrase generation
            snippetsForPhrases.push({
              id: relatedNode.id,
              content: doc.pageContent,
              title: doc.metadata.title || "Untitled",
            });

            // Create edge from source to related
            edges.push({
              source: sourceNode.id,
              target: relatedNode.id,
              weight: Math.max(0.7, Math.min(1.0, score)), // Clamp score between 0.7 and 1.0
            });

            addedCount++;
            totalExpanded++;
          }

          if (addedCount === 0) {
            console.warn(
              `[Concept Graph API] No new nodes added for ${sourceNode.metadata.title} (all were duplicates or original sources)`
            );
          }
        } catch (error: any) {
          console.error(
            `[Concept Graph API] Error expanding node ${sourceNode.id} (${sourceNode.metadata.title}):`,
            error?.message || error
          );
          // Continue with next node
        }
      }

      console.log(`[Concept Graph API] Second-degree expansion complete: added ${totalExpanded} related nodes`);
    }

    // Cap nodes to maxNodes
    if (nodes.length > maxNodes) {
      nodes.splice(maxNodes);
      // Remove edges that reference removed nodes
      const validNodeIds = new Set(nodes.map((n) => n.id));
      const filteredEdges = edges.filter((edge) => {
        const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
        const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
        return validNodeIds.has(sourceId) && validNodeIds.has(targetId);
      });
      edges.length = 0;
      edges.push(...filteredEdges);

      // Also filter snippetsForPhrases to only include valid nodes
      const validSnippets = snippetsForPhrases.filter((s) => validNodeIds.has(s.id));
      snippetsForPhrases.length = 0;
      snippetsForPhrases.push(...validSnippets);
    }

    // Generate descriptive phrases for all nodes (except query node)
    console.log(`[Concept Graph API] Generating phrases for ${snippetsForPhrases.length} nodes`);
    const phrases = await generatePhrases(snippetsForPhrases);

    // Update node labels with generated phrases
    for (const node of nodes) {
      if (node.type !== "query" && phrases.has(node.id)) {
        node.label = phrases.get(node.id)!;
      }
    }
    console.log(`[Concept Graph API] Phrases assigned to ${phrases.size} nodes`);

    const response: ConceptGraphResponse = {
      nodes,
      edges,
    };

    // #region agent log
    const edgesFromQueryNode = edges.filter((e) => {
      const sourceId = typeof e.source === "string" ? e.source : e.source.id;
      return sourceId === "query-node";
    }).length;
    const nodeTypeCounts: Record<string, number> = {};
    nodes.forEach((n) => {
      nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] || 0) + 1;
    });
    fetch("http://127.0.0.1:7243/ingest/5b642be5-d493-4ed5-bbec-55fc76d4c466", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "concept-graph.ts:finalResponse",
        message: "Final API response",
        data: { totalNodes: nodes.length, totalEdges: edges.length, edgesFromQueryNode, nodeTypes: nodeTypeCounts },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "recenter-debug",
        hypothesisId: "C",
      }),
    }).catch(() => {});
    // #endregion

    // Cache response
    try {
      await setInCache(cacheKey, response, CACHE_TTL);
    } catch (e) {
      console.warn("Failed to cache concept graph response:", e);
    }

    return res.status(200).json(response);
  } catch (error: any) {
    console.error("Concept Graph API error:", error);
    const errorMessage = error?.message || "An error occurred while building concept graph";
    return res.status(500).json({ error: errorMessage });
  }
}

// Skip auth - this endpoint doesn't access user-specific data
// and should be accessible to both logged-in and non-logged-in users
export default withApiMiddleware(handler, { skipAuth: true });
