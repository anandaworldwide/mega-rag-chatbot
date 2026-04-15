// This file handles API requests for fetching downvoted answers.
// It is used by the admin interface to review and manage answers that have been downvoted by users.

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import { DownvoteFeedbackEvent, DownvoteFeedbackReason, DownvoteGroupBy, DownvoteTriageCategory, DownvoteTriageStatus } from "@/types/downvoteFeedback";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 40, // 40 requests per 5 minutes
    name: "downvoted-answers-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check if db is available
  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Verify superuser role from Firestore (source of truth)
    await requireSuperuserRoleFromFirestore(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20; // Fixed limit of 20 items per page
    const triageStatus = ((req.query.triageStatus as string) || "all") as DownvoteTriageStatus | "all";
    const triageCategory = ((req.query.triageCategory as string) || "all") as DownvoteTriageCategory | "all";
    const feedbackReason = ((req.query.feedbackReason as string) || "all") as DownvoteFeedbackReason | "all";
    const identityMode = ((req.query.identityMode as string) || "all") as "identified" | "anonymous" | "all";
    const groupBy = ((req.query.groupBy as string) || "none") as DownvoteGroupBy;

    const answersRef = db.collection(getAnswersCollectionName());
    const downvotedAnswersSnapshot = await answersRef
      .where("vote", "==", -1)
      .orderBy("timestamp", "desc")
      .get();

    const allDownvotedAnswers = downvotedAnswersSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        question: data.question || "",
        answer: data.answer || "",
        vote: data.vote || 0,
        timestamp: data.timestamp?.toDate?.() || null,
        collection: data.collection,
        adminAction: data.adminAction,
        adminActionTimestamp: data.adminActionTimestamp,
        sources: data.sources || [],
        feedbackReason: data.feedbackReason || "",
        feedbackComment: data.feedbackComment || "",
        feedbackTimestamp: data.feedbackTimestamp?.toDate?.() || null,
        feedbackEventId: data.feedbackEventId || null,
        feedbackIdentityMode: data.feedbackIdentityMode || "anonymous",
        feedbackIdentityShareRequested: typeof data.feedbackIdentityShareRequested === "boolean" ? data.feedbackIdentityShareRequested : true,
        feedbackReporterDisplayName: data.feedbackReporterDisplayName || null,
        feedbackTriageStatus: data.feedbackTriageStatus || "classified",
        feedbackTriageMethod: data.feedbackTriageMethod || "heuristic",
        feedbackTriageCategory: data.feedbackTriageCategory || "unclear",
        feedbackTriageConfidence: typeof data.feedbackTriageConfidence === "number" ? data.feedbackTriageConfidence : 0,
        feedbackTriageSummary: data.feedbackTriageSummary || "",
        feedbackRecommendedAction: data.feedbackRecommendedAction || "",
        feedbackTaskCandidateKey: data.feedbackTaskCandidateKey || "",
        feedbackNotionTaskUrl: data.feedbackNotionTaskUrl || "",
        feedbackOperatorDecision: data.feedbackOperatorDecision,
      };
    });

    const filteredAnswers = allDownvotedAnswers.filter((answer) => {
      if (triageStatus !== "all" && answer.feedbackTriageStatus !== triageStatus) {
        return false;
      }
      if (triageCategory !== "all" && answer.feedbackTriageCategory !== triageCategory) {
        return false;
      }
      if (feedbackReason !== "all" && answer.feedbackReason !== feedbackReason) {
        return false;
      }
      if (identityMode !== "all" && answer.feedbackIdentityMode !== identityMode) {
        return false;
      }
      return true;
    });

    const total = filteredAnswers.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = Math.min(page, totalPages);
    const currentOffset = (currentPage - 1) * limit;
    const downvotedAnswers = filteredAnswers.slice(currentOffset, currentOffset + limit);

    const groups =
      groupBy === "none"
        ? []
        : DownvoteFeedbackService.buildClusters(
            filteredAnswers.map(
              (answer) =>
                ({
                  id: answer.feedbackEventId || answer.id,
                  answerDocId: answer.id,
                  site: process.env.SITE_ID || "default",
                  createdAt: answer.feedbackTimestamp || answer.timestamp,
                  question: answer.question,
                  answer: answer.answer,
                  feedbackReason: answer.feedbackReason,
                  feedbackComment: answer.feedbackComment,
                  identityMode: answer.feedbackIdentityMode || "anonymous",
                  identityShareRequested: Boolean(answer.feedbackIdentityShareRequested),
                  identityConsentDefaulted: true,
                  triageStatus: answer.feedbackTriageStatus || "classified",
                  triageMethod: answer.feedbackTriageMethod || "heuristic",
                  triageCategory: answer.feedbackTriageCategory || "unclear",
                  triageConfidence: answer.feedbackTriageConfidence || 0,
                  triageSummary: answer.feedbackTriageSummary || "",
                  recommendedAction: answer.feedbackRecommendedAction || "",
                  taskCandidateKey:
                    groupBy === "category"
                      ? `category_${answer.feedbackTriageCategory || "unclear"}`
                      : answer.feedbackTaskCandidateKey || `${answer.feedbackTriageCategory || "unclear"}_${answer.feedbackReason || "other"}`,
                }) as DownvoteFeedbackEvent
            )
          );

    return res.status(200).json({
      answers: downvotedAnswers,
      groups,
      totalItems: total,
      totalPages,
      currentPage,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Error fetching downvoted answers:", error instanceof Error ? error.name : "Unknown error");
    
    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({ error: "Forbidden: Superuser privileges required" });
    }
    
    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Something went wrong");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
