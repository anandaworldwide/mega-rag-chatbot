import { SuggestionType, TypedSuggestion } from "@/types/Suggestion";

const VALID_SUGGESTION_TYPES: SuggestionType[] = ["deeper", "broader", "apply"];

export function isSuggestionType(value: unknown): value is SuggestionType {
  return typeof value === "string" && VALID_SUGGESTION_TYPES.includes(value as SuggestionType);
}

/**
 * Normalize a single stored suggestion for UI rendering.
 * Invalid types default to "deeper"; entries without usable text are dropped.
 */
export function normalizeTypedSuggestion(item: unknown, index: number): TypedSuggestion | null {
  if (typeof item === "string") {
    const text = item.trim();
    if (text.length === 0) {
      return null;
    }
    return {
      id: `legacy-${index}`,
      text,
      type: "deeper",
    };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text.length === 0) {
    return null;
  }

  const type: SuggestionType = isSuggestionType(record.type) ? record.type : "deeper";
  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : `restored-${index}`;

  const normalized: TypedSuggestion = { id, text, type };

  if (typeof record.sourceDocId === "string" && record.sourceDocId.trim().length > 0) {
    normalized.sourceDocId = record.sourceDocId.trim();
  }

  if (typeof record.score === "number" && !Number.isNaN(record.score)) {
    normalized.score = record.score;
  }

  return normalized;
}

/** Normalize mixed legacy/string/object suggestion payloads from Firestore. */
export function normalizeTypedSuggestions(raw: unknown[]): TypedSuggestion[] {
  return raw
    .map((item, index) => normalizeTypedSuggestion(item, index))
    .filter((suggestion): suggestion is TypedSuggestion => suggestion !== null);
}
