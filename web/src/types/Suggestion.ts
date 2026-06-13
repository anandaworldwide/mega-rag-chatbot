export type SuggestionType = "deeper" | "broader" | "apply";

export interface TypedSuggestion {
  id: string;
  text: string;
  type: SuggestionType;
  sourceDocId?: string;
  score?: number;
}
