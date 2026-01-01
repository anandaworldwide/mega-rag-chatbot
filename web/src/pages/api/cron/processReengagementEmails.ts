import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendReengagementEmail, loadReengagementTemplate } from "@/utils/server/reengagementEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import { User } from "@/types/user";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import firebase from "firebase-admin";

const CAMPAIGN_ID = "reengagement-21-nudge";
const INACTIVITY_MIN_DAYS = 21;
const INACTIVITY_MAX_DAYS = 60;

/**
 * Calculates days since a timestamp
 */
function daysSince(timestamp: firebase.firestore.Timestamp | null | undefined): number {
  if (!timestamp) return 0;
  const ts = timestamp.toMillis ? timestamp.toMillis() : (timestamp as any)._seconds * 1000;
  const now = Date.now();
  const diffMs = now - ts;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Checks if a site requires login (and thus has user accounts for re-engagement)
 */
function isLoginRequiredSite(siteId: string): boolean {
  // Only login-required sites have user accounts with email addresses
  // Non-login sites (ananda-public, crystal) don't have user accounts
  return siteId === "ananda" || siteId === "jairam";
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting for defense in depth (runs once daily via Vercel cron)
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "process-reengagement-emails",
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
    if (!isLoginRequiredSite(siteId)) {
      console.log(`📊 Skipping re-engagement emails for site ${siteId} (not a login-required site)`);
      return res.status(200).json({
        message: `Site ${siteId} does not require login - skipping re-engagement emails`,
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    // Check if template exists for this site
    const template = await loadReengagementTemplate(siteId);
    if (!template) {
      console.log(`📊 No re-engagement template found for site ${siteId}`);
      return res.status(200).json({
        message: `No re-engagement template found for site ${siteId}`,
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    // Check for test mode (single user testing)
    const testEmail = process.env.REENGAGEMENT_TEST_EMAIL;
    if (testEmail) {
      console.log(`🧪 TEST MODE: Processing re-engagement email for test user: ${testEmail}`);
    }

    // Query users who:
    // 1. Have accepted invitations (are active users)
    // 2. Have lastLoginAt or lastActivityAt field (have logged in or been active at least once)
    const usersCol = getUsersCollectionName();
    let allUsersSnapshot: firebase.firestore.QuerySnapshot;

    if (testEmail) {
      // In test mode, fetch only the specific user document
      const userDocRef = db.collection(usersCol).doc(testEmail);
      const userDoc = await firestoreGet(userDocRef, "get test user for re-engagement email", "re-engagement cron");

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
        console.log(`🧪 TEST MODE: User ${testEmail} has inviteStatus "${userData.inviteStatus}" (not "accepted")`);
        // Continue anyway in test mode, but log it
      }

      // Convert single doc to QuerySnapshot-like structure for compatibility
      // Cast DocumentSnapshot to QueryDocumentSnapshot for type compatibility
      allUsersSnapshot = {
        empty: false,
        docs: [userDoc as FirebaseFirestore.QueryDocumentSnapshot],
        size: 1,
        query: userDocRef as any,
      } as FirebaseFirestore.QuerySnapshot;
    } else {
      // Normal mode: query all accepted users
      const usersQuery = db.collection(usersCol).where("inviteStatus", "==", "accepted");
      allUsersSnapshot = await firestoreQueryGet(
        usersQuery,
        "get users for re-engagement emails",
        "re-engagement cron"
      );
    }

    // Filter users based on eligibility criteria:
    // 1. Must be subscribed to re-engagement emails
    // 2. Must not have already received this campaign
    // 3. Must have lastActivityAt (or lastLoginAt) within 21-60 days ago
    const eligibleDocs = allUsersSnapshot.docs.filter((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as User;

      // Check subscription preference
      if (!isSubscribedToCategory(data, "reengagement")) {
        return false;
      }

      // Check if already sent this campaign
      const emailsSent = data.reengagementEmailsSent || [];
      if (emailsSent.includes(CAMPAIGN_ID)) {
        return false;
      }

      // Check inactivity window (21-60 days)
      // Use lastActivityAt if available (chat/search activity), fall back to lastLoginAt
      const lastActivity = data.lastActivityAt || data.lastLoginAt;
      if (!lastActivity) {
        // Users who have never logged in or been active are not eligible
        return false;
      }

      const daysSinceActivity = daysSince(lastActivity);
      return daysSinceActivity >= INACTIVITY_MIN_DAYS && daysSinceActivity <= INACTIVITY_MAX_DAYS;
    });

    if (eligibleDocs.length === 0) {
      const message = testEmail
        ? `No users eligible for re-engagement emails (test user: ${testEmail})`
        : `No users eligible for re-engagement emails (${allUsersSnapshot.docs.length} total accepted users)`;
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
    const sentList: { email: string; daysSinceLogin: number }[] = [];
    const skippedList: { email: string; reason: string }[] = [];

    // Process each eligible user
    for (const doc of eligibleDocs) {
      processed++;
      const userData = doc.data() as User;
      const userEmail = doc.id; // Email is the document ID
      userData.id = userEmail; // Set for email sending

      try {
        // Double-check subscription (defensive)
        if (!isSubscribedToCategory(userData, "reengagement")) {
          skippedList.push({ email: userEmail, reason: "not subscribed to re-engagement" });
          continue;
        }

        // Double-check idempotency (defensive)
        const emailsSent = userData.reengagementEmailsSent || [];
        if (emailsSent.includes(CAMPAIGN_ID)) {
          skippedList.push({ email: userEmail, reason: "already sent this campaign" });
          continue;
        }

        // Calculate days since last activity (chat/search) or login
        // Use lastActivityAt if available, fall back to lastLoginAt
        const lastActivity = userData.lastActivityAt || userData.lastLoginAt;
        if (!lastActivity) {
          skippedList.push({ email: userEmail, reason: "no lastActivityAt or lastLoginAt timestamp" });
          continue;
        }

        const daysSinceActivity = daysSince(lastActivity);

        // Final eligibility check
        if (daysSinceActivity < INACTIVITY_MIN_DAYS || daysSinceActivity > INACTIVITY_MAX_DAYS) {
          skippedList.push({
            email: userEmail,
            reason: `outside inactivity window (${daysSinceActivity} days since activity)`,
          });
          continue;
        }

        // Send the email
        const success = await sendReengagementEmail(userData, siteId, baseUrl);
        if (success) {
          // Update emails sent list and timestamp
          const updatedEmailsSent = [...emailsSent, CAMPAIGN_ID];
          await firestoreSet(
            doc.ref,
            {
              reengagementEmailsSent: updatedEmailsSent,
              lastReengagementSentAt: firebase.firestore.Timestamp.now(),
            },
            { merge: true },
            `mark re-engagement campaign ${CAMPAIGN_ID} sent`
          );
          sent++;
          sentList.push({ email: userEmail, daysSinceLogin: daysSinceActivity });
          console.log(`✅ Sent re-engagement email to ${userEmail} (${daysSinceActivity} days since activity)`);
        } else {
          errors++;
          errorsList.push(`${userEmail}: Failed to send re-engagement email`);
        }
      } catch (error: any) {
        errors++;
        const errorMsg = `${userEmail}: ${error.message || "Unknown error"}`;
        errorsList.push(errorMsg);
        console.error(`Error processing user ${userEmail}:`, error);
      }
    }

    // Log detailed results to console (for Vercel logs)
    console.log(`📊 Re-engagement email processing complete:`);
    console.log(`   Total accepted users: ${allUsersSnapshot.docs.length}`);
    console.log(`   Eligible (21-30 days inactive, subscribed, not sent): ${eligibleDocs.length}`);
    console.log(`   Processed: ${processed}, Sent: ${sent}, Errors: ${errors}`);

    if (sentList.length > 0) {
      console.log(`📬 Emails sent:`);
      for (const item of sentList) {
        console.log(`   ✅ ${item.email} - ${item.daysSinceLogin} days since login`);
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
      message: testEmail ? `Re-engagement email processed (TEST MODE: ${testEmail})` : "Re-engagement emails processed",
      processed,
      sent,
      errors,
      testMode: !!testEmail,
      testEmail: testEmail || undefined,
    });
  } catch (error: any) {
    console.error("Error processing re-engagement emails:", error);

    // Check if this is a Firestore index error and notify ops
    const indexAnalysis = analyzeFirestoreError(error);
    if (indexAnalysis.isIndexError) {
      await notifyOpsOfIndexError(error, {
        endpoint: "/api/cron/processReengagementEmails",
        collection: getUsersCollectionName(),
        fields: ["inviteStatus", "lastLoginAt"],
        query: "users eligible for re-engagement emails",
      });

      return res.status(503).json({
        error: indexAnalysis.userMessage,
        type: "firestore_index_error",
        adminMessage: indexAnalysis.adminMessage,
        indexUrl: indexAnalysis.indexUrl,
      });
    }

    const safeMessage = getSafeErrorMessage(error, "Failed to process re-engagement emails");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtOrCronAuth(handler);
