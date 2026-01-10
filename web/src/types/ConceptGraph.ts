import { DocMetadata } from "./DocMetadata";

export type NodeType = "query" | "source" | "related";

export type ContentType = "text" | "audio" | "youtube";

export interface NodeMetadata {
  title: string;
  author?: string;
  library: string;
  contentType: ContentType;
  snippet: string;
  score?: number;
  sourceUrl?: string;
  sourceId?: string; // Vector ID from Pinecone
}

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  metadata: NodeMetadata;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  source: string | GraphNode;
  target: string | GraphNode;
  weight: number; // Similarity score (0-1)
}

export interface ConceptGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ConceptGraphRequest {
  sourceIds?: string[];
  sourceDocs?: Array<{
    metadata: DocMetadata;
    pageContent: string;
  }>;
  query: string;
  depth?: number;
  maxNodes?: number;
}

export interface ConceptGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
