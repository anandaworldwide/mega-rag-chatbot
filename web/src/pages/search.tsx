import React, { useState, useEffect, useRef, useMemo } from "react";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import Head from "next/head";
import Layout from "@/components/layout";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { getSiteName, getEnableSearchPage, getIncludedLibraryNames } from "@/utils/client/siteConfig";
import { useSearch } from "@/hooks/useSearch";
import SearchFilters from "@/components/SearchFilters";
import SearchResults from "@/components/SearchResults";
import { SearchFilters as SearchFiltersType } from "@/types/SearchTypes";

interface SearchPageProps {
  siteConfig: SiteConfig | null;
}

// Helper to parse filters from URL query params
function parseFiltersFromUrl(routerQuery: Record<string, string | string[] | undefined>): SearchFiltersType {
  const filters: SearchFiltersType = {};

  if (typeof routerQuery.title === "string" && routerQuery.title) {
    filters.title = routerQuery.title;
  }
  if (typeof routerQuery.author === "string" && routerQuery.author) {
    filters.author = routerQuery.author;
  }
  if (routerQuery.library) {
    const libs = Array.isArray(routerQuery.library) ? routerQuery.library : [routerQuery.library];
    const cleaned = libs.filter(Boolean) as string[];
    if (cleaned.length > 0) {
      filters.library = cleaned;
    }
  }
  if (routerQuery.type) {
    const types = Array.isArray(routerQuery.type) ? routerQuery.type : [routerQuery.type];
    const validTypes = types.filter((t): t is "text" | "audio" | "youtube" => ["text", "audio", "youtube"].includes(t));
    if (validTypes.length > 0) {
      filters.type = validTypes;
    }
  }

  return filters;
}

// Helper to build URL from query and filters
function buildSearchUrl(query: string, filters: SearchFiltersType): string {
  const params = new URLSearchParams();

  if (query.trim()) {
    params.set("q", query.trim());
  }
  if (filters.title) {
    params.set("title", filters.title);
  }
  if (filters.author) {
    params.set("author", filters.author);
  }
  if (filters.library && filters.library.length > 0) {
    filters.library.forEach((lib) => params.append("library", lib));
  }
  if (filters.type && filters.type.length > 0) {
    filters.type.forEach((t) => params.append("type", t));
  }

  const queryString = params.toString();
  return queryString ? `/search?${queryString}` : "/search";
}

export default function SearchPage({ siteConfig }: SearchPageProps) {
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const initializedFromUrl = useRef(false);

  // Get initial query and filters from URL
  const urlQuery = typeof router.query.q === "string" ? router.query.q : "";
  const urlFilters = useMemo(() => parseFiltersFromUrl(router.query), [router.query]);

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
  } = useSearch({ initialQuery: urlQuery, initialFilters: urlFilters });

  // Initialize query and filters from URL on first load
  useEffect(() => {
    if (router.isReady && !initializedFromUrl.current) {
      if (urlQuery) {
        setQuery(urlQuery);
      }
      if (Object.keys(urlFilters).length > 0) {
        setFilters(urlFilters);
      }
      initializedFromUrl.current = true;
    }
  }, [router.isReady, urlQuery, urlFilters, setQuery, setFilters]);

  // Update URL when query or filters change (using replace to avoid history stack buildup)
  useEffect(() => {
    if (!router.isReady || !initializedFromUrl.current) return;

    const currentUrl = buildSearchUrl(
      typeof router.query.q === "string" ? router.query.q : "",
      parseFiltersFromUrl(router.query)
    );
    const newUrl = buildSearchUrl(query, filters);

    if (newUrl !== currentUrl) {
      router.replace(newUrl, undefined, { shallow: true });
    }
  }, [query, filters, router]);

  const siteName = getSiteName(siteConfig);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  // Determine what state we're in
  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;

  return (
    <>
      <Head>
        <title>Search Passages - {siteName}</title>
        <meta name="description" content="Search passages in the library" />
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Search Passages</h1>

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

          {/* Error state */}
          {error && !loading && (
            <div className="text-center py-12">
              <span className="material-icons text-6xl text-red-500 mb-4">error_outline</span>
              <p className="text-lg text-gray-700 mb-2">Error searching</p>
              <p className="text-sm text-gray-500">{error}</p>
            </div>
          )}

          {/* Filters and Results - shown when a query is present (even if zero results) */}
          {hasQuery && (
            <div className="flex flex-col md:flex-row gap-6">
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
                  allLibraries={getIncludedLibraryNames(siteConfig)}
                />
              </div>

              {/* Results */}
              <div className="flex-1 min-w-0 relative">
                {loading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-20">
                    <div className="flex flex-col items-center">
                      <span className="material-icons text-blue-600 animate-spin text-5xl mb-2">refresh</span>
                      <p className="text-gray-600">Searching...</p>
                    </div>
                  </div>
                )}
                {!loading && !error && !hasResults && (
                  <div className="text-center py-12">
                    <span className="material-icons text-6xl text-gray-400 mb-4">search_off</span>
                    <p className="text-lg text-gray-700 mb-2">No results found</p>
                    <p className="text-sm text-gray-500">
                      Try adjusting your search query or filters to find what you&apos;re looking for.
                    </p>
                  </div>
                )}
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
