import type { NextApiRequest, NextApiResponse } from "next";
import * as fbadmin from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { getModelPerformanceCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { ModelPerformanceAggregator } from "@/utils/server/modelPerformanceUtils";

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function getTtfbStatus(ttfbMs: number): { emoji: string; label: "GOOD" | "WARNING" | "CRITICAL" } {
  // TTFB values are in milliseconds
  // Green indicator: < 4000ms (4 seconds) - good performance
  // Yellow indicator: >= 4000ms (4 seconds) - warning
  // Red indicator: >= 6000ms (6 seconds) - critical
  if (ttfbMs >= 6000) {
    return { emoji: "🔴", label: "CRITICAL" };
  } else if (ttfbMs >= 4000) {
    return { emoji: "⚠️", label: "WARNING" };
  }
  return { emoji: "✅", label: "GOOD" };
}

function getOverallTtfbMs(summaries: ReturnType<ModelPerformanceAggregator["buildSummary"]>): number {
  let weightedTotal = 0;
  let sampleCount = 0;

  summaries.forEach((summary) => {
    const count = summary.metrics.ttfbMs.count;
    const mean = summary.metrics.ttfbMs.mean;
    if (!Number.isFinite(mean) || count <= 0) return;
    weightedTotal += mean * count;
    sampleCount += count;
  });

  if (sampleCount === 0) return 0;
  return weightedTotal / sampleCount;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 3,
    name: "model-performance-digest",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const now = new Date();
    const since = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const sinceTimestamp = fbadmin.firestore.Timestamp.fromDate(since);
    const collectionName = getModelPerformanceCollectionName();

    let snapshot;
    try {
      snapshot = await firestoreQueryGet(
        db.collection(collectionName).where("createdAt", ">=", sinceTimestamp),
        "model performance digest",
        `since: ${since.toISOString()}`
      );
    } catch (firestoreError: unknown) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/model-performance-digest",
        collection: collectionName,
        fields: ["createdAt"],
        query: "model performance digest",
      });
      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }
      throw firestoreError;
    }

    const aggregator = new ModelPerformanceAggregator();
    snapshot.forEach((doc: fbadmin.firestore.QueryDocumentSnapshot) => {
      aggregator.addRecord(doc.data());
    });

    const totals = aggregator.getTotals();
    const summaries = aggregator.buildSummary();
    const siteId = process.env.SITE_ID || "unknown";
    const environment = process.env.NODE_ENV === "production" ? "prod" : "dev";

    const header = [
      `Model performance digest for ${siteId} (${environment})`,
      `Window: last 72 hours`,
      `Since: ${since.toISOString()}`,
      ``,
      `SUMMARY:`,
      `- Total records: ${totals.totalRecords}`,
      `- Error records: ${totals.errorRecords}`,
      ``,
      ``,
    ].join("\n");

    const modelSections =
      summaries.length === 0
        ? "No model performance records in the last 72 hours."
        : summaries
            .map((summary) => {
              const metrics = summary.metrics;
              const ttfbStatus = getTtfbStatus(metrics.ttfbMs.mean);
              const lines = [
                `MODEL: ${summary.model} (n=${summary.count})`,
                `- TTFB avg: ${ttfbStatus.emoji} [${ttfbStatus.label}] ${formatSeconds(metrics.ttfbMs.mean)} (stdev ${formatSeconds(metrics.ttfbMs.stdDev)}, n=${metrics.ttfbMs.count})`,
                `- Answer streaming avg: ${formatSeconds(metrics.answerStreamingMs.mean)} (stdev ${formatSeconds(metrics.answerStreamingMs.stdDev)}, n=${metrics.answerStreamingMs.count})`,
                `- Total session avg: ${formatSeconds(metrics.totalSessionMs.mean)} (stdev ${formatSeconds(metrics.totalSessionMs.stdDev)}, n=${metrics.totalSessionMs.count})`,
                `- Tokens/sec avg: ${formatNumber(metrics.tokensPerSecond.mean)} (stdev ${formatNumber(metrics.tokensPerSecond.stdDev)}, n=${metrics.tokensPerSecond.count})`,
                `- Total tokens avg: ${formatNumber(metrics.totalTokens.mean)} (stdev ${formatNumber(metrics.totalTokens.stdDev)}, n=${metrics.totalTokens.count})`,
                ``,
              ];
              return lines.join("\n");
            })
            .join("\n");

    const footer = [
      ``,
      `---`,
      `TTFB Thresholds:`,
      `- ✅ [GOOD] < 4.00s (4000ms)`,
      `- ⚠️ [WARNING] >= 4.00s (4000ms)`,
      `- 🔴 [CRITICAL] >= 6.00s (6000ms)`,
    ].join("\n");

    const body = `${header}${modelSections}${footer}`;
    const overallTtfbMs = getOverallTtfbMs(summaries);
    const overallTtfbStatus = getTtfbStatus(overallTtfbMs);
    const subject = `Model performance TTFB ${overallTtfbStatus.emoji} ${formatSeconds(overallTtfbMs)}`;

    if (totals.totalRecords > 0 || totals.errorRecords > 0) {
      await sendOpsAlert(subject, body, undefined, { alertLabel: "" });
    }

    return res.status(200).json({
      ok: true,
      totals,
      models: summaries,
    });
  } catch (error) {
    console.error("Failed to generate model performance digest:", error);
    return res.status(500).json({ error: "Failed to generate model performance digest" });
  }
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true });
