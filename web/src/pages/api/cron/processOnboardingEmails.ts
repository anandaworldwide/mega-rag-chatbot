import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { isSubscribedToCategory } from "@/utils/server/emailPreferenceUtils";
import { sendOnboardingEmail, loadOnboardingTemplate } from "@/utils/server/onboardingEmailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import { User } from "@/types/user";
import { daysSince } from "@/utils/server/dateUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import firebase from "firebase-admin";
import crypto from "crypto";

const ONBOARDING_DAYS = [0, 3, 7, 14]; // Days when emails should be sent (0 = immediately)

/**
 * Generates an idempotency key for onboarding email operations
 */
function generateOnboardingIdempotencyKey(email: string, day: number): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return crypto.createHash("sha256").update(`onboarding:${email}:day${day}:${date}`).digest("hex").substring(0, 16);
}

/**
 * Determines which onboarding email should be sent based on days since start
 *
 * Strategy: Send the most recent eligible email, not the earliest.
 * This prevents spamming users who sign up late with multiple emails.
 *
 * Example: If user is at day 6, send day 7 email (when they reach day 7),
 * not day 0, then day 3, then day 7.
 */
function getNextEmailDay(daysSinceStart: number, emailsSent: number[]): number | null {
  // Find the highest eligible email day that hasn't been sent yet
  // Iterate backwards to find the most recent one first
  for (let i = ONBOARDING_DAYS.length - 1; i >= 0; i--) {
    const day = ONBOARDING_DAYS[i];
    if (daysSinceStart >= day && !emailsSent.includes(day)) {
      return day;
    }
  }
  return null;
}

/**
 * Processes onboarding emails for eligible users
 */
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting for defense in depth (runs once daily via Vercel cron)
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "process-onboarding-emails",
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

    // Query users who:
    // 1. Have accepted invitations (are active users)
    // 2. Haven't completed onboarding (including users where field is missing)
    //
    // NOTE: We only query for inviteStatus and filter onboardingCompleted in JavaScript
    // because Firestore's != operator doesn't match documents where the field is missing.
    const usersCol = getUsersCollectionName();
    const usersQuery = db.collection(usersCol).where("inviteStatus", "==", "accepted");

    const allUsersSnapshot = await firestoreQueryGet(usersQuery, "get users for onboarding emails", "onboarding cron");

    // Filter out users who have completed onboarding (includes missing field as eligible)
    const eligibleDocs = allUsersSnapshot.docs.filter((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      return data.onboardingCompleted !== true;
    });

    if (eligibleDocs.length === 0) {
      console.log(`📊 No users eligible for onboarding emails (${allUsersSnapshot.docs.length} total accepted users)`);
      return res.status(200).json({
        message: "No users eligible for onboarding emails",
        processed: 0,
        sent: 0,
        errors: 0,
      });
    }

    let processed = 0;
    let sent = 0;
    let errors = 0;
    const errorsList: string[] = [];
    const sentList: { email: string; day: number; daysSinceStart: number }[] = [];
    const skippedList: { email: string; reason: string }[] = [];

    // Process each user
    for (const doc of eligibleDocs) {
      processed++;
      const userData = doc.data() as User;
      const userEmail = doc.id; // Email is the document ID
      userData.id = userEmail; // Set for email sending

      try {
        // Check if user is subscribed to onboarding emails
        if (!isSubscribedToCategory(userData, "onboarding")) {
          console.log(`Skipping ${userEmail} - not subscribed to onboarding emails`);
          skippedList.push({ email: userEmail, reason: "not subscribed to onboarding" });
          continue;
        }

        // Get onboarding start date
        let onboardingStartedAt = userData.onboardingStartedAt;
        if (!onboardingStartedAt) {
          // Start onboarding for this user
          // For existing users who sign up after feature rollout, use createdAt to determine
          // how long they've been a member. This prevents spamming users with retroactive emails.
          const createdAt = userData.createdAt || doc.createTime;
          const now = firebase.firestore.Timestamp.now();

          // Calculate days since account creation (for existing users)
          const daysSinceCreation = daysSince(createdAt);

          // Mark earlier emails as "sent" if user has been a member long enough
          // This ensures they only get emails going forward, not retroactive spam
          const emailsToMarkAsSent: number[] = [];
          for (const day of ONBOARDING_DAYS) {
            if (daysSinceCreation > day) {
              emailsToMarkAsSent.push(day);
            }
          }

          // Set onboardingStartedAt to account creation time (or now if no createdAt)
          // This way daysSinceStart will reflect actual membership duration
          onboardingStartedAt = createdAt || now;

          await firestoreSet(
            doc.ref,
            {
              onboardingStartedAt: onboardingStartedAt,
              onboardingEmailsSent: emailsToMarkAsSent,
            },
            { merge: true },
            "start onboarding sequence for existing user"
          );

          // Calculate days since onboarding started
          const daysSinceStart = daysSinceCreation;
          const emailsSent = emailsToMarkAsSent;

          // Get the most recent eligible email (not the earliest)
          const nextDay = getNextEmailDay(daysSinceStart, emailsSent);
          if (nextDay !== null) {
            // Check if template exists for this site
            const template = await loadOnboardingTemplate(nextDay, siteId);
            if (!template) {
              console.log(`Skipping ${userEmail} - no onboarding template for day ${nextDay}, site ${siteId}`);
              skippedList.push({ email: userEmail, reason: `no template for day ${nextDay}` });
              continue;
            }
            // Send the email
            const success = await sendOnboardingEmail(userData, nextDay, siteId, baseUrl);
            if (success) {
              await firestoreSet(
                doc.ref,
                {
                  onboardingEmailsSent: [...emailsSent, nextDay].sort((a, b) => a - b),
                },
                { merge: true },
                `mark day ${nextDay} email sent`
              );
              sent++;
              sentList.push({ email: userEmail, day: nextDay, daysSinceStart: daysSinceCreation });
              console.log(
                `✅ Sent onboarding email (day ${nextDay}) to ${userEmail} (existing user, ${daysSinceCreation} days since signup)`
              );
            } else {
              errors++;
              errorsList.push(`${userEmail}: Failed to send day ${nextDay} email`);
            }
          }
          // No email due - don't add to skippedList (too noisy)
          continue;
        }

        // Calculate days since onboarding started
        const daysSinceStart = daysSince(onboardingStartedAt);
        const emailsSent = userData.onboardingEmailsSent || [];

        // Check if onboarding should be marked as completed
        if (daysSinceStart >= 14 && emailsSent.length >= ONBOARDING_DAYS.length) {
          await firestoreSet(
            doc.ref,
            {
              onboardingCompleted: true,
            },
            { merge: true },
            "mark onboarding completed"
          );
          skippedList.push({ email: userEmail, reason: "marked as completed" });
          continue;
        }

        // Determine which email to send
        const nextDay = getNextEmailDay(daysSinceStart, emailsSent);
        if (nextDay === null) {
          // No email to send at this time - don't add to skippedList (too noisy)
          continue;
        }

        // Check if template exists for this site (onboarding emails are site-specific)
        const template = await loadOnboardingTemplate(nextDay, siteId);
        if (!template) {
          console.log(`Skipping ${userEmail} - no onboarding template for day ${nextDay}, site ${siteId}`);
          skippedList.push({ email: userEmail, reason: `no template for day ${nextDay}` });
          continue;
        }

        // Generate idempotency key to prevent duplicate sends
        const idempotencyKey = generateOnboardingIdempotencyKey(userEmail, nextDay);

        // Use a transaction to atomically check and update the email sent status
        // This prevents race conditions if cron runs overlap
        const userDocRef = doc.ref as firebase.firestore.DocumentReference;
        const sendResult = await db.runTransaction(async (transaction) => {
          // Re-read the user document to get fresh state
          const freshDocSnap = await transaction.get(userDocRef);
          if (!freshDocSnap.exists) {
            return { sent: false, reason: "user_not_found" };
          }

          const freshData = freshDocSnap.data() as User;
          const freshEmailsSent = freshData.onboardingEmailsSent || [];

          // Check if already sent (another cron run may have sent it)
          if (freshEmailsSent.includes(nextDay)) {
            return { sent: false, reason: "already_sent" };
          }

          // Check idempotency key (prevents same-day duplicate attempts)
          const pendingKeys = freshData.pendingOnboardingKeys || [];
          if (pendingKeys.includes(idempotencyKey)) {
            return { sent: false, reason: "pending_send" };
          }

          // Mark as pending before sending (optimistic lock)
          transaction.update(userDocRef, {
            pendingOnboardingKeys: firebase.firestore.FieldValue.arrayUnion(idempotencyKey),
          });

          return { sent: true, reason: "proceed" };
        });

        if (!sendResult.sent) {
          if (sendResult.reason === "already_sent") {
            skippedList.push({ email: userEmail, reason: `day ${nextDay} already sent (detected in transaction)` });
          } else if (sendResult.reason === "pending_send") {
            skippedList.push({ email: userEmail, reason: `day ${nextDay} pending send in progress` });
          }
          continue;
        }

        // Now send the email (outside transaction to avoid long-running txn)
        const success = await sendOnboardingEmail(userData, nextDay, siteId, baseUrl);

        // Update the final state based on send result
        if (success) {
          // Mark as sent and clean up pending key
          await firestoreSet(
            doc.ref,
            {
              onboardingEmailsSent: firebase.firestore.FieldValue.arrayUnion(nextDay),
              pendingOnboardingKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
            },
            { merge: true },
            `mark day ${nextDay} email sent`
          );
          sent++;
          sentList.push({ email: userEmail, day: nextDay, daysSinceStart });
          console.log(`✅ Sent onboarding email (day ${nextDay}) to ${userEmail}`);
        } else {
          // Send failed - remove pending key so it can be retried
          await firestoreSet(
            doc.ref,
            {
              pendingOnboardingKeys: firebase.firestore.FieldValue.arrayRemove(idempotencyKey),
            },
            { merge: true },
            `remove pending key after failed onboarding send`
          );
          errors++;
          errorsList.push(`${userEmail}: Failed to send day ${nextDay} email`);

          // Alert ops if we have repeated failures
          if (errors >= 5) {
            sendOpsAlert(
              "Onboarding Email Failures",
              `Multiple onboarding email failures detected:\n${errorsList.slice(0, 5).join("\n")}`,
              { context: { endpoint: "/api/cron/processOnboardingEmails", errorCount: errors } }
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

    // Log detailed results to console (for Vercel logs)
    console.log(`📊 Onboarding email processing complete:`);
    console.log(`   Total accepted users: ${allUsersSnapshot.docs.length}`);
    console.log(`   Eligible (not completed): ${eligibleDocs.length}`);
    console.log(`   Processed: ${processed}, Sent: ${sent}, Errors: ${errors}`);

    if (sentList.length > 0) {
      console.log(`📬 Emails sent:`);
      for (const item of sentList) {
        console.log(`   ✅ ${item.email} - day ${item.day} (${item.daysSinceStart} days since start)`);
      }
    }

    if (skippedList.length > 0) {
      console.log(`⏭️ Skipped users:`);
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
      message: "Onboarding emails processed",
      processed,
      sent,
      errors,
    });
  } catch (error: any) {
    console.error("Error processing onboarding emails:", error);

    // Check if this is a Firestore index error and notify ops
    const indexAnalysis = analyzeFirestoreError(error);
    if (indexAnalysis.isIndexError) {
      await notifyOpsOfIndexError(error, {
        endpoint: "/api/cron/processOnboardingEmails",
        collection: getUsersCollectionName(),
        fields: ["inviteStatus", "onboardingCompleted"],
        query: "users eligible for onboarding emails",
      });

      return res.status(503).json({
        error: indexAnalysis.userMessage,
        type: "firestore_index_error",
        adminMessage: indexAnalysis.adminMessage,
        indexUrl: indexAnalysis.indexUrl,
      });
    }

    const safeMessage = getSafeErrorMessage(error, "Failed to process onboarding emails");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtOrCronAuth(handler);
