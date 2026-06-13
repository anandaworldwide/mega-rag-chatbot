import { logSuggestionPillClick } from "@/utils/client/analytics";
import { recordSuggestionPillClick } from "@/utils/client/suggestionInteraction";
import { TypedSuggestion } from "@/types/Suggestion";

jest.mock("@/utils/client/analytics", () => ({
  logSuggestionPillClick: jest.fn(),
}));

describe("recordSuggestionPillClick", () => {
  const suggestion: TypedSuggestion = {
    id: "suggestion-1",
    text: "Morning practice for this?",
    type: "apply",
    score: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("logs analytics and posts interaction when convId is present", async () => {
    const fetchWithAuth = jest.fn().mockResolvedValue({ ok: true });

    await recordSuggestionPillClick(suggestion, 1, "conv-123", fetchWithAuth);

    expect(logSuggestionPillClick).toHaveBeenCalledWith("apply", "Morning practice for this?", 1);
    expect(fetchWithAuth).toHaveBeenCalledWith("/api/suggestions/interact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        convId: "conv-123",
        suggestionId: "suggestion-1",
        type: "apply",
        position: 1,
      }),
    });
  });

  it("logs analytics but skips backend call when convId is missing", async () => {
    const fetchWithAuth = jest.fn().mockResolvedValue({ ok: true });

    await recordSuggestionPillClick(suggestion, 0, null, fetchWithAuth);

    expect(logSuggestionPillClick).toHaveBeenCalledWith("apply", "Morning practice for this?", 0);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("does not throw when backend logging fails", async () => {
    const fetchWithAuth = jest.fn().mockRejectedValue(new Error("network error"));
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordSuggestionPillClick(suggestion, 0, "conv-123", fetchWithAuth)).resolves.toBeUndefined();

    expect(logSuggestionPillClick).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to log suggestion interaction:", expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it("logs non-OK HTTP responses without throwing", async () => {
    const fetchWithAuth = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: jest.fn().mockResolvedValue('{"error":"Conversation not found or access denied"}'),
    });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordSuggestionPillClick(suggestion, 0, "conv-123", fetchWithAuth)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to log suggestion interaction:",
      403,
      '{"error":"Conversation not found or access denied"}'
    );

    consoleErrorSpy.mockRestore();
  });
});
