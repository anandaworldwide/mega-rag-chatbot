import { Document } from "@langchain/core/documents";
import { DocMetadata } from "./DocMetadata";
import { TypedSuggestion } from "./Suggestion";

export interface ExtendedAIMessage {
  type: "apiMessage" | "userMessage";
  message: string;
  sourceDocs?: Document<DocMetadata>[];
  docId?: string;
  collection?: string;
  isSudoAdmin?: boolean;
  suggestions?: TypedSuggestion[]; // Follow-up question suggestions (typed)
  /** Answer model id (e.g. gpt-4o / claude-fable-5); used for admin debug display */
  model?: string;
}
