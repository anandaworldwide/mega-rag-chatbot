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
import { firestoreGetAll, firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { DownvoteFeedbackEvent } from "@/types/downvoteFeedback";
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
    name: "downvote-sync-status-api",
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

  const limit = Math.min(Number(req.body?.limit) || 500, 2000);
  const dryRun = req.body?.dryRun === true;

  try {
    const answersSnapshot = await firestoreQueryGet(
      db.collection(getAnswersCollectionName()).where("vote", "==", -1).limit(limit),
      "sync downvote answer status mirror",
      `limit=${limit}`
    );

    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let skippedNoEvent = 0;
    let missingEvent = 0;

    const eventsCollection = db.collection(getDownvoteFeedbackEventsCollectionName());
    const linkedEventIds: string[] = answersSnapshot.docs.map(
      (d: firebase.firestore.QueryDocumentSnapshot): string => {
        const answerData = d.data() as Record<string, any>;
        return typeof answerData.feedbackEventId === "string" ? answerData.feedbackEventId : "";
      }
    );
    const uniqueEventIds = [...new Set(linkedEventIds.filter((id) => id.length > 0))];
    const eventRefs = uniqueEventIds.map((id) => eventsCollection.doc(id));
    const eventSnapshots = await firestoreGetAll(db, eventRefs, "batch sync downvote mirror get events", `n=${eventRefs.length}`);
    const eventDocById = new Map<string, (typeof eventSnapshots)[0]>();
    uniqueEventIds.forEach((id, index) => {
      eventDocById.set(id, eventSnapshots[index]);
    });

    for (const answerDoc of answersSnapshot.docs as firebase.firestore.QueryDocumentSnapshot[]) {
      scanned += 1;
      const answerData = answerDoc.data() as Record<string, any>;
      const eventId = typeof answerData.feedbackEventId === "string" ? answerData.feedbackEventId : "";
      if (!eventId) {
        skippedNoEvent += 1;
        continue;
      }

      const eventDoc = eventDocById.get(eventId);
      if (!eventDoc?.exists) {
        missingEvent += 1;
        continue;
      }

      const eventData = eventDoc.data() as DownvoteFeedbackEvent;
      const updates: Record<string, unknown> = {};

      const nextStatus = eventData.triageStatus;
      const nextOperatorDecision = eventData.operatorDecision;
      const nextNotionTaskUrl = eventData.notionTaskUrl;

      if (answerData.feedbackTriageStatus !== nextStatus) {
        updates.feedbackTriageStatus = nextStatus;
      }

      if ((answerData.feedbackOperatorDecision ?? null) !== (nextOperatorDecision ?? null)) {
        updates.feedbackOperatorDecision =
          nextOperatorDecision ?? firebase.firestore.FieldValue.delete();
      }

      if ((answerData.feedbackNotionTaskUrl ?? null) !== (nextNotionTaskUrl ?? null)) {
        updates.feedbackNotionTaskUrl = nextNotionTaskUrl || firebase.firestore.FieldValue.delete();
      }

      if (Object.keys(updates).length === 0) {
        unchanged += 1;
        continue;
      }

      updated += 1;
      if (!dryRun) {
        await firestoreUpdate(
          db.collection(getAnswersCollectionName()).doc(answerDoc.id),
          updates,
          "sync downvote mirror apply updates",
          answerDoc.id
        );
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      scanned,
      updated,
      unchanged,
      skippedNoEvent,
      missingEvent,
    });
  } catch (error) {
    return res.status(500).json({
      error: getSafeErrorMessage(error, "Failed to sync downvote status mirrors"),
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
