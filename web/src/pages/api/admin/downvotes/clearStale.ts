import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { getAnswersCollectionName, getDownvoteFeedbackEventsCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function ensureAdminAccess(req: NextApiRequest, res: NextApiResponse) {
  const siteConfig = loadSiteConfigSync();
  if (siteConfig?.requireLogin) {
    await requireSuperuserRoleFromFirestore(req);
    return;
  }

  const sudo = getSudoCookie(req, res);
  if (!sudo.sudoCookieValue) {
    throw new Error(`Forbidden: ${sudo.message}`);
  }
}

function buildClearDownvoteFieldsUpdate(): Record<string, unknown> {
  return {
    vote: 0,
    feedbackReason: firebase.firestore.FieldValue.delete(),
    feedbackComment: firebase.firestore.FieldValue.delete(),
    feedbackTimestamp: firebase.firestore.FieldValue.delete(),
    feedbackEventId: firebase.firestore.FieldValue.delete(),
    feedbackIdentityMode: firebase.firestore.FieldValue.delete(),
    feedbackIdentityShareRequested: firebase.firestore.FieldValue.delete(),
    feedbackReporterDisplayName: firebase.firestore.FieldValue.delete(),
    feedbackTriageStatus: firebase.firestore.FieldValue.delete(),
    feedbackTriageMethod: firebase.firestore.FieldValue.delete(),
    feedbackTriageCategory: firebase.firestore.FieldValue.delete(),
    feedbackTriageConfidence: firebase.firestore.FieldValue.delete(),
    feedbackTriageSummary: firebase.firestore.FieldValue.delete(),
    feedbackRecommendedAction: firebase.firestore.FieldValue.delete(),
    feedbackTaskCandidateKey: firebase.firestore.FieldValue.delete(),
    feedbackNotionTaskUrl: firebase.firestore.FieldValue.delete(),
    feedbackOperatorDecision: firebase.firestore.FieldValue.delete(),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 10,
    name: "downvote-clear-stale-api",
  });
  if (!isAllowed) {
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    await ensureAdminAccess(req, res);
  } catch (error: any) {
    return res.status(403).json({ error: error?.message || "Forbidden" });
  }

  const limit = Math.min(Number(req.body?.limit) || 500, 2000);
  const dryRun = req.body?.dryRun === true;

  try {
    const answersSnapshot = await firestoreQueryGet(
      db.collection(getAnswersCollectionName()).where("vote", "==", -1).limit(limit),
      "clear stale downvote mirrors",
      `limit=${limit}`
    );

    let scanned = 0;
    let cleared = 0;
    let keptLinked = 0;
    let orphanedNoEventId = 0;
    let orphanedMissingEvent = 0;

    for (const answerDoc of answersSnapshot.docs) {
      scanned += 1;
      const answerData = answerDoc.data() as Record<string, any>;
      const eventId = typeof answerData.feedbackEventId === "string" ? answerData.feedbackEventId : "";

      let shouldClear = false;
      if (!eventId) {
        shouldClear = true;
        orphanedNoEventId += 1;
      } else {
        const eventDoc = await firestoreGet(
          db.collection(getDownvoteFeedbackEventsCollectionName()).doc(eventId),
          "check stale downvote linked event",
          eventId
        );
        if (!eventDoc.exists) {
          shouldClear = true;
          orphanedMissingEvent += 1;
        }
      }

      if (!shouldClear) {
        keptLinked += 1;
        continue;
      }

      cleared += 1;
      if (!dryRun) {
        await firestoreUpdate(
          db.collection(getAnswersCollectionName()).doc(answerDoc.id),
          buildClearDownvoteFieldsUpdate(),
          "clear stale downvote mirror fields",
          answerDoc.id
        );
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      scanned,
      cleared,
      keptLinked,
      orphanedNoEventId,
      orphanedMissingEvent,
    });
  } catch (error) {
    return res.status(500).json({
      error: getSafeErrorMessage(error, "Failed to clear stale downvotes"),
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
