import type { NextApiRequest, NextApiResponse } from "next";
import * as fbadmin from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getAnswersCollectionName, getDownvoteFeedbackEventsCollectionName } from "@/utils/server/firestoreUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { aggregateVoteStats, parseVoteStatsLookbackDays, VoteStatsAnswerDoc } from "@/utils/server/voteStatsUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 20,
    name: "admin-vote-stats",
  });
  if (!isAllowed) return;

  const siteConfig = loadSiteConfigSync();
  const loginRequired = !!siteConfig?.requireLogin;

  if (loginRequired) {
    try {
      await requireSuperuserRoleFromFirestore(req);
    } catch {
      return res.status(403).json({ error: "Unauthorized: Superuser access required" });
    }
  } else {
    const sudoStatus = getSudoCookie(req, res);
    if (!sudoStatus.sudoCookieValue) {
      return res.status(403).json({ error: "Unauthorized: Sudo access required" });
    }
  }

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const lookbackDays = parseVoteStatsLookbackDays(req.query.days);
    const now = new Date();
    const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const sinceTimestamp = fbadmin.firestore.Timestamp.fromDate(since);
    const answersCollection = getAnswersCollectionName();
    const eventsCollection = getDownvoteFeedbackEventsCollectionName();

    let answersSnapshot;
    try {
      answersSnapshot = await firestoreQueryGet(
        db.collection(answersCollection).where("timestamp", ">=", sinceTimestamp),
        "vote stats answers lookback",
        `since: ${since.toISOString()}`
      );
    } catch (firestoreError: unknown) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/vote-stats",
        collection: answersCollection,
        fields: ["timestamp"],
        query: "vote stats answers lookback",
      });
      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }
      throw firestoreError;
    }

    let eventsSnapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> } = { docs: [] };
    try {
      eventsSnapshot = await firestoreQueryGet(
        db.collection(eventsCollection).where("createdAt", ">=", sinceTimestamp),
        "vote stats downvote events lookback",
        `since: ${since.toISOString()}`
      );
    } catch (firestoreError: unknown) {
      // Events are supplemental; continue with answers if events query fails for non-index reasons
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/vote-stats",
        collection: eventsCollection,
        fields: ["createdAt"],
        query: "vote stats downvote events lookback",
      });
      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }
      console.warn("vote-stats: downvote events query failed; continuing with answers only", firestoreError);
    }

    const answers: VoteStatsAnswerDoc[] = answersSnapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      return {
        id: doc.id,
        question: data.question,
        vote: data.vote,
        model: data.model,
        abTestModel: data.abTestModel,
        isLocationQuery: data.isLocationQuery,
        feedbackReason: data.feedbackReason,
        feedbackComment: data.feedbackComment,
        timestamp: data.timestamp,
        feedbackTimestamp: data.feedbackTimestamp,
      };
    });

    const downvoteEvents = eventsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        answerDocId: typeof data.answerDocId === "string" ? data.answerDocId : null,
        question: typeof data.question === "string" ? data.question : null,
        feedbackReason: typeof data.feedbackReason === "string" ? data.feedbackReason : null,
        feedbackComment: typeof data.feedbackComment === "string" ? data.feedbackComment : null,
        model: typeof data.model === "string" ? data.model : null,
        abTestModel: typeof data.abTestModel === "string" ? data.abTestModel : null,
        triageCategory: typeof data.triageCategory === "string" ? data.triageCategory : null,
        triageStatus: typeof data.triageStatus === "string" ? data.triageStatus : null,
        createdAt: data.createdAt ?? null,
      };
    });

    const stats = aggregateVoteStats(answers, downvoteEvents);

    return res.status(200).json({
      siteId: siteConfig?.siteId || "unknown",
      lookbackDays,
      since: since.toISOString(),
      generatedAt: now.toISOString(),
      ...stats,
    });
  } catch (error) {
    console.error("Error fetching vote stats:", error);
    return res.status(500).json({ error: "Failed to load vote stats" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
