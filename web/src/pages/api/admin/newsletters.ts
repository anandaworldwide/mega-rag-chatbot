import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { requireSuperuserRole } from "@/utils/server/authz";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import firebase from "firebase-admin";

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
    // Validate superuser role
    requireSuperuserRole(req);

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
    console.error("Newsletter list error:", error);
    return res.status(500).json({
      error: "Failed to fetch newsletters",
      details: error.message,
    });
  }
}

export default withJwtAuth(handler);
