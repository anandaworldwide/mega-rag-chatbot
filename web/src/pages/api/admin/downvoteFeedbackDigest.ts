import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getAnswersCollectionName, getDownvoteFeedbackEventsCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { DownvoteFeedbackCluster, DownvoteFeedbackEvent } from "@/types/downvoteFeedback";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";
import { DownvoteFeedbackTriageService } from "@/utils/server/downvoteFeedbackTriageService";
import { NotionTaskClient } from "@/utils/server/notionTaskClient";

const DIGEST_WINDOW_DAYS = 7;

function buildDigestBody(clusters: DownvoteFeedbackCluster[], totalEvents: number, upgradedCount: number): string {
  const lines = [
    `Downvote feedback digest for ${process.env.SITE_ID || "default"}`,
    `Window: last ${DIGEST_WINDOW_DAYS} days`,
    `Total events: ${totalEvents}`,
    `Heuristic events upgraded by LLM: ${upgradedCount}`,
    "",
  ];

  if (clusters.length === 0) {
    lines.push(`No new downvote feedback in the last ${DIGEST_WINDOW_DAYS} days.`);
    return lines.join("\n");
  }

  lines.push("Top clusters:");
  clusters.slice(0, 10).forEach((cluster, index) => {
    lines.push(
      `${index + 1}. ${cluster.label} [${DownvoteFeedbackService.getCategoryLabel(cluster.triageCategory)}]`,
      `   count=${cluster.totalEvents}, avgConfidence=${cluster.averageConfidence.toFixed(2)}, identified=${cluster.identifiedCount}`,
      `   action=${cluster.recommendedAction}`
    );

    if (cluster.sampleQuestions[0]) {
      lines.push(`   sample question: ${cluster.sampleQuestions[0]}`);
    }
    if (cluster.sampleComments[0]) {
      lines.push(`   sample comment: ${cluster.sampleComments[0]}`);
    }
    if (cluster.notionTaskUrl) {
      lines.push(`   notion draft: ${cluster.notionTaskUrl}`);
    }
  });

  return lines.join("\n");
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 5,
    name: "downvote-feedback-digest",
  });
  if (!isAllowed) {
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const triageService = new DownvoteFeedbackTriageService();
    const upgradedCount = await triageService.enrichRecentHeuristicEvents(50);

    const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sinceTimestamp = firebase.firestore.Timestamp.fromDate(since);
    const createTasks = req.method === "POST" ? req.body?.createTasks !== false : req.query.createTasks !== "false";

    const snapshot = await firestoreQueryGet(
      db.collection(getDownvoteFeedbackEventsCollectionName()).where("createdAt", ">=", sinceTimestamp),
      "downvote feedback digest window",
      since.toISOString()
    );

    const events = snapshot.docs.map(
      (doc: { id: string; data: () => DownvoteFeedbackEvent }) =>
        ({ id: doc.id, ...(doc.data() as DownvoteFeedbackEvent) }) as DownvoteFeedbackEvent
    ) as DownvoteFeedbackEvent[];
    const clusters = DownvoteFeedbackService.buildClusters(events);
    const notionClient = new NotionTaskClient();
    const createdTasks: Array<{ clusterKey: string; url: string }> = [];

    if (createTasks && notionClient.isConfigured()) {
      for (const cluster of clusters) {
        if (!DownvoteFeedbackService.shouldCreateNotionTask(cluster)) {
          continue;
        }

        const matchingEvents = events
          .filter((event) => DownvoteFeedbackService.normalizeTaskCandidateKey(event.taskCandidateKey) === cluster.key)
          .sort((left, right) =>
            (DownvoteFeedbackService.toIsoString(right.createdAt) || "").localeCompare(
              DownvoteFeedbackService.toIsoString(left.createdAt) || ""
            )
          );

        const reusableTask = await notionClient.findReusableTask(
          matchingEvents.map((event) => ({
            taskId: event.notionTaskId,
            taskUrl: event.notionTaskUrl,
          }))
        );
        const createdTask = reusableTask || (await notionClient.createDraftTask(cluster));
        if (!createdTask) {
          continue;
        }

        createdTasks.push({ clusterKey: cluster.key, url: createdTask.url });

        for (const event of matchingEvents) {
          await firestoreUpdate(
            db.collection(getDownvoteFeedbackEventsCollectionName()).doc(event.id!),
            {
              notionTaskId: createdTask.id,
              notionTaskUrl: createdTask.url,
              triageStatus: "task_created",
            },
            "downvote digest notion task update",
            event.id!
          );
          await firestoreUpdate(
            db.collection(getAnswersCollectionName()).doc(event.answerDocId),
            {
              feedbackNotionTaskUrl: createdTask.url,
              feedbackTriageStatus: "task_created",
            },
            "mirror downvote digest notion task",
            event.answerDocId
          );
        }
      }
    }

    if (events.length > 0) {
      await sendOpsAlert(
        `Weekly downvote digest: ${events.length} new / ${clusters.length} clusters`,
        buildDigestBody(
          clusters.map((cluster) => {
            const createdTask = createdTasks.find((task) => task.clusterKey === cluster.key);
            return createdTask ? { ...cluster, notionTaskUrl: createdTask.url } : cluster;
          }),
          events.length,
          upgradedCount
        ),
        undefined,
        { alertLabel: "" }
      );
    }

    return res.status(200).json({
      ok: true,
      totalEvents: events.length,
      upgradedCount,
      createdTasks,
      clusters,
    });
  } catch (error) {
    console.error("Failed to generate downvote feedback digest:", error);
    return res.status(500).json({ error: "Failed to generate downvote feedback digest" });
  }
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true });
