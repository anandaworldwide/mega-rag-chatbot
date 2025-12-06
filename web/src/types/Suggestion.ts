export type SuggestionType = "deeper" | "broader";

export interface TypedSuggestion {
  id: string;
  text: string;
  type: SuggestionType;
  sourceDocId?: string;
  score?: number;
}
