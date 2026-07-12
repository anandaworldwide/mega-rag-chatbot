import { Document } from "@langchain/core/documents";
import { TypedSuggestion } from "./Suggestion";
import { TitleScopeFilterConflictPayload, TitleScopeSuggestion } from "./titleScope";

// Force TypeScript cache invalidation
export interface StreamingResponseData {
  token?: string;
  /** Non-answer UI status; must not count toward TTFB / tokensStreamed */
  status?: "searching_locations";
  sourceDocs?: Document[];
  done?: boolean;
  error?: string;
  docId?: string;
  convId?: string; // Conversation ID for grouping related messages
  title?: string; // AI-generated conversation title
  model?: string;
  siteId?: string;
  warning?: string;
  toolResponse?: boolean; // Flag to indicate this response came from tool execution
  isLocationQuery?: boolean; // Flag to indicate this is a location-based query using geo-awareness tools
  suppressSources?: boolean; // Flag to indicate sources were intentionally suppressed (answer from system prompt only)
  type?: string; // Error type for specific error handling (e.g., "firestore_index_error")
  isBuilding?: boolean; // Flag to indicate if Firestore indexes are currently building
  timing?: {
    ttfb?: number;
    total?: number;
    tokensPerSecond?: number;
    totalTokens?: number;
    firstTokenGenerated?: number;
  };
  suggestions?: TypedSuggestion[]; // Follow-up question suggestions (deeper / apply / broader)
  titleScopeSuggestions?: TitleScopeSuggestion[];
  /** Present when selected source cannot match current author/library/media filters. */
  filterConflict?: TitleScopeFilterConflictPayload;
  log?: string;
}
