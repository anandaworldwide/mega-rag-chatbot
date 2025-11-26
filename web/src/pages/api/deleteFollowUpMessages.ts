import { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreGet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { requireAdminRole } from "@/utils/server/authz";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Authentication - require valid JWT token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization header required" });
    }

    const token = authHeader.substring(7);
    let userPayload: any;
    try {
      userPayload = verifyToken(token);
      if (!userPayload || token.includes("placeholder")) {
        throw new Error("Invalid token");
      }
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Get UUID securely based on site configuration
    const uuidResult = getSecureUUID(req, res, userPayload);
    if (!uuidResult.success) {
      return res.status(uuidResult.statusCode).json({ error: uuidResult.error });
    }
    const uuid = uuidResult.uuid;

    const { convId, startAfterDocId } = req.body;

    if (!convId || !startAfterDocId) {
      return res.status(400).json({ error: "convId and startAfterDocId are required" });
    }

    const collectionName = getAnswersCollectionName();

    // Get the reference document to determine the cutoff timestamp
    const startDocRef = db.collection(collectionName).doc(startAfterDocId);
    const startDoc = await firestoreGet(startDocRef, "get start document", `docId: ${startAfterDocId}`);

    if (!startDoc.exists) {
      return res.status(404).json({ error: "Start document not found" });
    }

    const startDocData = startDoc.data();
    const cutoffTimestamp = startDocData?.timestamp;

    if (!cutoffTimestamp) {
      return res.status(400).json({ error: "Start document has no timestamp" });
    }

    // Check if user is admin/superuser - if not, verify they own the conversation
    const isAdmin = requireAdminRole(req);
    if (!isAdmin) {
      // Verify the conversation belongs to this user
      const ownershipQuery = db
        .collection(collectionName)
        .where("convId", "==", convId)
        .where("uuid", "==", uuid)
        .limit(1);

      const ownershipDocs = await firestoreQueryGet(
        ownershipQuery,
        "verify conversation ownership",
        `convId: ${convId}`
      );

      if (ownershipDocs.empty) {
        return res.status(403).json({ error: "Conversation not found or access denied" });
      }
    }

    // Find all documents in this conversation that were created at or after the cutoff timestamp
    const followUpQuery = db
      .collection(collectionName)
      .where("convId", "==", convId)
      .where("timestamp", ">=", cutoffTimestamp)
      .orderBy("timestamp", "asc");

    const followUpDocs = await firestoreQueryGet(followUpQuery, "get follow-up messages", `convId: ${convId}`);

    if (followUpDocs.empty) {
      return res.status(200).json({ message: "No follow-up messages to delete", deletedCount: 0 });
    }

    // Delete all follow-up documents in batches
    const batchSize = 500; // Firestore batch limit
    const docs = followUpDocs.docs;
    let totalDeleted = 0;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const batchDocs = docs.slice(i, i + batchSize);

      batchDocs.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalDeleted += batchDocs.length;
    }

    console.log(`Deleted ${totalDeleted} follow-up messages from conversation ${convId} by ${userPayload.email}`);

    return res.status(200).json({
      message: "Follow-up messages deleted successfully",
      deletedCount: totalDeleted,
    });
  } catch (error) {
    console.error("Error deleting follow-up messages:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
