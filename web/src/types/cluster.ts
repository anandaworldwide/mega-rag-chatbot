/**
 * Type definitions for cluster visualization feature
 * Uses precomputed UMAP coordinates and HDBSCAN cluster assignments
 */

export interface ClusterNode {
  id: string; // Unique identifier (can be Pinecone vector ID or generated)
  title: string; // Source title
  type: "text" | "audio" | "youtube";
  library: string;
  snippet: string; // Truncated pageContent
  score: number; // Similarity score (0-1) - not used for cluster map but kept for compatibility
  clusterId: number; // HDBSCAN cluster ID: -1 for noise, 0+ for clusters
  // Precomputed visualization metadata (required for cluster map)
  umap_x: number; // Precomputed UMAP X coordinate
  umap_y: number; // Precomputed UMAP Y coordinate
  viz_subset: boolean; // True if this node is in the precomputed visualization subset
  x?: number; // Alias for umap_x (for D3 compatibility)
  y?: number; // Alias for umap_y (for D3 compatibility)
  metadata?: {
    author?: string;
    source?: string;
    url?: string;
    filename?: string;
    start_time?: number;
  };
}

export interface ClusterCentroid {
  clusterId: number;
  centroid_x: number;
  centroid_y: number;
  nodeCount: number;
}

export interface ClusterMapData {
  nodes: ClusterNode[];
  centerNodeId: string; // ID of the clicked source
  clusterCentroids: ClusterCentroid[]; // Centroids for included clusters
}
