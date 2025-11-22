// Gets the total count of pending users for the current site
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "admin_pending_users_count",
  });
  if (!allowed) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) return res.status(503).json({ error: "Database not available" });

  // Authorization: admin or superuser only (verified from Firestore source of truth)
  try {
    await requireAdminRoleFromFirestore(req);
  } catch (error: any) {
    if (error.message?.includes("Unauthorized") || error.message?.includes("Admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    throw error;
  }

  const usersCol = getUsersCollectionName();

  try {
    // Get total count of pending users without limit
    const snapshot = await db.collection(usersCol).where("inviteStatus", "==", "pending").get();
    const totalCount = snapshot.size;

    return res.status(200).json({ count: totalCount });
  } catch (err: any) {
    const safeMessage = getSafeErrorMessage(err, "Failed to get pending users count");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
