import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import firebase from "firebase-admin";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

interface DeleteRequest {
  newsletterId: string;
}

interface DeleteResponse {
  deleted: number;
  message: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse<DeleteResponse | { error: string }>) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Verify superuser role from Firestore (source of truth, throws if insufficient privileges)
    await requireSuperuserRoleFromFirestore(req);

    const { newsletterId }: DeleteRequest = req.body;
    if (!newsletterId) {
      return res.status(400).json({ error: "newsletterId required" });
    }

    // Get all pending queue items
    const queueItemsQuery = db!
      .collection(`${getNewslettersCollectionName()}/${newsletterId}/queueItems`)
      .where("status", "==", "pending");

    const itemsSnapshot = await firestoreQueryGet(queueItemsQuery, "get pending queue items", "newsletter delete");

    if (itemsSnapshot.empty) {
      return res.status(200).json({ deleted: 0, message: "No pending items to delete" });
    }

    // Delete items in batches (Firestore batch limit is 500)
    const batchSize = 500;
    const items = itemsSnapshot.docs;
    let totalDeleted = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = db!.batch();
      const batchItems = items.slice(i, i + batchSize);

      batchItems.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalDeleted += batchItems.length;
    }

    // Update newsletter metadata to mark as completed if no items remain
    const remainingQuery = db!
      .collection(`${getNewslettersCollectionName()}/${newsletterId}/queueItems`)
      .where("status", "in", ["pending", "failed"]);

    const remainingSnapshot = await firestoreQueryGet(remainingQuery, "check remaining items", "newsletter delete");

    if (remainingSnapshot.empty) {
      await firestoreUpdate(db!.collection(getNewslettersCollectionName()).doc(newsletterId), {
        status: "completed",
        updatedAt: firebase.firestore.Timestamp.now(),
      });
    }

    return res.status(200).json({
      deleted: totalDeleted,
      message: `Successfully deleted ${totalDeleted} pending queue items`,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Error deleting newsletter queue:", error instanceof Error ? error.name : "Unknown error");
    
    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({
        error: "Forbidden: Superuser privileges required",
      });
    }
    
    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Failed to delete queue items");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withJwtAuth(handler);
