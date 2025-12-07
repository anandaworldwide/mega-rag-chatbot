import { useState, useEffect, useCallback, useRef } from "react";
import { SearchResponse, SearchFilters, SearchResult } from "@/types/SearchTypes";
import { fetchWithAuth } from "@/utils/client/tokenManager";

const DEFAULT_LIMIT = 30;
const DEBOUNCE_MS = 600;

interface UseSearchOptions {
  initialQuery?: string;
  initialFilters?: SearchFilters;
}

interface UseSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  filters: SearchFilters;
  setFilters: (filters: SearchFilters) => void;
  results: SearchResult[];
  facets: SearchResponse["facets"];
  total: number;
  windowSize: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  search: () => void;
  reset: () => void;
}

export function useSearch(options: UseSearchOptions = {}): UseSearchReturn {
  const [query, setQueryInternal] = useState<string>(options.initialQuery || "");
  const [filters, setFiltersInternal] = useState<SearchFilters>(options.initialFilters || {});
  const [results, setResults] = useState<SearchResult[]>([]);
  const [facets, setFacets] = useState<SearchResponse["facets"]>({
    titles: [],
    authors: [],
    types: [],
    libraries: [],
  });
  const [total, setTotal] = useState<number>(0);
  const [windowSize, setWindowSize] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState<number>(0);

  // Track the last searched trimmed query to avoid re-searching when only whitespace changes at edges
  const lastSearchedTrimmedQueryRef = useRef<string>("");
  // Track last searched filters to detect filter-only changes
  const lastSearchedFiltersRef = useRef<string>("");
  // Track current trimmed query for comparison in setQuery
  const currentTrimmedQueryRef = useRef<string>(options.initialQuery?.trim() || "");

  // Wrap setQuery to also set loading immediately (batched by React)
  const setQuery = useCallback((newQuery: string) => {
    setQueryInternal(newQuery);
    const newTrimmed = newQuery.trim();

    // Update current trimmed ref
    currentTrimmedQueryRef.current = newTrimmed;

    // Only trigger loading if the trimmed query actually changed from what we last searched
    if (newTrimmed !== lastSearchedTrimmedQueryRef.current) {
      if (newTrimmed) {
        setLoading(true);
      } else {
        setLoading(false);
      }
    }
  }, []);

  // Wrap setFilters to also set loading immediately
  const setFilters = useCallback(
    (newFilters: SearchFilters) => {
      setFiltersInternal(newFilters);
      // Set loading if there's an active query and filters actually changed
      const newFiltersKey = JSON.stringify(newFilters);
      if (query.trim() && newFiltersKey !== lastSearchedFiltersRef.current) {
        setLoading(true);
      }
    },
    [query]
  );

  const performSearch = useCallback(
    async (searchQuery: string, searchFilters: SearchFilters, searchOffset: number = 0, append: boolean = false) => {
      if (!searchQuery.trim()) {
        setResults([]);
        setFacets({ titles: [], authors: [], types: [], libraries: [] });
        setTotal(0);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchWithAuth("/api/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: searchQuery.trim(),
            limit: DEFAULT_LIMIT,
            offset: searchOffset,
            filters: searchFilters,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Failed to search" }));
          throw new Error(errorData.error || `Search failed: ${response.statusText}`);
        }

        const data: SearchResponse = await response.json();

        if (append) {
          setResults((prev) => [...prev, ...data.results]);
        } else {
          setResults(data.results);
        }

        setFacets(data.facets);
        setTotal(data.total);
        setWindowSize(data.windowSize || data.total);
        setOffset(searchOffset + data.results.length);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "An error occurred while searching";
        setError(errorMessage);
        if (!append) {
          setResults([]);
          setFacets({ titles: [], authors: [], types: [], libraries: [] });
          setTotal(0);
          setWindowSize(0);
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Debounced search effect
  useEffect(() => {
    const trimmedQuery = query.trim();
    const filtersKey = JSON.stringify(filters);

    if (!trimmedQuery) {
      setResults([]);
      setFacets({ titles: [], authors: [], types: [], libraries: [] });
      setTotal(0);
      setError(null);
      setOffset(0);
      setWindowSize(0);
      setLoading(false);
      lastSearchedTrimmedQueryRef.current = "";
      lastSearchedFiltersRef.current = "";
      return;
    }

    // Check if we actually need to search
    const queryChanged = trimmedQuery !== lastSearchedTrimmedQueryRef.current;
    const filtersChanged = filtersKey !== lastSearchedFiltersRef.current;

    if (!queryChanged && !filtersChanged) {
      // Nothing meaningful changed - just whitespace at edges
      setLoading(false);
      return;
    }

    // Loading is already set to true by setQuery/setFilters wrapper
    // Just set up the debounced search
    const timeoutId = setTimeout(() => {
      lastSearchedTrimmedQueryRef.current = trimmedQuery;
      lastSearchedFiltersRef.current = filtersKey;
      setOffset(0);
      performSearch(query, filters, 0, false);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [query, filters, performSearch]);

  const loadMore = useCallback(() => {
    if (loading || !query.trim() || offset >= total) {
      return;
    }
    performSearch(query, filters, offset, true);
  }, [query, filters, offset, total, loading, performSearch]);

  const search = useCallback(() => {
    setOffset(0);
    performSearch(query, filters, 0, false);
  }, [query, filters, performSearch]);

  const reset = useCallback(() => {
    setQueryInternal("");
    setFiltersInternal({});
    setResults([]);
    setFacets({ titles: [], authors: [], types: [], libraries: [] });
    setTotal(0);
    setError(null);
    setOffset(0);
    setWindowSize(0);
    setLoading(false);
  }, []);

  const hasMore = offset < total;

  return {
    query,
    setQuery,
    filters,
    setFilters,
    results,
    facets,
    total,
    windowSize,
    loading,
    error,
    hasMore,
    loadMore,
    search,
    reset,
  };
}
