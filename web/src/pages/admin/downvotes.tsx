import Head from "next/head";
import DownvotedAnswerReview from "@/components/DownvotedAnswerReview";
import { SiteConfig } from "@/types/siteConfig";
import { SudoProvider } from "@/contexts/SudoContext";
import type { GetServerSideProps, NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { AdminLayout } from "@/components/AdminLayout";
import { useDownvotedAnswers } from "@/hooks/useAnswers";
import { Answer } from "@/types/answer";
import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/router";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { DownvoteAnswerFilters, DOWNVOTE_FEEDBACK_REASONS, DOWNVOTE_TRIAGE_CATEGORIES, DOWNVOTE_TRIAGE_STATUSES } from "@/types/downvoteFeedback";

interface DownvotesReviewProps {
  siteConfig: SiteConfig | null;
}

const DownvotesReview = ({ siteConfig }: DownvotesReviewProps) => {
  const router = useRouter();
  const page = parseInt(router.query.page as string) || 1;
  const defaultTriageStatus: DownvoteAnswerFilters["triageStatus"] = "classified";
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [isRunningBackfill, setIsRunningBackfill] = useState(false);
  const [isRunningClassify, setIsRunningClassify] = useState(false);
  const [isRunningClearStale, setIsRunningClearStale] = useState(false);
  const [isRunningDigest, setIsRunningDigest] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const filters = useMemo<DownvoteAnswerFilters>(
    () => ({
      triageStatus:
        typeof router.query.triageStatus === "string"
          ? (router.query.triageStatus as DownvoteAnswerFilters["triageStatus"])
          : defaultTriageStatus,
      triageCategory:
        typeof router.query.triageCategory === "string" ? (router.query.triageCategory as DownvoteAnswerFilters["triageCategory"]) : "all",
      feedbackReason:
        typeof router.query.feedbackReason === "string" ? (router.query.feedbackReason as DownvoteAnswerFilters["feedbackReason"]) : "all",
      identityMode:
        typeof router.query.identityMode === "string" ? (router.query.identityMode as DownvoteAnswerFilters["identityMode"]) : "all",
      groupBy: typeof router.query.groupBy === "string" ? (router.query.groupBy as DownvoteAnswerFilters["groupBy"]) : "none",
    }),
    [defaultTriageStatus, router.query.feedbackReason, router.query.groupBy, router.query.identityMode, router.query.triageCategory, router.query.triageStatus]
  );

  const { data, isLoading, error } = useDownvotedAnswers(page, filters);

  // Reset isChangingPage when data loads or router is ready
  useEffect(() => {
    if (data && !isLoading) {
      setIsChangingPage(false);
    }
  }, [data, isLoading]);

  const updateFilters = (partialFilters: Partial<DownvoteAnswerFilters>) => {
    const nextQuery = {
      ...router.query,
      page: 1,
      ...partialFilters,
    } as Record<string, string | number>;

    Object.keys(nextQuery).forEach((key) => {
      if (key === "triageStatus" && nextQuery[key] === defaultTriageStatus) {
        delete nextQuery[key];
        return;
      }
      if (
        (key !== "triageStatus" && nextQuery[key] === "all") ||
        nextQuery[key] === "none" ||
        nextQuery[key] === "" ||
        nextQuery[key] === undefined
      ) {
        delete nextQuery[key];
      }
    });

    router.push({
      pathname: router.pathname,
      query: nextQuery,
    });
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || (data?.totalPages && newPage > data.totalPages)) {
      return;
    }
    setIsChangingPage(true);
    router.push({
      pathname: router.pathname,
      query: { ...router.query, page: newPage },
    });
  };

  const runAdminAction = async (
    url: string,
    body: Record<string, unknown>,
    setLoadingState: (value: boolean) => void,
    successMessage: string
  ) => {
    setActionMessage(null);
    setLoadingState(true);
    try {
      const response = await fetchWithAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }
      setActionMessage(successMessage);
      router.replace(router.asPath);
    } catch (requestError) {
      setActionMessage(requestError instanceof Error ? requestError.message : "Request failed");
    } finally {
      setLoadingState(false);
    }
  };

  if (isLoading && !data) {
    return (
      <SudoProvider disableChecks={!!siteConfig?.requireLogin}>
        <AdminLayout siteConfig={siteConfig} pageTitle="Review Downvotes" superuserOnly>
          <div className="flex justify-center items-center min-h-screen">
            <div
              role="status"
              className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"
              aria-label="Loading"
            ></div>
          </div>
        </AdminLayout>
      </SudoProvider>
    );
  }

  if (!siteConfig) {
    return (
      <SudoProvider disableChecks={false}>
        <AdminLayout siteConfig={null} pageTitle="Review Downvotes" superuserOnly>
          <div className="text-red-600">Error: Site configuration not available</div>
        </AdminLayout>
      </SudoProvider>
    );
  }

  if (error) {
    return (
      <SudoProvider disableChecks={!!siteConfig?.requireLogin}>
        <AdminLayout siteConfig={siteConfig} pageTitle="Review Downvotes" superuserOnly>
          <div className="text-red-600">
            Error: {error instanceof Error ? error.message : "Failed to fetch downvoted answers"}
          </div>
        </AdminLayout>
      </SudoProvider>
    );
  }

  const mainContent = (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Review Downvoted Answers</h1>
        <p className="text-sm text-gray-600 mt-1">Review, classify, cluster, and route downvoted answers</p>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid gap-4 md:grid-cols-5">
          <label className="text-sm text-gray-700">
            <div className="mb-1 font-medium">Status</div>
            <select
              value={filters.triageStatus || "all"}
              onChange={(event) => updateFilters({ triageStatus: event.target.value as DownvoteAnswerFilters["triageStatus"] })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="all">All</option>
              {DOWNVOTE_TRIAGE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            <div className="mb-1 font-medium">Category</div>
            <select
              value={filters.triageCategory || "all"}
              onChange={(event) => updateFilters({ triageCategory: event.target.value as DownvoteAnswerFilters["triageCategory"] })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="all">All</option>
              {DOWNVOTE_TRIAGE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            <div className="mb-1 font-medium">Reason</div>
            <select
              value={filters.feedbackReason || "all"}
              onChange={(event) => updateFilters({ feedbackReason: event.target.value as DownvoteAnswerFilters["feedbackReason"] })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="all">All</option>
              {DOWNVOTE_FEEDBACK_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-700">
            <div className="mb-1 font-medium">Identity</div>
            <select
              value={filters.identityMode || "all"}
              onChange={(event) => updateFilters({ identityMode: event.target.value as DownvoteAnswerFilters["identityMode"] })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="identified">Identified</option>
              <option value="anonymous">Anonymous</option>
            </select>
          </label>

          <label className="text-sm text-gray-700">
            <div className="mb-1 font-medium">Group by</div>
            <select
              value={filters.groupBy || "none"}
              onChange={(event) => updateFilters({ groupBy: event.target.value as DownvoteAnswerFilters["groupBy"] })}
              className="w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="none">None</option>
              <option value="category">Category</option>
              <option value="task">Task candidate</option>
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={() => runAdminAction("/api/admin/downvotes/backfill", { limit: 100 }, setIsRunningBackfill, "Legacy downvotes backfilled.")}
            disabled={isRunningBackfill}
            className="rounded bg-gray-800 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-400"
          >
            {isRunningBackfill ? "Backfilling..." : "Backfill legacy downvotes"}
          </button>
          <button
            onClick={() => runAdminAction("/api/admin/downvotes/classify", { limit: 50 }, setIsRunningClassify, "Pending downvotes classified.")}
            disabled={isRunningClassify}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-blue-300"
          >
            {isRunningClassify ? "Classifying..." : "Classify recent heuristics"}
          </button>
          <button
            onClick={() =>
              runAdminAction(
                "/api/admin/downvotes/clearStale",
                { limit: 1000 },
                setIsRunningClearStale,
                "Stale legacy downvotes cleared from chat logs."
              )
            }
            disabled={isRunningClearStale}
            className="rounded bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:bg-rose-300"
          >
            {isRunningClearStale ? "Clearing stale..." : "Clear stale legacy downvotes"}
          </button>
          <button
            onClick={() =>
              runAdminAction("/api/admin/downvoteFeedbackDigest", { createTasks: true }, setIsRunningDigest, "Digest generated and draft Notion tasks attempted.")
            }
            disabled={isRunningDigest}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:bg-emerald-300"
          >
            {isRunningDigest ? "Running digest..." : "Run digest + task routing"}
          </button>
        </div>

        {actionMessage && <div className="mt-3 text-sm text-gray-700">{actionMessage}</div>}
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="text-sm font-medium text-gray-900">Queue summary</div>
        <div className="mt-1 text-sm text-gray-600">
          {data?.totalItems || 0} matching downvotes across {data?.totalPages || 1} page{data?.totalPages === 1 ? "" : "s"}
        </div>
      </div>

      {filters.groupBy !== "none" && data?.groups?.length ? (
        <div className="mb-6 rounded-lg border border-blue-100 bg-blue-50 p-4">
          <h2 className="text-lg font-semibold text-gray-900">Grouped issues</h2>
          <div className="mt-3 space-y-3">
            {data.groups.map((group) => (
              <div key={group.key} className="rounded border border-blue-100 bg-white p-3">
                <div className="font-medium text-gray-900">{group.label}</div>
                <div className="text-sm text-gray-600">
                  {group.totalEvents} downvotes, avg confidence {group.averageConfidence.toFixed(2)}, action: {group.recommendedAction}
                </div>
                {group.notionTaskUrl && (
                  <a href={group.notionTaskUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-blue-700 hover:underline">
                    Open linked Notion draft
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!data?.answers || data.answers.length === 0 ? (
        <p>No downvoted answers to review.</p>
      ) : (
        <>
          <div className="space-y-6">
            {data.answers.map((answer: Answer) => (
              <DownvotedAnswerReview key={answer.id} answer={answer} siteConfig={siteConfig} isSudoAdmin={true} />
            ))}
          </div>

          {/* Pagination controls */}
          <div className="flex justify-center mt-6 space-x-4">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1 || isChangingPage}
              className="px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
            >
              Previous
            </button>
            <span className="px-4 py-2">
              Page {data.currentPage} of {data.totalPages}
            </span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= data.totalPages || isChangingPage}
              className="px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  );

  return (
    <SudoProvider disableChecks={!!siteConfig?.requireLogin}>
      <>
        <Head>
          <title>Review Downvotes - Admin</title>
        </Head>
        <AdminLayout siteConfig={siteConfig} pageTitle="Review Downvotes" superuserOnly>
          <div className="max-w-4xl">{mainContent}</div>
        </AdminLayout>
      </>
    </SudoProvider>
  );
};

export default DownvotesReview;

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const siteConfig = await loadSiteConfig();
  const allowed = isSuperuserPageAllowed(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    siteConfig
  );
  if (!allowed) {
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
  return { props: { siteConfig } };
};
