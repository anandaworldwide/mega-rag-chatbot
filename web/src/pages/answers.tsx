/**
 * This component uses React Query for data fetching with JWT authentication.
 *
 * Key features:
 * - Pagination with server-side rendering
 * - Answers sorted by most recent
 * - Copy link to individual answers
 * - Delete answers (for sudo users only)
 * - JWT authentication with React Query
 * - Admin-only access control
 */

import Layout from "@/components/layout";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/router";
import { logEvent } from "@/utils/client/analytics";
import React from "react";
import { GetServerSideProps } from "next";
import AnswerItem from "@/components/AnswerItem";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { NextApiRequest, NextApiResponse } from "next";
import { useSudo } from "@/contexts/SudoContext";
import { SudoProvider } from "@/contexts/SudoContext";
import { useAnswers, AnswersSearchParams } from "@/hooks/useAnswers";
import { useMutation } from "@tanstack/react-query";
import { queryFetch } from "@/utils/client/reactQueryConfig";
import { isAnswersPageAllowed, getAnswersPageErrorMessage } from "@/utils/server/answersPageAuth";

interface AllAnswersProps {
  siteConfig: SiteConfig | null;
  authorizationError?: boolean;
  errorMessage?: string;
}

const AllAnswers = ({ siteConfig, authorizationError, errorMessage }: AllAnswersProps) => {
  const router = useRouter();
  const { isSudoUser, checkSudoStatus } = useSudo();
  const [isAdmin, setIsAdmin] = useState(false);

  // Parse query parameters
  const urlPage = router.query.page ? Number(router.query.page) : 1;
  const urlSearchQuery = typeof router.query.q === "string" ? router.query.q : "";
  const urlDaysBack = router.query.daysBack ? Number(router.query.daysBack) : 30;

  const activeSearch = useMemo<AnswersSearchParams | undefined>(() => {
    const trimmedQuery = urlSearchQuery.trim();
    if (!trimmedQuery) {
      return undefined;
    }

    return {
      q: trimmedQuery,
      daysBack: Number.isFinite(urlDaysBack) ? urlDaysBack : 30,
    };
  }, [urlSearchQuery, urlDaysBack]);

  // UI state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState("");
  const [daysBackInput, setDaysBackInput] = useState("30");
  const [isPageInitialized, setIsPageInitialized] = useState(false);
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [linkCopied, setLinkCopied] = useState<string | null>(null);

  // Refs
  const hasInitiallyFetched = useRef(false);

  // State for delayed spinner
  const [showDelayedSpinner, setShowDelayedSpinner] = useState(false);
  const [showExtendedLoadingMessage, setShowExtendedLoadingMessage] = useState(false);

  // Check admin status for login-required sites
  useEffect(() => {
    const checkAdminStatus = async () => {
      if (siteConfig?.requireLogin) {
        try {
          const response = await queryFetch("/api/profile");
          if (response.ok) {
            const data = await response.json();
            const role = data.role?.toLowerCase();
            setIsAdmin(role === "admin" || role === "superuser");
          } else {
            setIsAdmin(false);
          }
        } catch (error) {
          console.error("Failed to check admin status:", error);
          setIsAdmin(false);
        }
      } else {
        // For no-login sites, use sudo status
        setIsAdmin(isSudoUser);
      }
    };
    checkAdminStatus();
  }, [siteConfig?.requireLogin, isSudoUser]);

  // Use React Query for data fetching with JWT authentication
  const { data, isLoading, error } = useAnswers(currentPage, activeSearch, {
    enabled: isPageInitialized && router.isReady,
  });

  // Show delayed spinner for long-running loads
  useEffect(() => {
    // Set a timeout to show the spinner after 1.5 seconds
    const spinner = setTimeout(() => {
      if (isLoading) {
        setShowDelayedSpinner(true);
      }
    }, 1500);

    // Set a timeout to show extended loading message after 8 seconds
    const extended = setTimeout(() => {
      if (isLoading) {
        setShowExtendedLoadingMessage(true);
      }
    }, 8000);

    // Clear the timeout if the component unmounts or isLoading changes to false
    return () => {
      clearTimeout(spinner);
      clearTimeout(extended);
    };
  }, [isLoading]);

  // Set initial load state when data is loaded
  useEffect(() => {
    if (data && !hasInitiallyFetched.current) {
      hasInitiallyFetched.current = true;
      setInitialLoadComplete(true);

      // Reset changing page state if needed
      if (isChangingPage) {
        setIsChangingPage(false);
      }
    }
  }, [data, isChangingPage]);

  // Extract data from query result
  const answersData = useMemo(() => data?.answers || [], [data?.answers]);
  const totalPages = useMemo(() => data?.totalPages || 1, [data?.totalPages]);
  const totalMatches = data?.totalMatches;
  const isSearchActive = Boolean(activeSearch?.q);
  const searchTruncated = Boolean(data?.truncated);

  // Delete mutation with React Query
  const deleteMutation = useMutation({
    mutationFn: async (answerId: string) => {
      const response = await queryFetch(`/api/answers?answerId=${answerId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const responseData = await response.json();
        throw new Error("Failed to delete answer (" + responseData.message + ")");
      }
      return response.json();
    },
    onSuccess: (data, answerId) => {
      logEvent("delete_answer", "Admin", answerId);
    },
    onError: (error) => {
      console.error("Error deleting answer:", error);
      alert("Failed to delete answer. Please try again.");
    },
  });

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: "auto",
    });
    // Force a reflow to ensure the scroll is applied immediately
    void document.body.offsetHeight;
  };

  // Initialize based on URL parameters
  useEffect(() => {
    if (router.isReady) {
      const pageFromUrl = Number(urlPage) || 1;

      setCurrentPage(pageFromUrl);
      setSearchInput(urlSearchQuery);
      setDaysBackInput(String(Number.isFinite(urlDaysBack) ? urlDaysBack : 30));
      setIsPageInitialized(true);
    }
  }, [router.isReady, urlPage, urlSearchQuery, urlDaysBack]);

  // Update URL with current page and optional search params
  const updateUrl = useCallback(
    (page: number, search?: AnswersSearchParams) => {
      if (!router.isReady) {
        return;
      }

      const params = new URLSearchParams();
      const trimmedQuery = search?.q?.trim() || "";

      if (trimmedQuery) {
        params.set("q", trimmedQuery);
        params.set("daysBack", String(search?.daysBack ?? 30));
      }

      if (page !== 1) {
        params.set("page", page.toString());
      }

      const query: Record<string, string> = {};
      if (trimmedQuery) {
        query.q = trimmedQuery;
        query.daysBack = String(search?.daysBack ?? 30);
      }
      if (page !== 1) {
        query.page = page.toString();
      }

      const path = params.toString() ? `/answers?${params.toString()}` : "/answers";

      router.push(
        {
          pathname: "/answers",
          query,
        },
        path,
        { shallow: true }
      );
    },
    [router]
  );

  const handleSearchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedQuery = searchInput.trim();
    if (trimmedQuery.length < 2) {
      alert("Search query must be at least 2 characters.");
      return;
    }

    const parsedDaysBack = Number(daysBackInput) || 30;
    scrollToTop();
    setIsChangingPage(true);
    setCurrentPage(1);
    setInitialLoadComplete(false);
    hasInitiallyFetched.current = false;
    updateUrl(1, { q: trimmedQuery, daysBack: parsedDaysBack });
    logEvent("search_answers", "Admin", trimmedQuery);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setDaysBackInput("30");
    scrollToTop();
    setIsChangingPage(true);
    setCurrentPage(1);
    setInitialLoadComplete(false);
    hasInitiallyFetched.current = false;
    updateUrl(1);
  };

  // Handle answer deletion (for sudo users only)
  const handleDelete = (answerId: string) => {
    if (confirm("Are you sure you want to delete this answer?")) {
      deleteMutation.mutate(answerId);
    }
  };

  // Handle copying answer link
  const handleCopyLink = (answerId: string) => {
    const url = `${window.location.origin}/share/${answerId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(answerId);
      setTimeout(() => setLinkCopied(null), 2000);
      logEvent("copy_link", "Engagement", `Answer ID: ${answerId}`);
    });
  };

  // Handle page change
  const handlePageChange = (newPage: number) => {
    if (newPage === currentPage) return;

    scrollToTop();
    setIsChangingPage(true);
    setCurrentPage(newPage);
    updateUrl(newPage, activeSearch);
    logEvent("change_answers_page", "UI", `page:${newPage}`);

    // React Query will handle the data fetching when currentPage changes
    // We just need to reset some UI state
    setInitialLoadComplete(false);
    hasInitiallyFetched.current = false;
  };

  // Check sudo status on component mount
  useEffect(() => {
    if (!(siteConfig && siteConfig.requireLogin)) {
      checkSudoStatus();
    }
  }, [checkSudoStatus, siteConfig]);

  const handleNewChat = () => {
    router.push("/");
  };

  return (
    <SudoProvider disableChecks={!!siteConfig && !!siteConfig.requireLogin}>
      <Layout siteConfig={siteConfig} onNewChat={handleNewChat}>
        {/* Authorization error display */}
        {authorizationError && (
          <div className="mx-auto max-w-full sm:max-w-4xl px-2 sm:px-6 lg:px-8">
            <div className="flex flex-col justify-center items-center min-h-screen">
              <div className="text-center">
                <h1 className="text-6xl font-bold text-gray-400 mb-4">403</h1>
                <h2 className="text-2xl font-semibold text-gray-800 mb-4">{errorMessage || "Access Restricted"}</h2>
                <p className="text-gray-600 mb-8 max-w-md">
                  You don&apos;t have permission to access this page. This page is restricted to authorized users only.
                </p>
                <button
                  onClick={() => router.push("/")}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Go to Chat
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main content - only show if no authorization error */}
        {!authorizationError && (
          <>
            <div className="mx-auto max-w-full sm:max-w-4xl px-2 sm:px-6 lg:px-8">
              {/* Loading spinner */}
              {(isLoading && !initialLoadComplete) || isChangingPage ? (
                <div className="flex flex-col justify-center items-center h-screen">
                  <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"></div>
                  <p className="text-lg text-gray-600 mt-4">
                    {showExtendedLoadingMessage
                      ? "Still loading... This is taking longer than expected."
                      : showDelayedSpinner
                        ? "Still loading..."
                        : "Loading..."}
                  </p>
                  {showExtendedLoadingMessage && (
                    <p className="text-sm text-gray-500 mt-2 max-w-md text-center">
                      We were unable to load the content. You can try refreshing the page if this continues.
                    </p>
                  )}

                  {showExtendedLoadingMessage && (
                    <button
                      onClick={() => window.location.reload()}
                      className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                    >
                      Refresh Page
                    </button>
                  )}
                </div>
              ) : (
                <div key={`${currentPage}-${isSearchActive ? activeSearch?.q : "mostRecent"}`}>
                  <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <form onSubmit={handleSearchSubmit} className="grid gap-4 md:grid-cols-[1fr_auto_auto_auto]">
                      <label className="text-sm text-gray-700">
                        <div className="mb-1 font-medium">Search questions</div>
                        <input
                          type="search"
                          value={searchInput}
                          onChange={(event) => setSearchInput(event.target.value)}
                          placeholder="e.g. centennial"
                          className="w-full rounded border border-gray-300 px-3 py-2"
                        />
                      </label>

                      <label className="text-sm text-gray-700">
                        <div className="mb-1 font-medium">Date range</div>
                        <select
                          value={daysBackInput}
                          onChange={(event) => setDaysBackInput(event.target.value)}
                          className="w-full rounded border border-gray-300 px-3 py-2"
                        >
                          <option value="7">Last 7 days</option>
                          <option value="30">Last 30 days</option>
                          <option value="90">Last 90 days</option>
                        </select>
                      </label>

                      <div className="flex items-end">
                        <button
                          type="submit"
                          disabled={isChangingPage}
                          className="w-full rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
                        >
                          Search
                        </button>
                      </div>

                      <div className="flex items-end">
                        <button
                          type="button"
                          onClick={handleClearSearch}
                          disabled={!isSearchActive && !searchInput.trim()}
                          className="w-full rounded border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:text-gray-400"
                        >
                          Clear
                        </button>
                      </div>
                    </form>

                    {isSearchActive && !isLoading && !error && (
                      <div className="mt-4 text-sm text-gray-600">
                        {totalMatches === 0
                          ? `No questions matching "${activeSearch?.q}" in the last ${activeSearch?.daysBack ?? 30} days.`
                          : `${totalMatches} match${totalMatches === 1 ? "" : "es"} in the last ${activeSearch?.daysBack ?? 30} days`}
                        {searchTruncated && (
                          <span className="block text-amber-700 mt-1">
                            Search stopped after scanning {data?.scannedCount?.toLocaleString()} recent answers. Try a
                            shorter date range or a more specific keyword.
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Error state */}
                  {error && (
                    <div className="text-red-500 text-center my-6">
                      {error instanceof Error ? error.message : "Error loading answers"}
                    </div>
                  )}

                  {/* Top pagination controls */}
                  {answersData.length > 0 && (
                    <div className="flex justify-center mb-6">
                      <button
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1 || isChangingPage}
                        className="px-4 py-2 mr-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
                      >
                        Previous
                      </button>
                      <span className="px-4 py-2">
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages || isChangingPage}
                        className="px-4 py-2 ml-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
                      >
                        Next
                      </button>
                    </div>
                  )}

                  {/* List of answers */}
                  <div>
                    {answersData.map((answer) => (
                      <AnswerItem
                        key={answer.id}
                        answer={answer}
                        siteConfig={siteConfig}
                        handleCopyLink={handleCopyLink}
                        handleDelete={isAdmin ? handleDelete : undefined}
                        linkCopied={linkCopied}
                        isSudoUser={isAdmin}
                        isFullPage={false}
                      />
                    ))}
                  </div>

                  {/* Empty state */}
                  {answersData.length === 0 && !isLoading && !error && (
                    <div className="text-center py-8">
                      <p>{isSearchActive ? `No questions matching "${activeSearch?.q}" in the last ${activeSearch?.daysBack ?? 30} days.` : "No answers found."}</p>
                    </div>
                  )}

                  {/* Bottom pagination controls */}
                  {answersData.length > 0 && (
                    <div className="flex justify-center mt-6">
                      <button
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1 || isChangingPage}
                        className="px-4 py-2 mr-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
                      >
                        Previous
                      </button>
                      <span className="px-4 py-2">
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages || isChangingPage}
                        className="px-4 py-2 ml-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Error messages */}
            {deleteMutation.isError && (
              <div className="text-red-500 text-sm mt-2 text-center">
                {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Failed to delete answer"}
              </div>
            )}
          </>
        )}
      </Layout>
    </SudoProvider>
  );
};

// Server-side props to load site configuration and check permissions
export const getServerSideProps: GetServerSideProps = async (context) => {
  const siteId = process.env.SITE_ID || "default";
  const siteConfig = await loadSiteConfig(siteId);

  if (!siteConfig) {
    return {
      notFound: true,
    };
  }

  // Check if user is allowed to access the answers page
  const req = context.req as unknown as NextApiRequest;
  const res = context.res as unknown as NextApiResponse;

  const isAllowed = await isAnswersPageAllowed(req, res, siteConfig);

  if (!isAllowed) {
    const errorMessage = getAnswersPageErrorMessage(siteConfig);
    return {
      props: {
        siteConfig,
        authorizationError: true,
        errorMessage,
      },
    };
  }

  return {
    props: { siteConfig },
  };
};

export default AllAnswers;
