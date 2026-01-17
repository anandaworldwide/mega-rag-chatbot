import type { NextApiRequest, NextApiResponse } from "next"
import * as fbadmin from "firebase-admin"
import { db } from "@/services/firebase"
import { withApiMiddleware } from "@/utils/server/apiMiddleware"
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils"
import { genericRateLimiter } from "@/utils/server/genericRateLimiter"
import { sendOpsAlert } from "@/utils/server/emailOps"
import { getModelPerformanceCollectionName } from "@/utils/server/firestoreUtils"
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils"
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler"
import { ModelPerformanceAggregator } from "@/utils/server/modelPerformanceUtils"

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00"
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 3,
    name: "model-performance-digest",
  })
  if (!allowed) return

  if (!db) {
    return res.status(503).json({ error: "Database not available" })
  }

  try {
    const now = new Date()
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const sinceTimestamp = fbadmin.firestore.Timestamp.fromDate(since)
    const collectionName = getModelPerformanceCollectionName()

    let snapshot
    try {
      snapshot = await firestoreQueryGet(
        db.collection(collectionName).where("createdAt", ">=", sinceTimestamp),
        "model performance digest",
        `since: ${since.toISOString()}`
      )
    } catch (firestoreError: unknown) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/model-performance-digest",
        collection: collectionName,
        fields: ["createdAt"],
        query: "model performance digest",
      })
      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse)
      }
      throw firestoreError
    }

    const aggregator = new ModelPerformanceAggregator()
    snapshot.forEach((doc) => {
      aggregator.addRecord(doc.data())
    })

    const totals = aggregator.getTotals()
    const summaries = aggregator.buildSummary()
    const siteId = process.env.SITE_ID || "unknown"
    const environment = process.env.NODE_ENV === "production" ? "prod" : "dev"

    const header = [
      `Model performance digest for ${siteId} (${environment})`,
      `Window: last 24 hours`,
      `Since: ${since.toISOString()}`,
      ``,
      `SUMMARY:`,
      `- Total records: ${totals.totalRecords}`,
      `- Error records: ${totals.errorRecords}`,
      ``,
    ].join("\n")

    const modelSections =
      summaries.length === 0
        ? "No model performance records in the last 24 hours."
        : summaries
            .map((summary) => {
              const metrics = summary.metrics
              const lines = [
                `MODEL: ${summary.model} (n=${summary.count})`,
                `- TTFB avg: ${formatSeconds(metrics.ttfbMs.mean)} (stdev ${formatSeconds(metrics.ttfbMs.stdDev)}, n=${metrics.ttfbMs.count})`,
                `- Answer streaming avg: ${formatSeconds(metrics.answerStreamingMs.mean)} (stdev ${formatSeconds(metrics.answerStreamingMs.stdDev)}, n=${metrics.answerStreamingMs.count})`,
                `- Total session avg: ${formatSeconds(metrics.totalSessionMs.mean)} (stdev ${formatSeconds(metrics.totalSessionMs.stdDev)}, n=${metrics.totalSessionMs.count})`,
                `- Tokens/sec avg: ${formatNumber(metrics.tokensPerSecond.mean)} (stdev ${formatNumber(metrics.tokensPerSecond.stdDev)}, n=${metrics.tokensPerSecond.count})`,
                `- Total tokens avg: ${formatNumber(metrics.totalTokens.mean)} (stdev ${formatNumber(metrics.totalTokens.stdDev)}, n=${metrics.totalTokens.count})`,
                ``,
              ]
              return lines.join("\n")
            })
            .join("\n")

    const body = `${header}${modelSections}`
    const subject = `Model performance digest: ${totals.totalRecords} records, ${totals.errorRecords} errors`

    if (totals.totalRecords > 0 || totals.errorRecords > 0) {
      await sendOpsAlert(subject, body)
    }

    return res.status(200).json({
      ok: true,
      totals,
      models: summaries,
    })
  } catch (error) {
    console.error("Failed to generate model performance digest:", error)
    return res.status(500).json({ error: "Failed to generate model performance digest" })
  }
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true })
