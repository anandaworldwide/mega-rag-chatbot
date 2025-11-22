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
    name: "newslettersList",
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

    const { status } = req.query;

    // Get newsletters (most recent first)
    const newslettersCol = getNewslettersCollectionName();
    let newslettersQuery = db.collection(newslettersCol).orderBy("createdAt", "desc").limit(50);

    // Filter by status if provided
    // For 'queued' status, also include 'in_progress' newsletters (they have remaining items)
    if (status && typeof status === "string") {
      if (status === "queued") {
        newslettersQuery = newslettersQuery.where("status", "in", ["queued", "in_progress"]);
      } else {
        newslettersQuery = newslettersQuery.where("status", "==", status);
      }
    }

    const newslettersSnapshot = await firestoreQueryGet(
      newslettersQuery,
      "get newsletters list",
      "admin newsletters list"
    );

    const newsletters = newslettersSnapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      return {
        id: doc.id,
        subject: data.subject || "",
        content: data.content || "",
        status: data.status || "unknown",
        totalQueued: data.totalQueued || 0,
        sentCount: data.sentCount || 0,
        failedCount: data.failedCount || 0,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
        sentBy: data.sentBy || "unknown",
      };
    });

    return res.status(200).json({
      newsletters,
      total: newsletters.length,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Newsletter list error:", error instanceof Error ? error.name : "Unknown error");
    
    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({
        error: "Forbidden: Superuser privileges required",
      });
    }
    
    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Failed to fetch newsletters");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtAuth(handler);
