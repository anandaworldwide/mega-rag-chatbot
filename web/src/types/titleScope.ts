import type { DocMetadata } from "@/types/DocMetadata";

export interface TitleCatalogManifest {
  site: string;
  version: string;
  generatedAtEpochSeconds: number;
  indexName: string;
  lookupKey: string;
  expansionsKey: string;
  summary: {
    uniquePrefixes: number;
    uniqueFullTitles: number;
    uniqueNormalizedPrefixes: number;
    maxHierarchyDepth: number;
  };
}

/** Aggregated filter compatibility for a title prefix (from catalog artifacts). */
export interface TitleScopeAvailability {
  libraries: string[];
  mediaTypes: string[];
  collectionsWithVectors: Array<"master_swami" | "whole_library">;
}

export interface TitleCatalogLookupEntry {
  canonicalPrefix: string;
  normalizedPrefix: string;
  normalizedSearchText: string;
  normalizedLevels: string[];
  depth: number;
  terminalSegment: string;
  normalizedTerminalSegment: string;
  fullTitleCount: number;
  vectorCount: number;
  /** Libraries, media types, and collections that actually have vectors for this prefix (from lookup.json). */
  availability: TitleScopeAvailability;
}

/** One-click repair the client can apply when filters exclude the selected source. */
export interface FilterConflictAction {
  kind: "setCollection" | "setLibraries" | "setMediaTypes" | "repairAll" | "clearTitleScope";
  label: string;
  collection?: "master_swami" | "whole_library";
  libraries?: string[];
  mediaTypes?: { text: boolean; audio: boolean; youtube: boolean };
  clearTitleScope?: boolean;
  isPrimary?: boolean;
}

export interface TitleScopeFilterConflictPayload {
  type: "filter_conflict";
  titleScopeLabel: string;
  summaryMessage: string;
  reasons: string[];
  actions: FilterConflictAction[];
}

export interface TitleCatalogLookupPayload {
  site: string;
  version: string;
  generatedAtEpochSeconds: number;
  entryCount: number;
  entries: TitleCatalogLookupEntry[];
}

export interface TitleCatalogExpansionsPayload {
  version: string;
  generatedAtEpochSeconds: number;
  expansionCount: number;
  expansions: Record<string, string[]>;
}

export interface TitleScopeSelection {
  canonicalPrefix?: string;
  displayTitle?: string;
  userInput?: string;
}

export interface TitleScopeSuggestion {
  canonicalPrefix: string;
  displayTitle: string;
  depth: number;
  fullTitleCount: number;
  vectorCount: number;
  matchType: "exact" | "contains" | "ordered_tokens";
  score: number;
}

export interface ResolvedTitleScope {
  canonicalPrefix: string;
  displayTitle: string;
  exactTitles: string[];
}

export interface TitleScopeSuggestionResponse {
  suggestions: TitleScopeSuggestion[];
  query: string;
}

export type SourceDocument = {
  metadata?: Partial<DocMetadata>;
};
