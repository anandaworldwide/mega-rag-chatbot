import { logSuggestionPillClick } from "@/utils/client/analytics";
import { TypedSuggestion } from "@/types/Suggestion";

type AuthenticatedFetch = (url: string, options: RequestInit) => Promise<Response>;

export async function recordSuggestionPillClick(
  suggestion: TypedSuggestion,
  position: number,
  convId: string | null,
  fetchWithAuth: AuthenticatedFetch
): Promise<void> {
  logSuggestionPillClick(suggestion.type, suggestion.text, position);

  if (!convId) {
    return;
  }

  try {
    const response = await fetchWithAuth("/api/suggestions/interact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        convId,
        suggestionId: suggestion.id,
        type: suggestion.type,
        position,
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // Ignore body read failures
      }
      console.error(
        "Failed to log suggestion interaction:",
        response.status,
        detail || response.statusText
      );
    }
  } catch (error) {
    console.error("Failed to log suggestion interaction:", error);
  }
}
