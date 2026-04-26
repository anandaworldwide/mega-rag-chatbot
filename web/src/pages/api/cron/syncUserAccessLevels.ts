import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { syncUserAccessLevelFromSalesforce } from "@/utils/server/salesforceAccessSync";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

const SALESFORCE_SYNC_CONCURRENCY = 5;
const CRON_START_TIME_BUDGET_MS = 700 * 1000;
const SALESFORCE_ID_RECHECK_DAYS = 2;
const IDENTITY_RECHECK_DAYS = 5;

interface SalesforceSyncCandidate {
  email: string;
  data: Record<string, any>;
}

type SalesforceSyncOutcome = "synced" | "failed" | "skippedDueToTimeBudget";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "sync_user_access_levels_cron",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig?.accessControl?.enabled) {
    return res.status(200).json({ success: true, processed: 0, skipped: "Access control is not enabled" });
  }

  const startedAt = Date.now();
  const usersQuery = db.collection(getUsersCollectionName()).where("inviteStatus", "==", "accepted");
  const snapshot = await firestoreQueryGet(usersQuery, "get users for access sync cron", "syncUserAccessLevels");
  const candidates: SalesforceSyncCandidate[] = snapshot.docs
    .map(
      (doc: firebase.firestore.QueryDocumentSnapshot): SalesforceSyncCandidate => ({
        email: doc.id,
        data: doc.data() || {},
      })
    )
    .filter((user: SalesforceSyncCandidate) => shouldRecheckUser(user.data));

  const outcomes = await runWithConcurrency(candidates, SALESFORCE_SYNC_CONCURRENCY, async (candidate) => {
    if (Date.now() - startedAt >= CRON_START_TIME_BUDGET_MS) {
      return "skippedDueToTimeBudget";
    }

    const result = await syncUserAccessLevelFromSalesforce(candidate.email, siteConfig);
    return result.error ? "failed" : "synced";
  });
  const synced = outcomes.filter((outcome) => outcome === "synced").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;
  const skippedDueToTimeBudget = outcomes.filter((outcome) => outcome === "skippedDueToTimeBudget").length;
  const processed = synced + failed;

  return res.status(200).json({
    success: true,
    candidates: candidates.length,
    processed,
    synced,
    failed,
    skippedDueToTimeBudget,
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<SalesforceSyncOutcome>
): Promise<SalesforceSyncOutcome[]> {
  const outcomes: SalesforceSyncOutcome[] = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchOutcomes = await Promise.all(batch.map((item) => worker(item)));
    outcomes.push(...batchOutcomes);
  }

  return outcomes;
}

function shouldRecheckUser(userData: Record<string, any>): boolean {
  if (userData.inviteStatus && userData.inviteStatus !== "accepted") {
    return false;
  }

  const lastSync = toDate(userData.lastSalesforceSyncAt);
  if (!lastSync) {
    return true;
  }

  const hasSalesforceId = typeof userData.salesforceId === "string" && userData.salesforceId.trim().length > 0;
  const recheckDays = hasSalesforceId ? SALESFORCE_ID_RECHECK_DAYS : IDENTITY_RECHECK_DAYS;
  const cutoffMs = Date.now() - recheckDays * 24 * 60 * 60 * 1000;
  return lastSync.getTime() <= cutoffMs;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export default withJwtOrCronAuth(handler);
