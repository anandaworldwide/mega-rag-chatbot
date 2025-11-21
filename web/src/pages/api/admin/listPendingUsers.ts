// Lists pending users for the current site for admin UI
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

  // Parse pagination parameters
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;

  try {
    // Get total count first
    const countSnapshot = await db.collection(usersCol).where("inviteStatus", "==", "pending").get();
    const totalCount = countSnapshot.size;

    // Get paginated results
    const snapshot = await db
      .collection(usersCol)
      .where("inviteStatus", "==", "pending")
      .orderBy("createdAt", "desc")
      .offset(offset)
      .limit(limit)
      .get();

    const items = snapshot.docs.map((d: any) => {
      const data = d.data() || {};
      return {
        email: d.id, // Email is stored as document ID
        invitedAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toLocaleString() : null,
        expiresAt: data.inviteExpiresAt?.toDate?.() ? data.inviteExpiresAt.toDate().toLocaleString() : null,
        invitedByEmail: data.invitedByEmail || null,
        invitedByName: data.invitedByName || null,
      };
    });

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to list pending users" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
