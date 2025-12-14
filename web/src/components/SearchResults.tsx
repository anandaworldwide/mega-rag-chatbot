import React from "react";
import { SearchResult } from "@/types/SearchTypes";
import SearchResultItem from "./SearchResultItem";

interface SearchResultsProps {
  results: SearchResult[];
  query: string;
  loading: boolean;
  total: number;
  windowSize: number;
  hasMore: boolean;
  onLoadMore: () => void;
}

export default function SearchResults({
  results,
  query,
  loading,
  total,
  windowSize: _windowSize,
  hasMore,
  onLoadMore,
}: SearchResultsProps) {
  // This component is now only rendered when we have results
  // Empty, loading, and error states are handled by the parent page

  if (results.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-2">
        <span>
          Showing {results.length} of top {total} {total === 1 ? "result" : "results"}
          {query && ` for “${query}”`}
        </span>
      </div>

      <div className="space-y-4">
        {results.map((result, index) => (
          <SearchResultItem key={`${result.metadata.title}-${index}`} result={result} query={query} />
        ))}
      </div>

      {hasMore && (
        <div className="mt-6 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <span className="material-icons animate-spin inline-block mr-2">refresh</span>
                Loading...
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
