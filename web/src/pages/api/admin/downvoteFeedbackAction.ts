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
import { DownvoteFeedbackCluster, DownvoteFeedbackEvent, DownvoteOperatorDecision } from "@/types/downvoteFeedback";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import { NotionTaskClient } from "@/utils/server/notionTaskClient";
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

function isValidDecision(value: unknown): value is DownvoteOperatorDecision {
  return value === "accept" || value === "modify" || value === "reject" || value === "no_action";
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 100,
    name: "downvote-feedback-action-api",
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

  const { answerDocId, eventId, operatorDecision, operatorNote, createNotionTask, notionTaskUrl } = req.body || {};

  if (!answerDocId || typeof answerDocId !== "string") {
    return res.status(400).json({ error: "Missing answerDocId" });
  }

  if (operatorDecision !== undefined && !isValidDecision(operatorDecision)) {
    return res.status(400).json({ error: "Invalid operatorDecision" });
  }

  if (operatorNote !== undefined && typeof operatorNote !== "string") {
    return res.status(400).json({ error: "Invalid operatorNote" });
  }

  if (notionTaskUrl !== undefined && typeof notionTaskUrl !== "string") {
    return res.status(400).json({ error: "Invalid notionTaskUrl" });
  }

  try {
    const answerRef = db.collection(getAnswersCollectionName()).doc(answerDocId);
    const answerDoc = await firestoreGet(answerRef, "get answer for downvote feedback action", answerDocId);
    if (!answerDoc.exists) {
      return res.status(404).json({ error: "Answer not found" });
    }

    const answerData = answerDoc.data() as Record<string, any>;
    const resolvedEventId = typeof eventId === "string" && eventId ? eventId : answerData.feedbackEventId;
    if (!resolvedEventId) {
      return res.status(400).json({ error: "No feedback event is linked to this answer" });
    }

    const eventRef = db.collection(getDownvoteFeedbackEventsCollectionName()).doc(resolvedEventId);
    const eventDoc = await firestoreGet(eventRef, "get downvote feedback event for operator action", resolvedEventId);
    if (!eventDoc.exists) {
      return res.status(404).json({ error: "Feedback event not found" });
    }

    const eventData = { id: resolvedEventId, ...(eventDoc.data() as DownvoteFeedbackEvent) };
    let linkedNotionUrl = typeof notionTaskUrl === "string" && notionTaskUrl.trim() ? notionTaskUrl.trim() : eventData.notionTaskUrl;
    let linkedNotionId = eventData.notionTaskId;

    if (createNotionTask === true) {
      const clusterSnapshot = await firestoreQueryGet(
        db.collection(getDownvoteFeedbackEventsCollectionName()).where("taskCandidateKey", "==", eventData.taskCandidateKey),
        "load downvote feedback cluster for notion task",
        eventData.taskCandidateKey
      );
      const clusterEvents: DownvoteFeedbackEvent[] = clusterSnapshot.docs.map(
        (doc: { id: string; data: () => DownvoteFeedbackEvent }) =>
          ({ id: doc.id, ...(doc.data() as DownvoteFeedbackEvent) }) as DownvoteFeedbackEvent
      );
      const cluster: DownvoteFeedbackCluster =
        DownvoteFeedbackService.buildClusters(clusterEvents)[0] || DownvoteFeedbackService.buildClusters([eventData])[0];

      const notionClient = new NotionTaskClient();
      if (!notionClient.isConfigured()) {
        return res.status(400).json({ error: "Notion draft task creation is not configured" });
      }

      // Reuse an existing cluster task only if it is still active on the Kanban board.
      linkedNotionUrl = undefined;
      linkedNotionId = undefined;
      const candidateTasks = clusterEvents
        .filter((event) => Boolean(event.notionTaskId) && Boolean(event.notionTaskUrl))
        .sort((left, right) =>
          (DownvoteFeedbackService.toIsoString(right.createdAt) || "").localeCompare(
            DownvoteFeedbackService.toIsoString(left.createdAt) || ""
          )
        );

      const reusableTask = await notionClient.findReusableTask(
        candidateTasks.map((candidate) => ({
          taskId: candidate.notionTaskId,
          taskUrl: candidate.notionTaskUrl,
        }))
      );
      linkedNotionId = reusableTask?.id;
      linkedNotionUrl = reusableTask?.url;

      if (!linkedNotionUrl || !linkedNotionId) {
        const createdTask = await notionClient.createDraftTask(cluster);
        linkedNotionUrl = createdTask?.url;
        linkedNotionId = createdTask?.id;
      }
    }

    const eventUpdates: Record<string, unknown> = {};
    const answerUpdates: Record<string, unknown> = {};

    if (operatorDecision !== undefined) {
      const nextTriageStatus = operatorDecision === "no_action" ? "ignored" : linkedNotionUrl ? "task_created" : "reviewed";
      eventUpdates.operatorDecision = operatorDecision;
      eventUpdates.operatorReviewedAt = firebase.firestore.FieldValue.serverTimestamp();
      eventUpdates.triageStatus = nextTriageStatus;
      answerUpdates.feedbackOperatorDecision = operatorDecision;
      answerUpdates.feedbackTriageStatus = nextTriageStatus;
    }

    if (operatorNote !== undefined) {
      eventUpdates.operatorNote = operatorNote.trim();
    }

    if (linkedNotionUrl) {
      eventUpdates.notionTaskUrl = linkedNotionUrl;
      eventUpdates.notionTaskId = linkedNotionId || firebase.firestore.FieldValue.delete();
      eventUpdates.triageStatus = "task_created";
      answerUpdates.feedbackNotionTaskUrl = linkedNotionUrl;
      answerUpdates.feedbackTriageStatus = "task_created";
    }

    if (Object.keys(eventUpdates).length > 0) {
      await firestoreUpdate(eventRef, eventUpdates, "update downvote feedback event operator action", resolvedEventId);
    }

    if (Object.keys(answerUpdates).length > 0) {
      await firestoreUpdate(answerRef, answerUpdates, "update answer operator action mirror", answerDocId);
    }

    return res.status(200).json({
      ok: true,
      eventId: resolvedEventId,
      operatorDecision: operatorDecision ?? eventData.operatorDecision ?? null,
      notionTaskUrl: linkedNotionUrl || null,
    });
  } catch (error) {
    return res.status(500).json({
      error: getSafeErrorMessage(error, "Failed to update downvote feedback"),
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
