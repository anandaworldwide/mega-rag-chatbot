import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import firebase from "firebase-admin";

// Get environment name for collection naming

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 30,
    name: "conversation-operations",
  });
  if (!allowed) return;

  const { convId } = req.query;
  if (!convId || typeof convId !== "string") {
    return res.status(400).json({ error: "convId parameter is required" });
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

  if (req.method === "PATCH") {
    return handleRenameConversation(req, res, convId, uuid, userPayload);
  } else if (req.method === "DELETE") {
    return handleDeleteConversation(req, res, convId, uuid, userPayload);
  } else {
    res.setHeader("Allow", ["PATCH", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
}

async function handleRenameConversation(
  req: NextApiRequest,
  res: NextApiResponse,
  convId: string,
  uuid: string,
  userPayload: any
) {
  const { title } = req.body;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "Title is required and must be non-empty" });
  }

  if (title.trim().length > 100) {
    return res.status(400).json({ error: "Title must be 100 characters or less" });
  }

  try {
    if (!db) {
      return res.status(503).json({ error: "Database not available" });
    }

    const collectionName = getAnswersCollectionName();

    // Find all documents in this conversation that belong to this user
    const conversationQuery = db.collection(collectionName).where("convId", "==", convId).where("uuid", "==", uuid);

    const conversationDocs = await firestoreQueryGet(
      conversationQuery,
      "conversation rename query",
      `convId: ${convId}, uuid: ${uuid}`
    );

    if (conversationDocs.empty) {
      return res.status(404).json({ error: "Conversation not found or access denied" });
    }

    // Update the title on all documents in the conversation
    const batch = db.batch();
    const trimmedTitle = title.trim();

    conversationDocs.docs.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
      batch.update(doc.ref, {
        title: trimmedTitle,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();

    // Log the rename action
    console.log(`Conversation renamed: ${convId} -> "${trimmedTitle}" by ${userPayload.email}`);

    return res.status(200).json({
      message: "Conversation renamed successfully",
      title: trimmedTitle,
      updatedDocuments: conversationDocs.docs.length,
    });
  } catch (error) {
    console.error("Error renaming conversation:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleDeleteConversation(
  req: NextApiRequest,
  res: NextApiResponse,
  convId: string,
  uuid: string,
  userPayload: any
) {
  try {
    if (!db) {
      return res.status(503).json({ error: "Database not available" });
    }

    const collectionName = getAnswersCollectionName();

    // Find all documents in this conversation that belong to this user
    const conversationQuery = db.collection(collectionName).where("convId", "==", convId).where("uuid", "==", uuid);

    const conversationDocs = await firestoreQueryGet(
      conversationQuery,
      "conversation delete query",
      `convId: ${convId}, uuid: ${uuid}`
    );

    if (conversationDocs.empty) {
      return res.status(404).json({ error: "Conversation not found or access denied" });
    }

    // Get the document IDs that will be deleted
    const deletedDocIds = conversationDocs.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => doc.id);

    // Step 1: Clean up related questions references
    await cleanupRelatedQuestionsReferences(deletedDocIds, collectionName);

    // Step 2: Delete all documents in the conversation
    const batch = db.batch();

    conversationDocs.docs.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    // Log the delete action
    console.log(`Conversation deleted: ${convId} (${conversationDocs.docs.length} documents) by ${userPayload.email}`);

    return res.status(200).json({
      message: "Conversation deleted successfully",
      deletedDocuments: conversationDocs.docs.length,
    });
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Removes references to deleted document IDs from other documents' relatedQuestionsV2 arrays
 */
async function cleanupRelatedQuestionsReferences(deletedDocIds: string[], collectionName: string) {
  try {
    // Find all documents that have relatedQuestionsV2 field containing any of the deleted IDs
    // We'll need to query in batches since Firestore has limitations on array-contains-any
    const batchSize = 10; // Firestore limit for array-contains-any
    const cleanupPromises: Promise<void>[] = [];

    for (let i = 0; i < deletedDocIds.length; i += batchSize) {
      const batch = deletedDocIds.slice(i, i + batchSize);

      // Query for documents that reference any of these deleted IDs
      const query = db!.collection(collectionName).where("relatedQuestionsV2", "!=", null);

      const querySnapshot = await firestoreQueryGet(
        query,
        "related questions cleanup query",
        `deletedIds batch: ${batch.join(", ")}`
      );

      if (!querySnapshot.empty) {
        const updateBatch = db!.batch();
        let hasUpdates = false;

        querySnapshot.docs.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
          const data = doc.data();
          const relatedQuestions = data.relatedQuestionsV2 || [];

          // Filter out any references to deleted documents
          const filteredRelatedQuestions = relatedQuestions.filter(
            (rq: { id: string; title: string; similarity: number }) => !deletedDocIds.includes(rq.id)
          );

          // Only update if there were changes
          if (filteredRelatedQuestions.length !== relatedQuestions.length) {
            updateBatch.update(doc.ref, {
              relatedQuestionsV2: filteredRelatedQuestions,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            hasUpdates = true;
          }
        });

        if (hasUpdates) {
          cleanupPromises.push(updateBatch.commit().then(() => {}));
        }
      }
    }

    await Promise.all(cleanupPromises);
    console.log(`Cleaned up related questions references for ${deletedDocIds.length} deleted documents`);
  } catch (error) {
    console.error("Error cleaning up related questions references:", error);
    // Don't throw - we want the main deletion to proceed even if cleanup fails
  }
}
