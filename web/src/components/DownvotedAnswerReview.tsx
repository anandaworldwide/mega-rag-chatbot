import React, { useState } from "react";
import Link from "next/link";
import { Answer } from "@/types/answer";
import TruncatedMarkdown from "./TruncatedMarkdown";
import SourcesList from "./SourcesList";
import { useMultipleCollections } from "../hooks/useMultipleCollections";
import { SiteConfig } from "../types/siteConfig";
import { fetchWithAuth } from "@/utils/client/tokenManager";

interface DownvotedAnswerReviewProps {
  answer: Answer;
  siteConfig: SiteConfig;
  isSudoAdmin?: boolean;
}

const DownvotedAnswerReview: React.FC<DownvotedAnswerReviewProps> = ({ answer, siteConfig, isSudoAdmin = false }) => {
  const hasMultipleCollections = useMultipleCollections(siteConfig);

  const [operatorDecision, setOperatorDecision] = useState(answer.feedbackOperatorDecision);
  const [notionTaskUrl, setNotionTaskUrl] = useState(answer.feedbackNotionTaskUrl);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const isResolvedVisual = Boolean(operatorDecision || notionTaskUrl);
  const resolvedStateLabel = notionTaskUrl
    ? "Sent to task board"
    : operatorDecision === "no_action"
      ? "Closed - no action"
      : operatorDecision
        ? "Reviewed - no task"
        : null;
  const resolvedChromeClasses = notionTaskUrl
    ? "border-2 border-emerald-300 bg-emerald-50 shadow-sm ring-1 ring-emerald-100"
    : operatorDecision === "no_action"
      ? "border-2 border-slate-300 bg-slate-100 shadow-sm ring-1 ring-slate-200"
      : operatorDecision
        ? "border-2 border-amber-300 bg-amber-50 shadow-sm ring-1 ring-amber-100"
        : "border border-transparent bg-white shadow-md";
  const resolvedBadgeClasses = notionTaskUrl
    ? "bg-emerald-600 text-white"
    : operatorDecision === "no_action"
      ? "bg-slate-600 text-white"
      : "bg-amber-500 text-white";
  const resolvedContentClasses = isResolvedVisual
    ? "rounded-md border border-white/70 bg-white/80 p-3 opacity-65 saturate-50"
    : "";

  const handleFeedbackAction = async (payload: {
    operatorDecision?: "accept" | "modify" | "reject" | "no_action";
    createNotionTask?: boolean;
  }) => {
    setActionError(null);
    setIsWorking(true);
    try {
      const response = await fetchWithAuth("/api/admin/downvoteFeedbackAction", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          answerDocId: answer.id,
          eventId: answer.feedbackEventId,
          ...payload,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to update feedback action");
      }

      if (payload.operatorDecision) {
        setOperatorDecision(payload.operatorDecision);
      }
      if (typeof data.notionTaskUrl === "string" && data.notionTaskUrl) {
        setNotionTaskUrl(data.notionTaskUrl);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update feedback action");
    } finally {
      setIsWorking(false);
    }
  };

  const formatTimestamp = (
    timestamp:
      | {
          _seconds: number;
          _nanoseconds: number;
        }
      | string
      | null
  ) => {
    if (!timestamp) {
      return "Unknown date";
    }

    // Handle string timestamp format
    if (typeof timestamp === "string") {
      return new Date(timestamp).toLocaleString();
    }

    // Handle Firestore timestamp format
    if (timestamp._seconds) {
      return new Date(timestamp._seconds * 1000).toLocaleString();
    }

    return "Unknown date";
  };

  // Parse sources if they are stored as a string
  const parsedSources = answer.sources
    ? Array.isArray(answer.sources)
      ? answer.sources
      : (() => {
          try {
            return JSON.parse(answer.sources as unknown as string);
          } catch {
            // Create a basic document structure for text sources
            return [
              {
                pageContent: answer.sources,
                metadata: {
                  type: "text",
                  title: "Legacy Source",
                },
              },
            ];
          }
        })()
    : [];

  return (
    <div className={`rounded-lg p-4 mb-4 transition-colors ${resolvedChromeClasses}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/share/${answer.id}`} className="text-black-600 hover:underline cursor-pointer">
          <h2 className="text-xl font-semibold mb-2">{answer.question}</h2>
        </Link>
        {resolvedStateLabel && (
          <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${resolvedBadgeClasses}`}>
            {resolvedStateLabel}
          </span>
        )}
      </div>
      <div className={resolvedContentClasses}>
        <div className="mb-4">
          <TruncatedMarkdown markdown={answer.answer || ""} maxCharacters={300} />
        </div>
        {parsedSources.length > 0 && (
          <SourcesList
            sources={parsedSources}
            collectionName={hasMultipleCollections ? answer.collection : null}
            siteConfig={siteConfig}
            isSudoAdmin={isSudoAdmin}
          />
        )}
        {(answer.feedbackReason || answer.feedbackComment) && (
          <div className="mt-3 p-3 bg-red-50 rounded-md border border-red-100">
            {answer.feedbackReason && (
              <div className="mb-2">
                <span className="font-medium text-red-700">Reason:</span>{" "}
                <span className="text-gray-800">{answer.feedbackReason}</span>
              </div>
            )}
            {answer.feedbackComment && (
              <div>
                <span className="font-medium text-red-700">Comments:</span>{" "}
                <span className="text-gray-800">{answer.feedbackComment}</span>
              </div>
            )}
          </div>
        )}
        <div className="mt-3 grid gap-2 text-sm text-gray-700 md:grid-cols-2">
          <div>
            <span className="font-medium">Identity:</span>{" "}
            {answer.feedbackIdentityMode === "identified"
              ? answer.feedbackReporterDisplayName || "Identified user"
              : "Anonymous"}
          </div>
          {answer.feedbackTriageCategory && (
            <div>
              <span className="font-medium">Category:</span> {answer.feedbackTriageCategory}
            </div>
          )}
          {answer.feedbackTriageConfidence !== undefined && (
            <div>
              <span className="font-medium">Confidence:</span> {Number(answer.feedbackTriageConfidence).toFixed(2)}
            </div>
          )}
          {answer.feedbackTriageMethod && (
            <div>
              <span className="font-medium">Method:</span> {answer.feedbackTriageMethod}
            </div>
          )}
        </div>
        {answer.feedbackTriageSummary && (
          <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-gray-800">
            <div className="font-medium text-blue-800">Triage summary</div>
            <div className="mt-1">{answer.feedbackTriageSummary}</div>
            {answer.feedbackRecommendedAction && (
              <div className="mt-2">
                <span className="font-medium">Recommended action:</span> {answer.feedbackRecommendedAction}
              </div>
            )}
          </div>
        )}
        <div className="mt-2 text-sm text-gray-600">Downvoted on: {formatTimestamp(answer.timestamp)}</div>
      </div>
      {operatorDecision && (
        <div className="mt-2 text-sm text-gray-600">Feedback decision: {operatorDecision.replace(/_/g, " ")}</div>
      )}
      {notionTaskUrl && (
        <a href={notionTaskUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-blue-700 hover:underline">
          Open linked Notion draft
        </a>
      )}
      {actionError && <div className="mt-2 text-sm text-red-600">{actionError}</div>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          onClick={() => handleFeedbackAction({ operatorDecision: "accept" })}
          disabled={isWorking}
          className="rounded bg-blue-100 px-3 py-2 text-sm text-blue-900 disabled:bg-blue-50"
        >
          Reviewed - no task
        </button>
        <button
          onClick={() => handleFeedbackAction({ operatorDecision: "no_action" })}
          disabled={isWorking}
          className="rounded bg-gray-100 px-3 py-2 text-sm text-gray-900 disabled:bg-gray-50"
        >
          Close - no action
        </button>
        <button
          onClick={() => handleFeedbackAction({ operatorDecision: "accept", createNotionTask: true })}
          disabled={isWorking || Boolean(notionTaskUrl)}
          className="rounded bg-emerald-100 px-3 py-2 text-sm text-emerald-900 disabled:bg-emerald-50"
        >
          {notionTaskUrl ? "Task linked" : "Send to task board"}
        </button>
      </div>
    </div>
  );
};

export default DownvotedAnswerReview;
