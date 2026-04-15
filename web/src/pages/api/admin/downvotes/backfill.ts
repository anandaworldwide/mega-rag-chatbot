import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { getAnswersCollectionName, getDownvoteFeedbackEventsCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreAdd, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import { DownvoteFeedbackTriageService } from "@/utils/server/downvoteFeedbackTriageService";
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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 10,
    name: "downvote-backfill-api",
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
    const message = error?.message || "Forbidden";
    return res.status(403).json({ error: message });
  }

  const limit = Math.min(Number(req.body?.limit) || 100, 200);
  const shouldUpgradeWithLlm = req.body?.upgradeWithLlm !== false;

  try {
    const answersSnapshot = await firestoreQueryGet(
      db.collection(getAnswersCollectionName()).where("vote", "==", -1).limit(limit),
      "backfill downvote answers",
      `limit=${limit}`
    );

    const triageService = new DownvoteFeedbackTriageService();
    const createdEventIds: Array<{ eventId: string; answerDocId: string }> = [];
    let skipped = 0;

    for (const doc of answersSnapshot.docs) {
      const answerData = doc.data() as Record<string, any>;
      if (!answerData.feedbackReason || !DownvoteFeedbackService.isValidFeedbackReason(answerData.feedbackReason)) {
        skipped += 1;
        continue;
      }

      const existingEventSnapshot = await firestoreQueryGet(
        db.collection(getDownvoteFeedbackEventsCollectionName()).where("answerDocId", "==", doc.id).limit(1),
        "check existing downvote feedback event",
        doc.id
      );

      if (!existingEventSnapshot.empty) {
        skipped += 1;
        continue;
      }

      const eventRecord = DownvoteFeedbackService.buildEventRecord({
        answerDocId: doc.id,
        answerData,
        feedbackReason: answerData.feedbackReason,
        feedbackComment: answerData.feedbackComment || "",
        reporterIdentity: {
          identityMode: "anonymous",
          identityShareRequested: false,
          identityConsentDefaulted: false,
        },
      });

      const eventRef = await firestoreAdd(
        db.collection(getDownvoteFeedbackEventsCollectionName()),
        eventRecord,
        "backfill downvote feedback event",
        doc.id
      );
      await firestoreUpdate(
        db.collection(getAnswersCollectionName()).doc(doc.id),
        DownvoteFeedbackService.buildAnswerFeedbackMirror(eventRef.id, eventRecord),
        "mirror backfilled downvote feedback event",
        doc.id
      );
      createdEventIds.push({ eventId: eventRef.id, answerDocId: doc.id });
    }

    if (shouldUpgradeWithLlm) {
      for (const createdEvent of createdEventIds) {
        await triageService.enrichFeedbackEvent(createdEvent.eventId, createdEvent.answerDocId);
      }
    }

    return res.status(200).json({
      ok: true,
      created: createdEventIds.length,
      skipped,
      upgradedWithLlm: shouldUpgradeWithLlm,
    });
  } catch (error) {
    return res.status(500).json({
      error: getSafeErrorMessage(error, "Failed to backfill downvote feedback events"),
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
