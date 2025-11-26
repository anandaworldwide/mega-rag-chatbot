import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import firebase from "firebase-admin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST method
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting - 30 requests per minute for star operations
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "star-operations",
  });
  if (!allowed) {
    return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
  }

  const { convId, action } = req.body;

  // Validate input
  if (!convId || typeof convId !== "string") {
    return res.status(400).json({ error: "convId is required and must be a string" });
  }

  if (!action || !["star", "unstar"].includes(action)) {
    return res.status(400).json({ error: "action must be either 'star' or 'unstar'" });
  }

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

  try {
    if (!db) {
      return res.status(503).json({ error: "Database not available" });
    }

    const collectionName = getAnswersCollectionName();

    // Find all documents in this conversation that belong to this user
    const conversationQuery = db.collection(collectionName).where("convId", "==", convId).where("uuid", "==", uuid);

    const conversationDocs = await firestoreQueryGet(
      conversationQuery,
      "conversation star query",
      `convId: ${convId}, uuid: ${uuid}`
    );

    if (conversationDocs.empty) {
      return res.status(404).json({ error: "Conversation not found or access denied" });
    }

    // Determine the new star state
    const newStarState = action === "star";

    // Use transaction to prevent race conditions when multiple star/unstar operations happen simultaneously
    // Note: Batch writes are atomic but not transactional - transactions provide better consistency
    const batchSize = conversationDocs.docs.length;

    await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
      // PHASE 1: ALL READS FIRST (Firestore transaction requirement)
      // Re-read all documents in transaction to ensure consistency
      const docRefs = conversationDocs.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => doc.ref);
      const docSnaps = await Promise.all(docRefs.map((ref: firebase.firestore.DocumentReference) => tx.get(ref)));

      // Verify all documents still exist
      for (const snap of docSnaps) {
        if (!snap.exists) {
          throw new Error("Conversation document not found");
        }
      }

      // PHASE 2: ALL WRITES AFTER ALL READS
      docRefs.forEach((ref: firebase.firestore.DocumentReference) => {
        tx.update(ref, {
          isStarred: newStarState,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
    });

    // Log the operation
    console.log(`Conversation ${action}red: ${convId} (${batchSize} documents) by ${userPayload.email}`);

    return res.status(200).json({
      success: true,
      message: `Conversation ${action}red successfully`,
      convId,
      action,
      documentsUpdated: batchSize,
    });
  } catch (error: any) {
    console.error("Error in star operation:", error);

    // Handle specific Firestore errors
    if (error.code === 9) {
      return res.status(400).json({ error: "Invalid conversation ID format" });
    }

    return res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
