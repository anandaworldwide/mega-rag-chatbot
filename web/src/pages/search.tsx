import React, { useState, useEffect, useRef } from "react";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import Head from "next/head";
import Layout from "@/components/layout";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { getSiteName, getEnableSearchPage } from "@/utils/client/siteConfig";
import { useSearch } from "@/hooks/useSearch";
import SearchFilters from "@/components/SearchFilters";
import SearchResults from "@/components/SearchResults";

interface SearchPageProps {
  siteConfig: SiteConfig | null;
}

export default function SearchPage({ siteConfig }: SearchPageProps) {
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const initializedFromUrl = useRef(false);

  // Get initial query from URL
  const urlQuery = typeof router.query.q === "string" ? router.query.q : "";

  const {
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
  } = useSearch({ initialQuery: urlQuery });

  // Initialize query from URL on first load
  useEffect(() => {
    if (router.isReady && !initializedFromUrl.current && urlQuery) {
      setQuery(urlQuery);
      initializedFromUrl.current = true;
    }
  }, [router.isReady, urlQuery, setQuery]);

  // Update URL when query changes (using replace to avoid history stack buildup)
  useEffect(() => {
    if (!router.isReady) return;

    const currentUrlQuery = typeof router.query.q === "string" ? router.query.q : "";

    if (query.trim() !== currentUrlQuery) {
      const newUrl = query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : "/search";
      router.replace(newUrl, undefined, { shallow: true });
    }
  }, [query, router]);

  const siteName = getSiteName(siteConfig);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  // Determine what state we're in
  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;
  const isInitialLoading = loading && !hasResults;

  return (
    <>
      <Head>
        <title>Search - {siteName}</title>
        <meta name="description" content="Search the knowledge base" />
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Search</h1>

          {/* Search input */}
          <div className={hasResults || error ? "mb-6" : "mb-8"}>
            <div className="relative max-w-2xl mx-auto">
              <span className="material-icons absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400">
                search
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the libraries..."
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-lg"
                autoFocus
              />
            </div>
          </div>

          {/* Loading spinner - shown when searching but no results yet */}
          {isInitialLoading && (
            <div className="flex flex-col items-center justify-center py-16">
              <span className="material-icons text-blue-600 animate-spin text-5xl mb-4">refresh</span>
              <p className="text-gray-500">Searching...</p>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="text-center py-12">
              <span className="material-icons text-6xl text-red-500 mb-4">error_outline</span>
              <p className="text-lg text-gray-700 mb-2">Error searching</p>
              <p className="text-sm text-gray-500">{error}</p>
            </div>
          )}

          {/* No results state */}
          {hasQuery && !hasResults && !loading && !error && (
            <div className="text-center py-12">
              <span className="material-icons text-6xl text-gray-400 mb-4">search_off</span>
              <p className="text-lg text-gray-700 mb-2">No results found</p>
              <p className="text-sm text-gray-500">
                Try adjusting your search query or filters to find what you&apos;re looking for.
              </p>
            </div>
          )}

          {/* Filters and Results - only shown when we have results */}
          {hasResults && (
            <div className="flex flex-col md:flex-row gap-6">
              {/* Loading overlay when searching with existing results - fixed to viewport */}
              {loading && (
                <div className="fixed inset-0 bg-white/70 flex items-center justify-center z-50">
                  <div className="flex flex-col items-center">
                    <span className="material-icons text-blue-600 animate-spin text-5xl mb-2">refresh</span>
                    <p className="text-gray-600">Searching...</p>
                  </div>
                </div>
              )}

              {/* Filters sidebar */}
              <div className={`${isMobile ? "w-full" : "w-64 flex-shrink-0"}`}>
                <SearchFilters
                  filters={filters}
                  facets={facets}
                  onFiltersChange={setFilters}
                  loading={loading}
                  isMobile={isMobile}
                  isOpen={filtersOpen}
                  onToggle={() => setFiltersOpen(!filtersOpen)}
                />
              </div>

              {/* Results */}
              <div className="flex-1 min-w-0">
                <SearchResults
                  results={results}
                  query={query}
                  loading={loading}
                  total={total}
                  windowSize={windowSize}
                  hasMore={hasMore}
                  onLoadMore={loadMore}
                />
              </div>
            </div>
          )}
        </div>
      </Layout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<SearchPageProps> = async () => {
  const siteId = process.env.SITE_ID || "default";
  const siteConfig = await loadSiteConfig(siteId);

  // Check if search page is enabled
  if (!siteConfig || !getEnableSearchPage(siteConfig)) {
    return {
      notFound: true,
    };
  }

  return {
    props: {
      siteConfig,
    },
  };
};
