import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendSpecialDayEmail, loadSpecialDayTemplate } from "@/utils/server/specialDayEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import { User } from "@/types/user";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { getSpecialDaysForDate, generateCampaignId } from "@/config/specialDays";
import firebase from "firebase-admin";
import crypto from "crypto";
import pMap from "p-map";

// Concurrency limit for parallel email sending (balance speed vs rate limits)
// Set to 5 to stay under AWS SES rate limit of 14 requests/second
const EMAIL_SEND_CONCURRENCY = 5;

/**
 * Generates an idempotency key for email sending operations
 * This prevents duplicate sends if cron runs overlap or retry
 */
function generateIdempotencyKey(email: string, campaignId: string): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return crypto.createHash("sha256").update(`${email}:${campaignId}:${date}`).digest("hex").substring(0, 16);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting for defense in depth (runs once daily via Vercel cron)
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "process-special-day-emails",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Load site configuration
    const siteConfig = await loadSiteConfig();
    const siteId = siteConfig?.siteId || process.env.SITE_ID || "default";
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ananda.org";

    // Only process login-required sites (they have user accounts)
    if (!siteConfig?.requireLogin) {
      console.log(`📊 Skipping special day emails for site ${siteId} (requireLogin is false in config)`);
      return res.status(200).json({
        message: `Site ${siteId} does not require login - skipping special day emails`,
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    // Get today's date in Pacific Time and find which special days should be sent today
    // We use Pacific Time for all date calculations since that's where development is done
    const today = new Date();
    const specialDaysToSend = await getSpecialDaysForDate(siteId, today);

    if (specialDaysToSend.length === 0) {
      console.log(`📊 No special day emails to send today (${today.toISOString().split("T")[0]})`);
      return res.status(200).json({
        message: "No special day emails to send today",
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    console.log(
      `📅 Processing ${specialDaysToSend.length} special day(s) for today: ${specialDaysToSend.map((s) => s.name).join(", ")}`
    );

    // Check for test mode (single user testing)
    const testEmail = process.env.SPECIAL_DAY_TEST_EMAIL;
    const isTestMode = !!testEmail;
    if (isTestMode) {
      console.log(`🧪 TEST MODE: Processing special day emails for test user: ${testEmail}`);
    }

    // Query users who have accepted invitations (are active users)
    const usersCol = getUsersCollectionName();
    let allUsersSnapshot: firebase.firestore.QuerySnapshot;

    if (isTestMode) {
      // In test mode, fetch only the specific user document
      const userDocRef = db.collection(usersCol).doc(testEmail);
      const userDoc = await firestoreGet(userDocRef, "get test user for special day email", "special day cron");

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
      // Still check inviteStatus in test mode (but log if it fails)
      if (userData.inviteStatus !== "accepted") {
        // Continue anyway in test mode
      }

      // Convert single doc to QuerySnapshot-like structure for compatibility
      allUsersSnapshot = {
        empty: false,
        docs: [userDoc as FirebaseFirestore.QueryDocumentSnapshot],
        size: 1,
        query: userDocRef as any,
      } as FirebaseFirestore.QuerySnapshot;

      // Verify we only have the test user
      if (allUsersSnapshot.docs.length !== 1 || allUsersSnapshot.docs[0].id !== testEmail) {
        return res.status(500).json({
          error: `Test mode error: Expected 1 document, got ${allUsersSnapshot.docs.length}`,
          testMode: true,
          testEmail,
        });
      }
    } else {
      // Normal mode: query all accepted users
      const usersQuery = db.collection(usersCol).where("inviteStatus", "==", "accepted");
      allUsersSnapshot = await firestoreQueryGet(usersQuery, "get users for special day emails", "special day cron");
    }

    let totalProcessed = 0;
    let totalSent = 0;
    let totalErrors = 0;
    const errorsList: string[] = [];
    const sentList: { email: string; specialDayId: string; campaignId: string }[] = [];
    const skippedList: { email: string; reason: string }[] = [];

    const year = today.getFullYear();

    // Process each special day that should be sent today
    for (const specialDay of specialDaysToSend) {
      // Check if template exists for this site and special day
      const template = await loadSpecialDayTemplate(specialDay.id, siteId);
      if (!template) {
        console.log(`📊 No special day template found for ${specialDay.id}, site ${siteId}`);
        continue;
      }

      const campaignId = generateCampaignId(specialDay.id, year);

      // Filter users based on eligibility criteria:
      // 1. Must be subscribed to special day emails
      // 2. Must not have already received this campaign
      // 3. In test mode, must match the test email exactly
      let docsToProcess = allUsersSnapshot.docs;

      // In test mode, filter to only the test user BEFORE other checks
      if (isTestMode && testEmail) {
        docsToProcess = docsToProcess.filter((doc: firebase.firestore.QueryDocumentSnapshot) => {
          const userEmail = doc.id;
          return userEmail === testEmail;
        });

        // Double-check: in test mode, we should only have the test user
        if (docsToProcess.length !== 1 || (docsToProcess.length > 0 && docsToProcess[0].id !== testEmail)) {
          continue; // Skip this special day in test mode if filtering failed
        }
      }

      const eligibleDocs = docsToProcess.filter((doc: firebase.firestore.QueryDocumentSnapshot) => {
        const data = doc.data() as User;

        // Check subscription preference
        if (!isSubscribedToCategory(data, "specialDay")) {
          return false;
        }

        // Check if already sent this campaign
        const emailsSent = data.specialDayEmailsSent || [];
        if (emailsSent.includes(campaignId)) {
          return false;
        }

        return true;
      });

      if (eligibleDocs.length === 0) {
        console.log(`📊 No eligible users for ${specialDay.name} (${campaignId})`);
        continue;
      }

      console.log(
        `📬 Processing ${eligibleDocs.length} eligible users for ${specialDay.name} (${campaignId}) with concurrency ${EMAIL_SEND_CONCURRENCY}`
      );

      // Process users in parallel with controlled concurrency
      const results = await pMap(
        eligibleDocs,
        async (doc: firebase.firestore.QueryDocumentSnapshot) => {
          const userData = doc.data() as User;
          const userEmail = doc.id; // Email is the document ID
          userData.id = userEmail; // Set for email sending

          try {
            // Double-check subscription (defensive)
            if (!isSubscribedToCategory(userData, "specialDay")) {
              return {
                type: "skipped" as const,
                email: userEmail,
                reason: `not subscribed to special day (${specialDay.id})`,
              };
            }

            // Double-check idempotency (defensive)
            const emailsSent = userData.specialDayEmailsSent || [];
            if (emailsSent.includes(campaignId)) {
              return { type: "skipped" as const, email: userEmail, reason: `already sent ${campaignId}` };
            }

            // Generate idempotency key to prevent duplicate sends
            const idempotencyKey = generateIdempotencyKey(userEmail, campaignId);

            // Use a transaction to atomically check and update the campaign sent status
            // This prevents race conditions if cron runs overlap
            const sendResult = await db!.runTransaction(async (transaction) => {
              // Re-read the user document to get fresh state
              const freshDoc = await transaction.get(doc.ref);
              if (!freshDoc.exists) {
                return { sent: false, reason: "user_not_found" };
              }

              const freshData = freshDoc.data() as User;
              const freshEmailsSent = freshData.specialDayEmailsSent || [];

              // Check if already sent (another cron run may have sent it)
              if (freshEmailsSent.includes(campaignId)) {
                return { sent: false, reason: "already_sent" };
              }

              // Check idempotency key (prevents same-day duplicate attempts)
              const pendingKeys = freshData.pendingSpecialDayKeys || [];
              if (pendingKeys.includes(idempotencyKey)) {
                return { sent: false, reason: "pending_send" };
              }

              // Mark as pending before sending (optimistic lock)
              transaction.update(doc.ref, {
                pendingSpecialDayKeys: firebase.firestore.FieldValue.arrayUnion(idempotencyKey),
              });

              return { sent: true, reason: "proceed" };
            });

            if (!sendResult.sent) {
              if (sendResult.reason === "already_sent") {
                return {
                  type: "skipped" as const,
                  email: userEmail,
                  reason: `already sent ${campaignId} (detected in transaction)`,
                };
              } else if (sendResult.reason === "pending_send") {
                return {
                  type: "skipped" as const,
                  email: userEmail,
                  reason: `pending send in progress for ${campaignId}`,
                };
              }
              return { type: "skipped" as const, email: userEmail, reason: sendResult.reason };
            }

            // Now send the email (outside transaction to avoid long-running txn)
            const success = await sendSpecialDayEmail(userData, specialDay.id, siteId, baseUrl, year);

            // Update the final state based on send result
            if (success) {
              // Mark as sent and clean up pending key
              await firestoreSet(
                doc.ref,
                {
                  specialDayEmailsSent: firebase.firestore.FieldValue.arrayUnion(campaignId),
                  lastSpecialDaySentAt: firebase.firestore.Timestamp.now(),
                  pendingSpecialDayKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
                },
                { merge: true },
                `mark special day campaign ${campaignId} sent`
              );
              console.log(`✅ Sent special day email (${campaignId}) to ${userEmail}`);
              return { type: "sent" as const, email: userEmail, specialDayId: specialDay.id, campaignId };
            } else {
              // Send failed - remove pending key so it can be retried
              await firestoreSet(
                doc.ref,
                {
                  pendingSpecialDayKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
                },
                { merge: true },
                `remove pending key after failed special day send`
              );
              return {
                type: "error" as const,
                email: userEmail,
                error: `Failed to send special day email (${campaignId})`,
              };
            }
          } catch (error: any) {
            console.error(`Error processing user ${userEmail} for ${specialDay.id}:`, error);
            return { type: "error" as const, email: userEmail, error: error.message || "Unknown error" };
          }
        },
        { concurrency: EMAIL_SEND_CONCURRENCY }
      );

      // Aggregate results from parallel processing
      for (const result of results) {
        totalProcessed++;
        if (result.type === "sent") {
          totalSent++;
          sentList.push({ email: result.email, specialDayId: result.specialDayId, campaignId: result.campaignId });
        } else if (result.type === "skipped") {
          skippedList.push({ email: result.email, reason: result.reason });
        } else if (result.type === "error") {
          totalErrors++;
          errorsList.push(`${result.email}: ${result.error}`);
        }
      }

      // Alert ops if we have repeated failures (check after each special day)
      if (totalErrors >= 5) {
        sendOpsAlert(
          "Special Day Email Failures",
          `Multiple special day email failures detected:\n${errorsList.slice(0, 5).join("\n")}`,
          { context: { endpoint: "/api/cron/processSpecialDayEmails", errorCount: totalErrors } }
        ).catch(() => {});
      }
    }

    // Log detailed results to console (for Vercel logs)
    console.log(`📊 Special day email processing complete:`);
    console.log(`   Total accepted users: ${allUsersSnapshot.docs.length}`);
    console.log(`   Special days processed: ${specialDaysToSend.map((s) => s.name).join(", ")}`);
    console.log(`   Processed: ${totalProcessed}, Sent: ${totalSent}, Errors: ${totalErrors}`);

    if (sentList.length > 0) {
      console.log(`📬 Emails sent:`);
      for (const item of sentList) {
        console.log(`   ✅ ${item.email} - ${item.campaignId}`);
      }
    }

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

    // Return summary JSON (lightweight)
    return res.status(200).json({
      message: testEmail ? `Special day emails processed (TEST MODE: ${testEmail})` : "Special day emails processed",
      processed: totalProcessed,
      sent: totalSent,
      errors: totalErrors,
      specialDays: specialDaysToSend.map((s) => s.id),
      testMode: !!testEmail,
      testEmail: testEmail || undefined,
    });
  } catch (error: any) {
    console.error("Error processing special day emails:", error);

    // Check if this is a Firestore index error and notify ops
    const indexAnalysis = analyzeFirestoreError(error);
    if (indexAnalysis.isIndexError) {
      await notifyOpsOfIndexError(error, {
        endpoint: "/api/cron/processSpecialDayEmails",
        collection: getUsersCollectionName(),
        fields: ["inviteStatus"],
        query: "users eligible for special day emails",
      });

      return res.status(503).json({
        error: indexAnalysis.userMessage,
        type: "firestore_index_error",
        adminMessage: indexAnalysis.adminMessage,
        indexUrl: indexAnalysis.indexUrl,
      });
    }

    const safeMessage = getSafeErrorMessage(error, "Failed to process special day emails");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtOrCronAuth(handler);
