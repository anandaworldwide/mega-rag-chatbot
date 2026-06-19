import { renderHook, act, waitFor } from "@testing-library/react";
import { useChatHistory } from "@/hooks/useChatHistory";
import { fetchWithAuth } from "@/utils/client/tokenManager";

jest.mock("@/utils/client/tokenManager", () => ({
  getToken: jest.fn(() => "mock-token"),
  isAuthenticated: jest.fn(() => true),
  fetchWithAuth: jest.fn(),
  ensureAnonymousUuidSynced: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/client/profileUuidSync", () => ({
  ensureProfileUuidSynced: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn(() => "test-uuid"),
}));

const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

const sampleChats = [
  {
    id: "msg-1",
    question: "What is meditation?",
    answer: "Meditation is...",
    timestamp: { seconds: 1640995200 },
    collection: "all",
    convId: "conv-1",
    title: "Meditation basics",
    isStarred: false,
  },
  {
    id: "msg-2",
    question: "How to pray?",
    answer: "Prayer is...",
    timestamp: { seconds: 1640995100 },
    collection: "all",
    convId: "conv-2",
    isStarred: false,
  },
];

describe("useChatHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes("/api/chats")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sampleChats),
        } as Response);
      }
      if (url.includes("/api/conversations/")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("loads and groups conversations on mount", async () => {
    const { result } = renderHook(() => useChatHistory(10));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(result.current.conversations.length).toBe(2);
    });

    expect(result.current.conversations[0].convId).toBe("conv-1");
    expect(result.current.conversations[0].title).toBe("Meditation basics");
  });

  it("sets error when fetch fails", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      json: () => Promise.resolve({ error: "Database unavailable" }),
    } as Response);

    const { result } = renderHook(() => useChatHistory(10));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Database unavailable");
    });
  });

  it("adds a new conversation to the top of the list", async () => {
    const { result } = renderHook(() => useChatHistory(10));

    await act(async () => {
      result.current.addNewConversation("conv-new", "New Chat", "Hello?");
    });

    expect(result.current.conversations[0].convId).toBe("conv-new");
    expect(result.current.conversations[0].title).toBe("New Chat");
  });

  it("renames a conversation via API", async () => {
    const { result } = renderHook(() => useChatHistory(10));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => expect(result.current.conversations.length).toBeGreaterThan(0));

    await act(async () => {
      await result.current.renameConversation("conv-1", "Updated Title");
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/conversations/conv-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Updated Title" }),
      })
    );

    const renamed = result.current.conversations.find((c) => c.convId === "conv-1");
    expect(renamed?.title).toBe("Updated Title");
  });

  it("deletes a conversation via API", async () => {
    const { result } = renderHook(() => useChatHistory(10));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    await waitFor(() => expect(result.current.conversations.length).toBe(2));

    await act(async () => {
      await result.current.deleteConversation("conv-1");
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/conversations/conv-1", { method: "DELETE" });
    expect(result.current.conversations.find((c) => c.convId === "conv-1")).toBeUndefined();
  });

  it("does not fetch when disabled", async () => {
    renderHook(() => useChatHistory(10, false));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
