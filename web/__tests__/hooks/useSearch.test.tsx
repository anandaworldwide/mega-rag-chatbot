import { renderHook, act, waitFor } from "@testing-library/react";
import { useSearch } from "@/hooks/useSearch";
import { fetchWithAuth } from "@/utils/client/tokenManager";

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

const searchResponse = {
  results: [{ id: "r1" }, { id: "r2" }],
  facets: { titles: [], authors: [], types: [], libraries: [] },
  total: 5,
  windowSize: 5,
};

function okResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

describe("useSearch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchWithAuth.mockImplementation(() => okResponse(searchResponse));
  });

  it("initializes with provided query and empty results", () => {
    const { result } = renderHook(() => useSearch({ initialQuery: "yoga" }));
    expect(result.current.query).toBe("yoga");
    expect(result.current.results).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it("sets loading when a non-empty query is typed", () => {
    const { result } = renderHook(() => useSearch());
    act(() => result.current.setQuery("meditation"));
    expect(result.current.loading).toBe(true);
    expect(result.current.query).toBe("meditation");
  });

  it("performs a search via the imperative search() method", async () => {
    const { result } = renderHook(() => useSearch({ initialQuery: "meditation" }));
    await act(async () => {
      result.current.search();
    });
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    expect(result.current.total).toBe(5);
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/search", expect.objectContaining({ method: "POST" }));
  });

  it("captures errors from a failed search", async () => {
    mockFetchWithAuth.mockImplementation(() =>
      Promise.resolve({ ok: false, statusText: "Server Error", json: () => Promise.resolve({ error: "boom" }) } as Response)
    );
    const { result } = renderHook(() => useSearch({ initialQuery: "meditation" }));
    await act(async () => {
      result.current.search();
    });
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.results).toEqual([]);
  });

  it("clears state on reset", async () => {
    const { result } = renderHook(() => useSearch({ initialQuery: "meditation" }));
    await act(async () => {
      result.current.search();
    });
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    act(() => result.current.reset());
    expect(result.current.query).toBe("");
    expect(result.current.results).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it("does not search for an empty query via search()", async () => {
    const { result } = renderHook(() => useSearch());
    await act(async () => {
      result.current.search();
    });
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("appends results when loading more", async () => {
    const { result } = renderHook(() => useSearch({ initialQuery: "meditation" }));
    await act(async () => {
      result.current.search();
    });
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.results).toHaveLength(4));
  });
});
