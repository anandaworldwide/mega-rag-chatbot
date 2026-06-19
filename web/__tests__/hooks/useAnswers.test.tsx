import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAnswers, useDownvotedAnswers, useRelatedQuestions, queryKeys } from "@/hooks/useAnswers";
import { queryFetch } from "@/utils/client/reactQueryConfig";
import { fetchWithAuth } from "@/utils/client/tokenManager";

jest.mock("@/utils/client/reactQueryConfig", () => ({ queryFetch: jest.fn() }));
jest.mock("@/utils/client/tokenManager", () => ({ fetchWithAuth: jest.fn() }));

const mockQueryFetch = queryFetch as jest.MockedFunction<typeof queryFetch>;
const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function okResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

describe("queryKeys", () => {
  it("builds stable answer keys with defaults", () => {
    expect(queryKeys.answers()).toEqual(["answers", 1, "", 30]);
    expect(queryKeys.answers(2, { q: "  yoga  ", daysBack: 7 })).toEqual(["answers", 2, "yoga", 7]);
  });

  it("builds related question keys without undefined docId", () => {
    expect(queryKeys.relatedQuestions()).toEqual(["relatedQuestions"]);
    expect(queryKeys.relatedQuestions("doc-1")).toEqual(["relatedQuestions", "doc-1"]);
  });
});

describe("useAnswers", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fetches answers and returns the parsed payload", async () => {
    mockQueryFetch.mockImplementation(() => okResponse({ answers: [{ id: "a1" }], totalPages: 3 }));
    const { result } = renderHook(() => useAnswers(1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.answers).toHaveLength(1);
    expect(mockQueryFetch).toHaveBeenCalledWith(expect.stringContaining("/api/answers?"), { method: "GET" });
  });

  it("adds search params when a query is provided", async () => {
    mockQueryFetch.mockImplementation(() => okResponse({ answers: [], totalPages: 0 }));
    const { result } = renderHook(() => useAnswers(1, { q: "peace", daysBack: 14 }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = mockQueryFetch.mock.calls[0][0] as string;
    expect(url).toContain("q=peace");
    expect(url).toContain("daysBack=14");
  });

  it("surfaces errors with status code", async () => {
    mockQueryFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ message: "fail" }) } as Response)
    );
    const { result } = renderHook(() => useAnswers(1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("fail");
  });
});

describe("useDownvotedAnswers", () => {
  beforeEach(() => jest.clearAllMocks());

  it("includes only non-'all' filters in the query string", async () => {
    mockFetchWithAuth.mockImplementation(() => okResponse({ answers: [], groups: [], totalItems: 0, totalPages: 0, currentPage: 1 }));
    const { result } = renderHook(
      () => useDownvotedAnswers(2, { triageStatus: "classified", triageCategory: "all", groupBy: "category" }),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = mockFetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain("triageStatus=classified");
    expect(url).not.toContain("triageCategory");
    expect(url).toContain("groupBy=category");
  });

  it("throws on a failed response", async () => {
    mockFetchWithAuth.mockImplementation(() => Promise.resolve({ ok: false, status: 403 } as Response));
    const { result } = renderHook(() => useDownvotedAnswers(1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useRelatedQuestions", () => {
  beforeEach(() => jest.clearAllMocks());

  it("posts the docId and returns related questions", async () => {
    mockQueryFetch.mockImplementation(() => okResponse({ related: ["q1"] }));
    const { result } = renderHook(() => useRelatedQuestions("doc-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockQueryFetch).toHaveBeenCalledWith(
      "/api/relatedQuestions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("can be disabled via options", async () => {
    const { result } = renderHook(() => useRelatedQuestions("doc-1", { enabled: false }), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockQueryFetch).not.toHaveBeenCalled();
  });
});
