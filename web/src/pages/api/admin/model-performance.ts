import type { NextApiRequest, NextApiResponse } from "next";
import * as fbadmin from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getModelPerformanceCollectionName } from "@/utils/server/firestoreUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { ModelPerformanceAggregator, ModelPerformanceRecordData } from "@/utils/server/modelPerformanceUtils";

function parseLookbackDays(raw: string | string[] | undefined) {
  if (!raw) return 7;
  const parsed = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(parsed, 1), 30);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 12,
    name: "admin-model-performance",
  });
  if (!isAllowed) return;

  const siteConfig = loadSiteConfigSync();
  const loginRequired = !!siteConfig?.requireLogin;

  if (loginRequired) {
    try {
      await requireAdminRoleFromFirestore(req);
    } catch {
      return res.status(403).json({ error: "Unauthorized: Admin access required" });
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
    const lookbackDays = parseLookbackDays(req.query.days);
    const now = new Date();
    const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const sinceTimestamp = fbadmin.firestore.Timestamp.fromDate(since);
    const collectionName = getModelPerformanceCollectionName();
    const collectionRef = db.collection(collectionName);

    let snapshot;
    try {
      snapshot = await firestoreQueryGet(
        collectionRef.where("createdAt", ">=", sinceTimestamp),
        "model performance lookback",
        `since: ${since.toISOString()}`
      );
    } catch (firestoreError: unknown) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/model-performance",
        collection: collectionName,
        fields: ["createdAt"],
        query: "model performance lookback",
      });
      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }
      throw firestoreError;
    }

    const aggregator = new ModelPerformanceAggregator();
    snapshot.forEach((doc: fbadmin.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as ModelPerformanceRecordData;
      aggregator.addRecord(data);
    });

    return res.status(200).json({
      siteId: siteConfig?.siteId || "unknown",
      lookbackDays,
      since: since.toISOString(),
      generatedAt: now.toISOString(),
      totals: aggregator.getTotals(),
      models: aggregator.buildSummary(),
    });
  } catch (error) {
    console.error("Error fetching model performance stats:", error);
    return res.status(500).json({ error: "Failed to load model performance stats" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
