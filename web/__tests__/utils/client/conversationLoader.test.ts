/**
 * Tests for conversation loader utility
 *
 * Tests loading conversations and handling both legacy string[] and new TypedSuggestion[] formats.
 */

import { loadConversationByConvId } from "@/utils/client/conversationLoader";
import { ChatHistoryItem } from "@/hooks/useChatHistory";
import { TypedSuggestion } from "@/types/Suggestion";

// Mock fetchWithAuth
jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

// Mock getOrCreateUUID
jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue("test-uuid"),
}));

import { fetchWithAuth } from "@/utils/client/tokenManager";

describe("conversationLoader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("converts legacy string[] suggestions to TypedSuggestion[]", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: ["How to start?", "Benefits?", "Techniques?"], // Legacy format
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    const suggestions = apiMessage!.suggestions;
    expect(suggestions).toBeDefined();
    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions!.length).toBe(3);

    // Check that all suggestions are TypedSuggestion format
    const legacySuggestions = mockChats[0].suggestions as string[];
    suggestions!.forEach((suggestion, idx) => {
      expect(suggestion).toHaveProperty("id");
      expect(suggestion).toHaveProperty("text");
      expect(suggestion).toHaveProperty("type");
      expect(suggestion.text).toBe(legacySuggestions[idx]);
      expect(suggestion.type).toBe("deeper"); // Default for legacy
      expect(suggestion.id).toContain("legacy");
    });
  });

  it("handles new TypedSuggestion[] format correctly", async () => {
    const typedSuggestions: TypedSuggestion[] = [
      { id: "1", text: "What are examples?", type: "deeper" },
      { id: "2", text: "Morning practice for this?", type: "apply" },
      { id: "3", text: "Related topics?", type: "broader" },
    ];

    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: typedSuggestions as any, // Cast to match ChatHistoryItem type
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    const suggestions = apiMessage!.suggestions;
    expect(suggestions).toBeDefined();
    expect(suggestions).toEqual(typedSuggestions);
  });

  it("handles JSON string suggestions (legacy format)", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: JSON.stringify(["How to start?", "Benefits?"]) as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    const suggestions = apiMessage!.suggestions;
    expect(suggestions).toBeDefined();
    expect(suggestions!.length).toBe(2);
    suggestions!.forEach((suggestion) => {
      expect(suggestion).toHaveProperty("id");
      expect(suggestion).toHaveProperty("text");
      expect(suggestion).toHaveProperty("type");
    });
  });

  it("handles JSON string suggestions (typed format)", async () => {
    const typedSuggestions: TypedSuggestion[] = [{ id: "1", text: "What are examples?", type: "deeper" }];

    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: JSON.stringify(typedSuggestions) as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    const suggestions = apiMessage!.suggestions;
    expect(suggestions).toBeDefined();
    expect(suggestions).toEqual(typedSuggestions);
  });

  it("handles missing suggestions gracefully", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        // No suggestions field
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    expect(apiMessage!.suggestions).toBeUndefined();
  });

  it("handles empty suggestions array", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: [],
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    expect(apiMessage!.suggestions).toBeUndefined();
  });

  it("handles invalid JSON in suggestions string gracefully", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: "invalid json{" as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    expect(apiMessage!.suggestions).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("preserves suggestion metadata (sourceDocId, score) when present", async () => {
    const typedSuggestions: TypedSuggestion[] = [
      {
        id: "1",
        text: "What are examples?",
        type: "deeper",
        sourceDocId: "doc-123",
        score: 0.95,
      },
    ];

    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: typedSuggestions as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");

    // loadConversationByConvId returns both user message and API message for each chat
    expect(result.messages).toHaveLength(2);
    const apiMessage = result.messages.find((m) => m.type === "apiMessage");
    expect(apiMessage).toBeDefined();
    const suggestions = apiMessage!.suggestions;
    expect(suggestions![0].sourceDocId).toBe("doc-123");
    expect(suggestions![0].score).toBe(0.95);
  });

  it("defaults invalid suggestion types to deeper on reload", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: [
          { id: "1", text: "Valid apply pill", type: "apply" },
          { id: "2", text: "Invalid type pill", type: "unknown" },
          { id: "3", text: "Missing type pill" },
        ] as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");
    const suggestions = result.messages.find((m) => m.type === "apiMessage")!.suggestions;

    expect(suggestions).toEqual([
      { id: "1", text: "Valid apply pill", type: "apply" },
      { id: "2", text: "Invalid type pill", type: "deeper" },
      { id: "3", text: "Missing type pill", type: "deeper" },
    ]);
  });

  it("drops suggestions with empty text on reload", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: [
          { id: "1", text: "Keep me", type: "broader" },
          { id: "2", text: "   ", type: "apply" },
        ] as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");
    const suggestions = result.messages.find((m) => m.type === "apiMessage")!.suggestions;

    expect(suggestions).toEqual([{ id: "1", text: "Keep me", type: "broader" }]);
  });

  it("assigns restored ids for suggestions missing ids on reload", async () => {
    const mockChats: ChatHistoryItem[] = [
      {
        id: "doc1",
        question: "What is meditation?",
        answer: "Meditation is...",
        timestamp: { seconds: Date.now() / 1000 },
        collection: "test",
        suggestions: [{ text: "Practice daily?", type: "apply" }] as any,
      },
    ];

    (fetchWithAuth as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockChats,
    });

    const result = await loadConversationByConvId("conv-123");
    const suggestions = result.messages.find((m) => m.type === "apiMessage")!.suggestions;

    expect(suggestions).toEqual([{ id: "restored-0", text: "Practice daily?", type: "apply" }]);
  });
});
