import { DocMetadata } from "./DocMetadata";

export interface SearchResult {
  pageContent: string;
  metadata: DocMetadata;
  score: number;
}

export interface SearchFacets {
  titles: { name: string; count: number }[];
  authors: { name: string; count: number }[];
  types: { name: string; count: number }[];
  libraries: { name: string; count: number }[];
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  facets: SearchFacets;
  windowSize: number;
}

export interface SearchFilters {
  title?: string;
  author?: string;
  type?: ("text" | "audio" | "youtube")[];
  library?: string;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
}
