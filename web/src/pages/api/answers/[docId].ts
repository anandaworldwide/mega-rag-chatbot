/**
 * API endpoint to update an existing answer document
 * Used when user prefers GPT-4.1 regenerated answer over original
 */

import { NextApiRequest, NextApiResponse } from "next";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import firebase from "firebase-admin";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { docId } = req.query;

  if (!docId || typeof docId !== "string") {
    return res.status(400).json({ message: "Invalid document ID" });
  }

  const { response, modelUsed } = req.body;

  if (!response || typeof response !== "string") {
    return res.status(400).json({ message: "Invalid response data" });
  }

  if (!db) {
    return res.status(503).json({ message: "Database connection not available" });
  }

  try {
    const collectionName = getAnswersCollectionName();
    const docRef = db.collection(collectionName).doc(docId);

    // Use transaction to prevent race conditions when multiple regenerations happen simultaneously
    await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
      // PHASE 1: ALL READS FIRST (Firestore transaction requirement)
      const docSnapshot = await tx.get(docRef);

      if (!docSnapshot.exists) {
        throw new Error("Document not found");
      }

      // PHASE 2: ALL WRITES AFTER ALL READS
      tx.update(docRef, {
        answer: response,
        modelUsed: modelUsed || "gpt-4.1",
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedVia: "inline_comparison",
      });
    });

    return res.status(200).json({
      success: true,
      message: "Answer updated successfully",
    });
  } catch (error) {
    console.error("Error updating answer:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
