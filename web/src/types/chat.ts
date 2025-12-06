import { Document } from "langchain/document";
import { TypedSuggestion } from "./Suggestion";

export interface Message {
  type: "apiMessage" | "userMessage";
  message: string;
  sourceDocs?: Document[] | null;
  isStreaming?: boolean;
  docId?: string;
  collection?: string;
  suggestions?: TypedSuggestion[]; // Follow-up question suggestions (typed)
}
