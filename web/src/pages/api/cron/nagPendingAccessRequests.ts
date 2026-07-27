/**
 * Cron: NAG admins about pending access requests older than 3 days.
 * Re-sends a reminder every 3 days until the request is approved or denied.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { isDevelopment } from "@/utils/env";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { daysSince } from "@/utils/server/dateUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import {
  NAG_INTERVAL_DAYS,
  sendPendingAccessRequestNagEmail,
  shouldNagPendingAccessRequest,
} from "@/utils/server/pendingAccessRequestNagUtils";

interface PendingApprovalRequest {
  requestId: string;
  requesterEmail: string;
  requesterName: string;
  adminEmail: string;
  adminName: string;
  status: string;
  createdAt?: firebase.firestore.Timestamp;
  lastNaggedAt?: firebase.firestore.Timestamp;
  nagCount?: number;
  referenceNote?: string;
  knowsAdmin?: boolean;
  nearestCenter?: string;
  connectionHistory?: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "nag-pending-access-requests",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const siteConfig = await loadSiteConfig();
    const siteId = siteConfig?.siteId || process.env.SITE_ID || "default";

    // Access requests only exist on login-required sites
    if (!siteConfig?.requireLogin) {
      console.log(`📊 Skipping pending access request nags for site ${siteId} (requireLogin is false)`);
      return res.status(200).json({
        message: `Site ${siteId} does not require login - skipping pending access request nags`,
        processed: 0,
        sent: 0,
        skipped: 0,
        errors: 0,
      });
    }

    const envPrefix = isDevelopment() ? "dev" : "prod";
    const collectionName = `${envPrefix}_admin_approval_requests`;
    const cutoffMs = Date.now() - NAG_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTimestamp = firebase.firestore.Timestamp.fromMillis(cutoffMs);

    // Pending requests created at least NAG_INTERVAL_DAYS ago
    const pendingQuery = db
      .collection(collectionName)
      .where("status", "==", "pending")
      .where("createdAt", "<=", cutoffTimestamp);

    const snapshot = await firestoreQueryGet(
      pendingQuery,
      "get pending access requests for nag emails",
      "pending access request nag cron"
    );

    let processed = 0;
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    const errorsList: string[] = [];
    const sentList: { requestId: string; adminEmail: string; daysPending: number }[] = [];

    for (const doc of snapshot.docs) {
      processed++;
      const data = doc.data() as PendingApprovalRequest;
      const requestId = data.requestId || doc.id;

      try {
        if (!shouldNagPendingAccessRequest(data.createdAt, data.lastNaggedAt)) {
          skipped++;
          continue;
        }

        if (!data.adminEmail || !data.requesterEmail) {
          skipped++;
          errorsList.push(`${requestId}: missing admin or requester email`);
          continue;
        }

        const daysPending = daysSince(data.createdAt);

        await sendPendingAccessRequestNagEmail({
          requesterEmail: data.requesterEmail,
          requesterName: data.requesterName || data.requesterEmail,
          adminEmail: data.adminEmail,
          adminName: data.adminName || data.adminEmail,
          requestId,
          daysPending,
          referenceNote: data.referenceNote,
          knowsAdmin: data.knowsAdmin,
          nearestCenter: data.nearestCenter,
          connectionHistory: data.connectionHistory,
        });

        const now = firebase.firestore.Timestamp.now();
        await firestoreSet(
          doc.ref,
          {
            lastNaggedAt: now,
            nagCount: (typeof data.nagCount === "number" ? data.nagCount : 0) + 1,
          },
          { merge: true },
          "update lastNaggedAt after pending access request nag"
        );

        sent++;
        sentList.push({ requestId, adminEmail: data.adminEmail, daysPending });
        console.log(`✅ Nagged admin ${data.adminEmail} for pending request ${requestId} (${daysPending} days)`);
      } catch (error: any) {
        errors++;
        const message = error?.message || "Unknown error";
        errorsList.push(`${requestId}: ${message}`);
        console.error(`Error nagging pending access request ${requestId}:`, error);
      }
    }

    console.log(
      `📊 Pending access request nags: processed=${processed}, sent=${sent}, skipped=${skipped}, errors=${errors}`
    );

    return res.status(200).json({
      message: "Pending access request nags processed",
      processed,
      sent,
      skipped,
      errors,
      sentList,
      errorsList: errorsList.slice(0, 20),
    });
  } catch (error: any) {
    console.error("Error processing pending access request nags:", error);

    const envPrefix = isDevelopment() ? "dev" : "prod";
    const collectionName = `${envPrefix}_admin_approval_requests`;
    const indexAnalysis = analyzeFirestoreError(error);
    if (indexAnalysis.isIndexError) {
      await notifyOpsOfIndexError(error, {
        endpoint: "/api/cron/nagPendingAccessRequests",
        collection: collectionName,
        fields: ["status", "createdAt"],
        query: "pending access requests eligible for nag emails",
      });

      return res.status(503).json({
        error: indexAnalysis.userMessage,
        type: "firestore_index_error",
        adminMessage: indexAnalysis.adminMessage,
        indexUrl: indexAnalysis.indexUrl,
      });
    }

    const safeMessage = getSafeErrorMessage(error, "Failed to process pending access request nags");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withJwtOrCronAuth(handler);
