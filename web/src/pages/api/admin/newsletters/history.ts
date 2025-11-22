import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import firebase from "firebase-admin";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    name: "newsletterHistory",
    max: 20,
    windowMs: 60 * 1000, // 1 minute
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Validate superuser role from Firestore (source of truth)
    await requireSuperuserRoleFromFirestore(req);

    // Get newsletter history (most recent first)
    const newslettersCol = getNewslettersCollectionName();
    const newslettersQuery = db.collection(newslettersCol).orderBy("sentAt", "desc").limit(50); // Limit to last 50 newsletters

    const newslettersSnapshot = await firestoreQueryGet(
      newslettersQuery,
      "get newsletter history",
      "admin newsletter history"
    );

    const newsletters = newslettersSnapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      return {
        id: doc.id,
        subject: data.subject || "",
        content: data.content || "",
        sentAt: data.sentAt?.toDate?.()?.toISOString() || data.sentAt,
        sentBy: data.sentBy || "unknown",
        recipientCount: data.totalQueued || 0, // Use totalQueued instead of recipientCount
        successCount: data.sentCount || 0, // Use sentCount instead of successCount
        errorCount: data.failedCount || 0, // Use failedCount instead of errorCount
        ctaUrl: data.ctaUrl || null,
        ctaText: data.ctaText || null,
      };
    });

    return res.status(200).json({
      newsletters,
      total: newsletters.length,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Newsletter history error:", error instanceof Error ? error.name : "Unknown error");
    
    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({
        error: "Forbidden: Superuser privileges required",
      });
    }
    
    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Failed to fetch newsletter history");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtAuth(handler);
