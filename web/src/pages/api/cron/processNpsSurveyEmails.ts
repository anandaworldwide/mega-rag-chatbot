import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { sendNpsSurveyEmail, loadNpsSurveyTemplate } from "@/utils/server/npsSurveyEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import { User } from "@/types/user";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { daysSince } from "@/utils/server/dateUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import firebase from "firebase-admin";
import crypto from "crypto";
import { NPS_SURVEY_CONFIG } from "@/config/emailCampaigns";
import { createErrorResponse, ERROR_CODES } from "@/utils/server/apiErrorResponse";

const CAMPAIGN_ID = NPS_SURVEY_CONFIG.CAMPAIGN_ID;
const NPS_SURVEY_FREQUENCY_DAYS = NPS_SURVEY_CONFIG.FREQUENCY_DAYS;
const ACTIVITY_WINDOW_HOURS = NPS_SURVEY_CONFIG.ACTIVITY_WINDOW_HOURS;
const VERIFICATION_MIN_DAYS = NPS_SURVEY_CONFIG.VERIFICATION_MIN_DAYS;
const MAX_SEND_RETRIES = NPS_SURVEY_CONFIG.MAX_SEND_RETRIES;

/**
 * Updates NPS survey analytics in Firestore
 */
async function updateNpsSurveyAnalytics(
  siteId: string,
  stats: {
    totalEligible: number;
    sent: number;
    errors: number;
    skipped: number;
  }
): Promise<void> {
  if (!db) return;

  try {
    const analyticsRef = db.collection("analytics").doc(`nps-survey-${siteId}`);
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    await analyticsRef.set(
      {
        lastRunAt: firebase.firestore.Timestamp.now(),
        lastRunDate: today,
        lastRunStats: stats,
        // Cumulative totals
        totalSent: firebase.firestore.FieldValue.increment(stats.sent),
        totalErrors: firebase.firestore.FieldValue.increment(stats.errors),
        // Daily stats (overwrites each day)
        [`daily.${today}`]: stats,
        updatedAt: firebase.firestore.Timestamp.now(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("Failed to update NPS survey analytics:", error);
    // Don't throw - analytics failure shouldn't break the cron job
  }
}

/**
 * Generates an idempotency key for email sending operations
 */
function generateIdempotencyKey(email: string, campaignId: string): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return crypto.createHash("sha256").update(`${email}:${campaignId}:${date}`).digest("hex").substring(0, 16);
}

/**
 * Type guard to check if a value is a Firestore Timestamp
 */
function isFirestoreTimestamp(value: any): value is firebase.firestore.Timestamp {
  return value && typeof value === "object" && typeof value.toDate === "function" && typeof value.seconds === "number";
}

/**
 * Checks if user was active in the last N hours
 *
 * @param lastActivity - Firestore Timestamp or Date representing last activity
 * @param hours - Number of hours to check
 * @returns True if user was active within the specified hours
 */
function isActiveInLastHours(lastActivity: any, hours: number): boolean {
  if (!lastActivity) {
    return false;
  }

  let lastActivityDate: Date;
  if (isFirestoreTimestamp(lastActivity)) {
    lastActivityDate = lastActivity.toDate();
  } else if (lastActivity instanceof Date) {
    lastActivityDate = lastActivity;
  } else {
    // Fallback for other date-like objects
    lastActivityDate = new Date(lastActivity);
  }

  const hoursSinceActivity = (Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60);
  return hoursSinceActivity <= hours;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json(createErrorResponse("Method not allowed", ERROR_CODES.VALIDATION_ERROR));
  }

  // Rate limiting for defense in depth
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "process-nps-survey-emails",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json(createErrorResponse("Database not available", ERROR_CODES.DATABASE_ERROR));
  }

  try {
    // Load site configuration
    const siteConfig = await loadSiteConfig();
    const siteId = siteConfig?.siteId || process.env.SITE_ID || "default";
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ananda.org";

    // Check if NPS surveys are enabled for this site
    if (!siteConfig?.enableNpsSurveyEmail || !siteConfig?.requireLogin) {
      console.log(
        `📊 Skipping NPS survey emails for site ${siteId} (enableNpsSurveyEmail: ${siteConfig?.enableNpsSurveyEmail}, requireLogin: ${siteConfig?.requireLogin})`
      );
      return res.status(200).json({
        message: `Site ${siteId} does not have NPS surveys enabled or does not require login`,
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    // Check if template exists for this site
    const template = await loadNpsSurveyTemplate(siteId);
    if (!template) {
      console.log(`📊 No NPS survey template found for site ${siteId}`);
      return res.status(200).json({
        message: `No NPS survey template found for site ${siteId}`,
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    // Check for test mode
    const testEmail = process.env.NPS_SURVEY_TEST_EMAIL;
    if (testEmail) {
      console.log(`🧪 TEST MODE: Processing NPS survey email for test user: ${testEmail}`);
    }

    // Query users who have accepted invitations
    const usersCol = getUsersCollectionName();
    let allUsersSnapshot: firebase.firestore.QuerySnapshot;

    if (testEmail) {
      // In test mode, fetch only the specific user document
      const userDocRef = db.collection(usersCol).doc(testEmail);
      const userDoc = await firestoreGet(userDocRef, "get test user for NPS survey email", "NPS survey cron");

      if (!userDoc.exists) {
        console.log(`🧪 TEST MODE: User ${testEmail} not found`);
        return res.status(200).json({
          message: `Test user ${testEmail} not found`,
          processed: 0,
          sent: 0,
          errors: 0,
          testMode: true,
          testEmail,
        });
      }

      const userData = userDoc.data() as User;
      if (userData.inviteStatus !== "accepted") {
        console.log(`🧪 TEST MODE: User ${testEmail} has inviteStatus "${userData.inviteStatus}" (not "accepted")`);
      }

      // Convert single doc to QuerySnapshot-like structure
      allUsersSnapshot = {
        empty: false,
        docs: [userDoc as FirebaseFirestore.QueryDocumentSnapshot],
        size: 1,
        query: userDocRef as any,
      } as FirebaseFirestore.QuerySnapshot;
    } else {
      // Normal mode: query all accepted users
      const usersQuery = db.collection(usersCol).where("inviteStatus", "==", "accepted");
      allUsersSnapshot = await firestoreQueryGet(usersQuery, "get users for NPS survey emails", "NPS survey cron");
    }

    // Filter users based on eligibility criteria:
    // 1. Must be subscribed to NPS emails (defaults to true if not set)
    // 2. Must have lastActivityAt within last 72 hours (3 days)
    // 3. Must not have received NPS email in last 6 months
    // 4. Must have verified account at least 3 days ago
    // 5. Must not have exceeded max retry attempts
    const eligibleDocs = allUsersSnapshot.docs.filter((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as User;
      const userEmail = doc.id;
      const isTestUser = testEmail && testEmail === userEmail;

      // Check subscription preference (defaults to true)
      if (data.emailPreferences?.nps === false) {
        if (isTestUser) {
          console.log(`🔍 [DEBUG] User ${userEmail} filtered: emailPreferences.nps === false`);
        }
        return false;
      }

      // Check if active in last 24 hours
      const lastActivity = data.lastActivityAt;
      if (!lastActivity || !isActiveInLastHours(lastActivity, ACTIVITY_WINDOW_HOURS)) {
        if (isTestUser) {
          const hoursSince = lastActivity
            ? (Date.now() - (lastActivity as any).toMillis?.() || (lastActivity as any).seconds * 1000) /
              (1000 * 60 * 60)
            : "missing";
          console.log(`🔍 [DEBUG] User ${userEmail} filtered: lastActivityAt issue`, {
            hasLastActivity: !!lastActivity,
            hoursSince,
            isActive: lastActivity ? isActiveInLastHours(lastActivity, ACTIVITY_WINDOW_HOURS) : false,
          });
        }
        return false;
      }

      // Check if NPS email sent in last 6 months
      const lastNpsSent = data.lastNpsSurveySentAt;
      if (lastNpsSent) {
        const daysSinceNps = daysSince(lastNpsSent);
        if (daysSinceNps < NPS_SURVEY_FREQUENCY_DAYS) {
          if (isTestUser) {
            console.log(
              `🔍 [DEBUG] User ${userEmail} filtered: NPS sent ${daysSinceNps} days ago (< ${NPS_SURVEY_FREQUENCY_DAYS})`
            );
          }
          return false;
        }
      }

      // Check if account was verified at least 3 days ago
      const verifiedAt = data.verifiedAt as any; // Firestore stores as Timestamp, but type says string | null
      if (!verifiedAt) {
        // If verifiedAt is not set, filter out (user hasn't verified account yet)
        if (isTestUser) {
          console.log(`🔍 [DEBUG] User ${userEmail} filtered: verifiedAt not set`);
        }
        return false;
      }

      // daysSince handles Firestore Timestamps, Date objects, and can parse strings
      const daysSinceVerification = daysSince(verifiedAt);
      if (daysSinceVerification < VERIFICATION_MIN_DAYS) {
        if (isTestUser) {
          console.log(
            `🔍 [DEBUG] User ${userEmail} filtered: account verified ${daysSinceVerification} days ago (< ${VERIFICATION_MIN_DAYS})`
          );
        }
        return false;
      }

      if (isTestUser) {
        console.log(`✅ [DEBUG] User ${userEmail} is ELIGIBLE`);
      }
      return true;
    });

    if (eligibleDocs.length === 0) {
      const message = testEmail
        ? `No users eligible for NPS survey emails (test user: ${testEmail})`
        : `No users eligible for NPS survey emails (${allUsersSnapshot.docs.length} total accepted users)`;
      console.log(`📊 ${message}`);
      return res.status(200).json({
        message,
        processed: 0,
        sent: 0,
        errors: 0,
        testMode: !!testEmail,
      });
    }

    let processed = 0;
    let sent = 0;
    let errors = 0;
    const errorsList: string[] = [];
    const sentList: { email: string }[] = [];
    const skippedList: { email: string; reason: string }[] = [];

    // Process each eligible user
    for (const doc of eligibleDocs) {
      processed++;
      const userData = doc.data() as User;
      const userEmail = doc.id; // Email is the document ID
      userData.id = userEmail; // Set for email sending

      try {
        // Double-check subscription (defensive)
        if (userData.emailPreferences?.nps === false) {
          skippedList.push({ email: userEmail, reason: "not subscribed to NPS emails" });
          continue;
        }

        // Double-check activity window (defensive)
        const lastActivity = userData.lastActivityAt;
        if (!lastActivity || !isActiveInLastHours(lastActivity, ACTIVITY_WINDOW_HOURS)) {
          skippedList.push({ email: userEmail, reason: `not active in last ${ACTIVITY_WINDOW_HOURS} hours` });
          continue;
        }

        // Double-check NPS frequency (defensive)
        const lastNpsSent = userData.lastNpsSurveySentAt;
        if (lastNpsSent) {
          const daysSinceNps = daysSince(lastNpsSent);
          if (daysSinceNps < NPS_SURVEY_FREQUENCY_DAYS) {
            skippedList.push({
              email: userEmail,
              reason: `NPS email sent ${daysSinceNps} days ago (< ${NPS_SURVEY_FREQUENCY_DAYS} days)`,
            });
            continue;
          }
        }

        // Check if user has exceeded retry limit for failed sends
        const npsSendAttempts = userData.npsSendAttempts || 0;
        if (npsSendAttempts >= MAX_SEND_RETRIES) {
          skippedList.push({
            email: userEmail,
            reason: `exceeded max retries (${npsSendAttempts}/${MAX_SEND_RETRIES})`,
          });
          continue;
        }

        // Generate idempotency key
        const idempotencyKey = generateIdempotencyKey(userEmail, CAMPAIGN_ID);

        // Use a transaction to atomically check and update
        const sendResult = await db.runTransaction(async (transaction) => {
          // Re-read the user document to get fresh state
          const freshDoc = await transaction.get(doc.ref);
          if (!freshDoc.exists) {
            return { sent: false, reason: "user_not_found" };
          }

          const freshData = freshDoc.data() as User;

          // Check if already sent (another cron run may have sent it)
          const freshLastNpsSent = freshData.lastNpsSurveySentAt;
          if (freshLastNpsSent) {
            const daysSinceNps = daysSince(freshLastNpsSent);
            if (daysSinceNps < NPS_SURVEY_FREQUENCY_DAYS) {
              return { sent: false, reason: "already_sent_recently" };
            }
          }

          // Check idempotency key
          const pendingKeys = freshData.pendingNpsSurveyKeys || [];
          if (pendingKeys.includes(idempotencyKey)) {
            return { sent: false, reason: "pending_send" };
          }

          // Mark as pending AND set timestamp immediately to prevent race conditions
          // This ensures that if another cron run checks, it will see the timestamp
          // and skip, even if email sending is still in progress
          transaction.update(doc.ref, {
            pendingNpsSurveyKeys: firebase.firestore.FieldValue.arrayUnion(idempotencyKey),
            lastNpsSurveySentAt: firebase.firestore.Timestamp.now(),
          });

          return { sent: true, reason: "proceed" };
        });

        if (!sendResult.sent) {
          if (sendResult.reason === "already_sent_recently") {
            skippedList.push({ email: userEmail, reason: "already sent (detected in transaction)" });
          } else if (sendResult.reason === "pending_send") {
            skippedList.push({ email: userEmail, reason: "pending send in progress" });
          }
          continue;
        }

        // Now send the email (outside transaction to avoid timeout)
        // The timestamp is already set, so duplicate sends are prevented
        const success = await sendNpsSurveyEmail(userData, siteId, baseUrl);

        // Update the final state based on send result
        if (success) {
          // Email sent successfully - clean up pending key and reset retry counter
          await firestoreSet(
            doc.ref,
            {
              pendingNpsSurveyKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
              npsSendAttempts: firebase.firestore.FieldValue.delete(), // Reset retry counter on success
            },
            { merge: true },
            `remove pending key after successful NPS survey send`
          );
          sent++;
          sentList.push({ email: userEmail });
        } else {
          // Send failed - rollback timestamp, remove pending key, increment retry counter
          const currentAttempts = userData.npsSendAttempts || 0;
          const newAttempts = currentAttempts + 1;

          await firestoreSet(
            doc.ref,
            {
              lastNpsSurveySentAt: firebase.firestore.FieldValue.delete(),
              pendingNpsSurveyKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
              npsSendAttempts: newAttempts,
              lastNpsSendFailedAt: firebase.firestore.Timestamp.now(),
            },
            { merge: true },
            `rollback failed NPS survey send (attempt ${newAttempts}/${MAX_SEND_RETRIES})`
          );
          errors++;
          errorsList.push(`${userEmail}: Failed to send NPS survey email (attempt ${newAttempts}/${MAX_SEND_RETRIES})`);

          // Alert ops if we have repeated failures
          if (errors >= 5) {
            sendOpsAlert(
              "NPS Survey Email Failures",
              `Multiple NPS survey email failures detected:\n${errorsList.slice(0, 5).join("\n")}`,
              { context: { endpoint: "/api/cron/processNpsSurveyEmails", errorCount: errors } }
            ).catch(() => {});
          }
        }
      } catch (error: any) {
        errors++;
        const errorMsg = `${userEmail}: ${error.message || "Unknown error"}`;
        errorsList.push(errorMsg);
        console.error(`Error processing user ${userEmail}:`, error);
      }
    }

    // Log detailed results
    console.log(`📊 NPS survey email processing complete:`);
    console.log(`   Total accepted users: ${allUsersSnapshot.docs.length}`);
    console.log(`   Eligible: ${eligibleDocs.length}`);
    console.log(`   Processed: ${processed}, Sent: ${sent}, Errors: ${errors}`);

    if (skippedList.length > 0 && skippedList.length <= 50) {
      console.log(`⏭️ Skipped users:`);
      for (const item of skippedList) {
        console.log(`   - ${item.email}: ${item.reason}`);
      }
    } else if (skippedList.length > 50) {
      console.log(`⏭️ Skipped ${skippedList.length} users (showing first 50):`);
      for (const item of skippedList.slice(0, 50)) {
        console.log(`   - ${item.email}: ${item.reason}`);
      }
    }

    if (errorsList.length > 0) {
      console.log(`❌ Errors:`);
      for (const err of errorsList.slice(0, 10)) {
        console.log(`   - ${err}`);
      }
    }

    // Update analytics (non-blocking)
    const analyticsStats = {
      totalEligible: eligibleDocs.length,
      sent,
      errors,
      skipped: skippedList.length,
    };
    await updateNpsSurveyAnalytics(siteId, analyticsStats);

    // Calculate success rate for response
    const successRate = eligibleDocs.length > 0 ? Math.round((sent / eligibleDocs.length) * 100) : 0;

    // Return summary JSON with analytics
    return res.status(200).json({
      message: testEmail ? `NPS survey emails processed (TEST MODE: ${testEmail})` : "NPS survey emails processed",
      processed,
      sent,
      errors,
      skipped: skippedList.length,
      analytics: {
        totalAcceptedUsers: allUsersSnapshot.docs.length,
        eligible: eligibleDocs.length,
        successRate: `${successRate}%`,
      },
      testMode: !!testEmail,
      testEmail: testEmail || undefined,
    });
  } catch (error: any) {
    console.error("Error processing NPS survey emails:", error);

    // Check if this is a Firestore index error
    const indexAnalysis = analyzeFirestoreError(error);
    if (indexAnalysis.isIndexError) {
      await notifyOpsOfIndexError(error, {
        endpoint: "/api/cron/processNpsSurveyEmails",
        collection: getUsersCollectionName(),
        fields: ["inviteStatus"],
        query: "users eligible for NPS survey emails",
      });

      return res.status(503).json({
        error: indexAnalysis.userMessage,
        type: "firestore_index_error",
        adminMessage: indexAnalysis.adminMessage,
        indexUrl: indexAnalysis.indexUrl,
      });
    }

    const safeMessage = getSafeErrorMessage(error, "Failed to process NPS survey emails");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtOrCronAuth(handler);
