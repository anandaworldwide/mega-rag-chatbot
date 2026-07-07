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
  /** Pinecone cosine similarity from chat retrieval; admin debug only in UI. */
  retrievalScore?: number;
  required_access_level?: number | string; // Numeric access level required to retrieve this source
  access_level?: number | string; // Legacy access tag, when present
};
