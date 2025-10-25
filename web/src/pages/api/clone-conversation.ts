/**
 * API endpoint to clone a conversation from a shared link
 * 
 * This endpoint:
 * 1. Verifies the user is authenticated (has valid JWT with email)
 * 2. Loads the source conversation by docId
 * 3. Creates new conversation entries for the authenticated user
 * 4. Returns the new convId for redirection
 */

import { NextApiRequest, NextApiResponse } from "next";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";
import { getTokenFromRequest } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { randomUUID } from "crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 10,
    name: "clone-conversation",
    message: "Too many clone requests. Please wait a moment and try again.",
  });
  if (!allowed) return;

  try {
    // Verify authentication - user must be logged in
    const tokenPayload = getTokenFromRequest(req);
    
    if (!tokenPayload.email || !tokenPayload.uuid) {
      return res.status(401).json({ error: "Authentication required. Please log in to continue." });
    }

    const { docId } = req.body;

    if (!docId || typeof docId !== "string") {
      return res.status(400).json({ error: "Invalid document ID" });
    }

    if (!db) {
      return res.status(500).json({ error: "Database connection not available" });
    }

    const collectionName = getAnswersCollectionName();

    // Fetch the source document to get convId
    const sourceDocRef = db.collection(collectionName).doc(docId);
    const sourceDocSnapshot = await sourceDocRef.get();

    if (!sourceDocSnapshot.exists) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const sourceData = sourceDocSnapshot.data();
    if (!sourceData || !sourceData.convId) {
      return res.status(404).json({ error: "Invalid conversation data" });
    }

    // Fetch all messages in the source conversation
    const sourceConvId = sourceData.convId;
    const conversationQuery = db
      .collection(collectionName)
      .where("convId", "==", sourceConvId)
      .orderBy("timestamp", "asc");

    const conversationSnapshot = await conversationQuery.get();

    if (conversationSnapshot.empty) {
      return res.status(404).json({ error: "Conversation messages not found" });
    }

    // Generate new IDs for the cloned conversation
    const newConvId = randomUUID();
    const userUuid = tokenPayload.uuid;
    const userEmail = tokenPayload.email;

    // Clone all messages in the conversation
    const batch = db.batch();
    const clonedMessages: any[] = [];

    conversationSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      
      // Create new document reference for cloned message
      const newDocRef = db.collection(collectionName).doc();
      
      // Clone the message data with new IDs and ownership
      const clonedData = {
        ...data,
        convId: newConvId,
        uuid: userUuid,
        email: userEmail,
        timestamp: new Date(), // Use current timestamp for cloned messages
        clonedFrom: doc.id, // Track the source document
        clonedAt: new Date(),
      };

      batch.set(newDocRef, clonedData);
      clonedMessages.push({ id: newDocRef.id, ...clonedData });
    });

    // Commit all cloned messages
    await batch.commit();

    return res.status(200).json({
      success: true,
      convId: newConvId,
      messageCount: clonedMessages.length,
    });
  } catch (error: any) {
    console.error("Error cloning conversation:", error);
    
    // Handle authentication errors specifically
    if (error.message === "No token provided" || error.message === "Invalid or expired token") {
      return res.status(401).json({ error: "Authentication required. Please log in to continue." });
    }

    return res.status(500).json({ error: "Failed to clone conversation" });
  }
}
