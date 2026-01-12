export type DocMetadata = {
  title: string;
  "pdf.info.Title"?: string;
  type: string;
  file_hash?: string;
  filename?: string;
  start_time?: number;
  source?: string; // for ananda library
  url?: string; // for youtube
  album?: string;
  library: string;
  pdf_s3_key?: string; // S3 key for PDF downloads
  author?: string; // Document author
  // Precomputed visualization metadata (from update_viz_metadata.py script)
  umap_x?: number; // Precomputed UMAP X coordinate
  umap_y?: number; // Precomputed UMAP Y coordinate
  cluster_id?: number; // Precomputed HDBSCAN cluster ID (-1 for noise, 0+ for clusters)
  viz_subset?: boolean; // True if this vector is in the precomputed visualization subset
};
