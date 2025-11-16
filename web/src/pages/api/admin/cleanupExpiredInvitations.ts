// API: Daily cleanup of expired pending account invitations. Intended for Vercel Cron (once per day).
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { writeAuditLog } from "@/utils/server/auditLog";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import firebase from "firebase-admin";

/**
 * Middleware that allows either JWT authentication or Vercel cron requests
 * @param handler The API route handler to wrap
 * @returns A wrapped handler that checks for either valid JWT or Vercel cron
 */
function withJwtOrCronAuth(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const userAgent = req.headers["user-agent"] || "";
    const isVercelCron = userAgent.startsWith("vercel-cron/");
    const authHeader = req.headers.authorization || "";

    if (isVercelCron) {
      // Verify that cron requests provide the correct secret
      if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      // Allow authorized Vercel cron requests through
      return handler(req, res);
    } else {
      // For all other requests, require JWT authentication
      return withJwtAuth(handler)(req, res);
    }
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Light rate limit to avoid accidental rapid calls
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 3,
    name: "cleanup-expired-invitations",
  });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  // Load site config to check if login is required
  const siteConfig = loadSiteConfigSync();

  // If site doesn't require login, there are no invitations to clean up
  if (siteConfig && !siteConfig.requireLogin) {
    return res.status(200).json({
      ok: true,
      summary: {
        totalExpired: 0,
        deletedCount: 0,
        errorCount: 0,
        deletedEmails: [],
        errors: [],
      },
      message: "Site does not require login - no invitations to clean up",
    });
  }

  try {
    const now = firebase.firestore.Timestamp.now();
    const usersCollection = process.env.NODE_ENV === "production" ? "prod_users" : "dev_users";

    // Find all pending invitations that have expired
    const expiredInvitationsQuery = db
      .collection(usersCollection)
      .where("inviteStatus", "==", "pending")
      .where("inviteExpiresAt", "<=", now);

    let expiredSnapshot;
    try {
      expiredSnapshot = await expiredInvitationsQuery.get();
    } catch (firestoreError: any) {
      const errorResponse = createIndexErrorResponse(firestoreError, {
        endpoint: "/api/admin/cleanupExpiredInvitations",
        collection: usersCollection,
        fields: ["inviteStatus", "inviteExpiresAt", "__name__"],
        query: "pending invitations with expired dates",
      });

      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }

      // Re-throw other Firestore errors
      throw firestoreError;
    }

    const expiredInvitations = expiredSnapshot.docs;
    let deletedCount = 0;
    let errorCount = 0;
    const deletedEmails: string[] = [];
    const errors: Array<{ email: string; error: string }> = [];

    // Process expired invitations in batches to avoid overwhelming Firestore
    const batchSize = 10;
    for (let i = 0; i < expiredInvitations.length; i += batchSize) {
      const batch = expiredInvitations.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (doc) => {
          const email = doc.id; // Email is stored as document ID
          const data = doc.data();

          try {
            // Delete the expired invitation
            await doc.ref.delete();
            deletedCount++;
            deletedEmails.push(email);

            // Write audit log for the deletion
            await writeAuditLog(req, "expired_invitation_cleanup", email, {
              outcome: "deleted",
              expiresAt: data?.inviteExpiresAt?.toDate?.()?.toISOString() || "unknown",
              createdAt: data?.createdAt?.toDate?.()?.toISOString() || "unknown",
            });
          } catch (deleteError: any) {
            errorCount++;
            const errorMessage = deleteError instanceof Error ? deleteError.message : "Unknown error";
            errors.push({ email, error: errorMessage });

            console.error(`Failed to delete expired invitation for ${email}:`, deleteError);

            // Write audit log for the error
            await writeAuditLog(req, "expired_invitation_cleanup", email, {
              outcome: "error",
              error: errorMessage,
            });
          }
        })
      );
    }

    // Prepare summary
    const summary = {
      totalExpired: expiredInvitations.length,
      deletedCount,
      errorCount,
      deletedEmails: deletedEmails.slice(0, 20), // Show first 20 emails
      errors: errors.slice(0, 5), // Show first 5 errors
    };

    return res.status(200).json({
      ok: true,
      summary,
      message: `Cleanup completed: ${summary.deletedCount} expired invitations deleted, ${summary.errorCount} errors`,
    });
  } catch (e: any) {
    const errorMessage = e?.message || "Failed to cleanup expired invitations";
    console.error("Expired invitation cleanup failed:", e);
    return res.status(500).json({ error: errorMessage });
  }
}

// Apply API middleware, skipping its default auth check and relying solely on withJwtOrCronAuth
export default withApiMiddleware(withJwtOrCronAuth(handler), {
  skipAuth: true,
});
