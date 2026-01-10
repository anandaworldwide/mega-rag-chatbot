import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";
import { GraphNode, GraphEdge, NodeMetadata, ConceptGraphData, ContentType } from "@/types/ConceptGraph";

/**
 * Truncate text to a maximum length, adding ellipsis if truncated
 */
export function truncateSnippet(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Get hex color for node based on content type
 */
export function getNodeColor(contentType: ContentType, nodeType: "query" | "source" | "related"): string {
  if (nodeType === "query") {
    return "#9333ea"; // purple
  }

  switch (contentType) {
    case "text":
      return "#3b82f6"; // blue
    case "audio":
      return "#10b981"; // green
    case "youtube":
      return "#ef4444"; // red
    default:
      return "#6b7280"; // gray
  }
}

/**
 * Convert source docs to initial graph structure
 */
export function buildInitialGraph(sourceDocs: Document<DocMetadata>[], query: string): ConceptGraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Create query node
  const queryNodeId = "query-node";
  // Allow longer labels since we show two lines (70 chars = ~35 per line)
  nodes.push({
    id: queryNodeId,
    label: query.length > 70 ? truncateSnippet(query, 70) : query,
    type: "query",
    metadata: {
      title: query,
      library: "",
      contentType: "text",
      snippet: query,
    },
  });

  // Create source nodes and edges
  sourceDocs.forEach((doc, index) => {
    const nodeId = `source-${index}`;

    const contentType: ContentType = (doc.metadata.type as ContentType) || "text";

    const metadata: NodeMetadata = {
      title: doc.metadata.title || "Untitled",
      author: doc.metadata.author,
      library: doc.metadata.library || "",
      contentType,
      snippet: truncateSnippet(doc.pageContent, 200),
      sourceUrl: doc.metadata.source,
    };

    nodes.push({
      id: nodeId,
      label: doc.metadata.title || "Untitled",
      type: "source",
      metadata,
    });

    // Create edge from query to source
    edges.push({
      source: queryNodeId,
      target: nodeId,
      weight: 1.0, // Initial sources have max weight
    });
  });

  return { nodes, edges };
}

/**
 * Merge expanded graph data with existing graph, avoiding duplicates
 */
export function mergeGraphData(existing: ConceptGraphData, expanded: ConceptGraphData): ConceptGraphData {
  const nodeMap = new Map<string, GraphNode>();
  // Use a Map to track edges by their source-target pair, storing the weight
  const edgeMap = new Map<string, { sourceId: string; targetId: string; weight: number }>();

  // Use a separator that won't appear in node IDs
  const EDGE_KEY_SEPARATOR = "|||";

  // Add existing nodes first
  existing.nodes.forEach((node) => {
    nodeMap.set(node.id, node);
  });

  // Add expanded nodes - prefer expanded labels (API has AI-generated phrases)
  expanded.nodes.forEach((node) => {
    if (nodeMap.has(node.id)) {
      // Node exists - update label if API returned a phrase (different from title)
      const existingNode = nodeMap.get(node.id)!;
      if (node.label !== node.metadata.title) {
        // API generated a phrase, use it
        existingNode.label = node.label;
      }
    } else {
      nodeMap.set(node.id, node);
    }
  });

  // Helper to get edge key
  const getEdgeKey = (sourceId: string, targetId: string) => `${sourceId}${EDGE_KEY_SEPARATOR}${targetId}`;

  // Add existing edges
  existing.edges.forEach((edge) => {
    const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
    const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
    const key = getEdgeKey(sourceId, targetId);
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { sourceId, targetId, weight: edge.weight });
    }
  });

  // Add expanded edges (skip duplicates, but update weight if higher)
  expanded.edges.forEach((edge) => {
    const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
    const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
    const key = getEdgeKey(sourceId, targetId);
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { sourceId, targetId, weight: edge.weight });
    }
  });

  // Build edges array with string IDs (D3 will resolve them to node objects)
  const mergedEdges: GraphEdge[] = [];
  edgeMap.forEach(({ sourceId, targetId, weight }) => {
    // Only add edge if both nodes exist
    if (nodeMap.has(sourceId) && nodeMap.has(targetId)) {
      mergedEdges.push({
        source: sourceId,
        target: targetId,
        weight: weight,
      });
    }
  });

  console.log(`[mergeGraphData] Merged ${nodeMap.size} nodes, ${mergedEdges.length} edges`);

  return {
    nodes: Array.from(nodeMap.values()),
    edges: mergedEdges,
  };
}

/**
 * Generate a unique node ID from metadata
 */
export function generateNodeId(metadata: DocMetadata, index?: number): string {
  const parts = [
    metadata.library || "unknown",
    metadata.title || "untitled",
    metadata.author || "",
    index !== undefined ? index.toString() : "",
  ].filter(Boolean);

  return parts
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
}
