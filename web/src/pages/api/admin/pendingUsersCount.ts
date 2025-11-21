// Gets the total count of pending users for the current site
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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
    return res.status(500).json({ error: err?.message || "Failed to get pending users count" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
