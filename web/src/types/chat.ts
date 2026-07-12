import { Document } from "@langchain/core/documents";
import { TypedSuggestion } from "./Suggestion";

export interface Message {
  type: "apiMessage" | "userMessage";
  message: string;
  sourceDocs?: Document[] | null;
  isStreaming?: boolean;
  docId?: string;
  collection?: string;
  suggestions?: TypedSuggestion[]; // Follow-up question suggestions (typed)
  /** Answer model id for admin debug display (e.g. gpt-4o / claude-fable-5) */
  model?: string;
}
