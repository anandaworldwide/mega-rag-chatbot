// API: Daily digest of self-provision attempts. Intended for Vercel Cron (once per day).
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Light rate limit to avoid accidental rapid calls
  const allowed = await genericRateLimiter(req, res, { windowMs: 60 * 1000, max: 3, name: "digest-self-provision" });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  try {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const siteId = process.env.SITE_ID || "default";
    const collection = process.env.NODE_ENV === "production" ? "prod_admin_audit" : "dev_admin_audit";

    // Fetch last 24h self_provision_attempt and user_activation_completed entries
    let selfProvisionSnap, activationSnap;
    try {
      [selfProvisionSnap, activationSnap] = await Promise.all([
        db.collection(collection).where("action", "==", "self_provision_attempt").where("createdAt", ">=", since).get(),
        db
          .collection(collection)
          .where("action", "==", "user_activation_completed")
          .where("createdAt", ">=", since)
          .get(),
      ]);
    } catch (firestoreError: any) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/digestSelfProvision",
        collection: collection,
        fields: ["action", "createdAt", "__name__"],
        query: "self_provision_attempt and user_activation_completed audit entries",
      });

      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }

      // Re-throw other Firestore errors
      throw firestoreError;
    }

    let activationEmailsSent = 0;
    let activationsCompleted = 0;
    let errors = 0;
    const samples: Array<{
      target?: string;
      outcome?: string;
      firstName?: string;
      lastName?: string;
    }> = [];

    // First pass: count self-provision outcomes (for activation emails sent)
    const emailsToLookup: string[] = [];
    selfProvisionSnap.forEach((doc) => {
      const data = doc.data() as any;
      const outcome = data?.details?.outcome as string | undefined;

      if (outcome === "created_pending_user") activationEmailsSent++;
      else if (outcome === "server_error") errors++;
      // Skip resent_pending_activation and invalid_password entries entirely
    });

    // Second pass: count activation completions and collect samples
    activationSnap.forEach((doc) => {
      const data = doc.data() as any;
      const outcome = data?.details?.outcome as string | undefined;
      const email = data?.target as string | undefined;

      if (outcome === "activation_completed") {
        activationsCompleted++;
        if (samples.length < 100) {
          samples.push({ target: email, outcome });
          if (email) {
            emailsToLookup.push(email);
          }
        }
      }
    });

    // Third pass: fetch actual user data for names only (not status)
    const userDataMap = new Map<string, { firstName?: string; lastName?: string }>();
    if (emailsToLookup.length > 0) {
      try {
        const userCollection = process.env.NODE_ENV === "production" ? "prod_users" : "dev_users";
        const userQueries = emailsToLookup.map(
          (email) => db!.collection(userCollection).doc(email).get() // Email is stored as document ID
        );

        const userResults = await Promise.all(userQueries);
        userResults.forEach((userSnap, index) => {
          if (userSnap.exists) {
            const userData = userSnap.data();
            if (userData) {
              userDataMap.set(emailsToLookup[index], {
                firstName: userData.firstName,
                lastName: userData.lastName,
                // Don't include inviteStatus - use audit entry outcome instead
              });
            }
          }
        });
      } catch (userFetchError) {
        console.warn("Failed to fetch user data for digest:", userFetchError);
      }
    }

    // Enrich samples with actual user data (names only)
    samples.forEach((sample) => {
      if (sample.target && userDataMap.has(sample.target)) {
        const userData = userDataMap.get(sample.target);
        sample.firstName = userData?.firstName;
        sample.lastName = userData?.lastName;
        // Don't set inviteStatus - use audit entry outcome instead
      }
    });

    // Format samples in a user-friendly way
    const formatSamples = (
      samples: Array<{
        target?: string;
        outcome?: string;
        firstName?: string;
        lastName?: string;
      }>,
      totalCount: number
    ) => {
      if (samples.length === 0) return "No activity in the last 24 hours.";

      const samplesList = samples
        .map((sample, index) => {
          const email = sample.target || "unknown@email.com";
          const outcome = sample.outcome || "unknown";

          // Use real name if available, otherwise fall back to email prefix
          const fullName =
            sample.firstName && sample.lastName
              ? `${sample.firstName} ${sample.lastName}`
              : sample.firstName || email.split("@")[0];
          const displayName = fullName;

          // Always use audit entry outcome, not current user status
          const statusText =
            {
              activation_completed: "Account activated",
              server_error: "Server error occurred",
            }[outcome] || outcome;

          return `${index + 1}. ${displayName} (${email}) - ${statusText}`;
        })
        .join("\n");

      // Add "plus X more" if there are additional activations beyond the limit
      const additionalCount = totalCount - samples.length;
      if (additionalCount > 0) {
        return `${samplesList}\n\nplus ${additionalCount} more not shown here`;
      }

      return samplesList;
    };

    const body = [
      `Self-provision digest for site ${siteId} (last 24h)`,
      ``,
      `SUMMARY:`,
      `• Activations completed: ${activationsCompleted}`,
      `• Activation emails sent: ${activationEmailsSent}`,
      `• Server errors: ${errors}`,
      ``,
      `ACTIVITY DETAILS:`,
      formatSamples(samples, activationsCompleted),
    ].join("\n");

    // Create subject line with error counts
    const subjectParts = [];
    if (errors > 0) subjectParts.push(`${errors} error${errors > 1 ? "s" : ""}`);

    const subject = `User activation digest: ${activationsCompleted} activated, ${errors} errors`;

    // Only send email if there's actual activity to report
    if (activationsCompleted > 0 || activationEmailsSent > 0 || errors > 0) {
      await sendOpsAlert(subject, body);
    }
    return res.status(200).json({ ok: true, counts: { activationsCompleted, activationEmailsSent, errors }, samples });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to build digest" });
  }
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true });
