/**
 * API endpoint to clone a conversation from a shared link
 *
 * This endpoint:
 * 1. Gets UUID from JWT token (login-required sites) or cookies (non-login sites)
 * 2. Loads the source conversation by docId
 * 3. Creates new conversation entries for the user
 * 4. Returns the new convId for redirection
 */

import { NextApiRequest, NextApiResponse } from "next";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";
import { getTokenFromRequest } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
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
    const { docId } = req.body;

    if (!docId || typeof docId !== "string") {
      return res.status(400).json({ error: "Invalid document ID" });
    }

    if (!db) {
      return res.status(500).json({ error: "Database connection not available" });
    }

    const siteConfig = loadSiteConfigSync();

    // Get UUID and email based on site configuration
    let userUuid: string;
    let userEmail: string | null = null;

    if (siteConfig?.requireLogin) {
      // For login-required sites, get UUID and email from JWT token
      try {
        const tokenPayload = getTokenFromRequest(req);
        if (!tokenPayload.uuid) {
          return res.status(401).json({ error: "Authentication required. Please log in to continue." });
        }
        userUuid = tokenPayload.uuid;
        userEmail = tokenPayload.email || null;
      } catch (error) {
        return res.status(401).json({ error: "Authentication required. Please log in to continue." });
      }
    } else {
      // For non-login sites, get UUID from cookies
      const uuidResult = getSecureUUID(req, res);
      if (!uuidResult.success) {
        return res.status(uuidResult.statusCode).json({ error: uuidResult.error });
      }
      userUuid = uuidResult.uuid;
    }

    // TypeScript guard: db is not null at this point
    const database = db;

    const collectionName = getAnswersCollectionName();

    // Fetch the source document to get convId
    const sourceDocRef = database.collection(collectionName).doc(docId);
    const sourceDocSnapshot = await sourceDocRef.get();

    if (!sourceDocSnapshot.exists) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const sourceData = sourceDocSnapshot.data();
    if (!sourceData || !sourceData.convId) {
      return res.status(404).json({ error: "Invalid conversation data" });
    }

    // Fetch messages in the source conversation up to and including the shared docId
    const sourceConvId = sourceData.convId;
    const sourceTimestamp = sourceData.timestamp;

    // Build query to get messages up to the shared timestamp
    const conversationQuery = database
      .collection(collectionName)
      .where("convId", "==", sourceConvId)
      .where("timestamp", "<=", sourceTimestamp)
      .orderBy("timestamp", "asc");

    const conversationSnapshot = await conversationQuery.get();

    if (conversationSnapshot.empty) {
      return res.status(404).json({ error: "Conversation messages not found" });
    }

    // Generate new IDs for the cloned conversation
    const newConvId = randomUUID();

    // Clone all messages in the conversation
    const batch = database.batch();
    const clonedMessages: any[] = [];
    const baseTimestamp = new Date();

    conversationSnapshot.docs.forEach((doc, index) => {
      const data = doc.data();

      // Create new document reference for cloned message
      const newDocRef = database.collection(collectionName).doc();

      // Preserve ordering by incrementing timestamp for each message
      const messageTimestamp = new Date(baseTimestamp.getTime() + index * 1000);

      // Clone the message data with new IDs and ownership
      const clonedData: any = {
        ...data,
        convId: newConvId,
        uuid: userUuid,
        timestamp: messageTimestamp, // Increment timestamp to preserve order
        clonedFrom: doc.id, // Track the source document
        clonedAt: baseTimestamp,
      };

      // Only add email field for login-required sites
      if (userEmail) {
        clonedData.email = userEmail;
      }

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

    // Check if this is a Firestore index error and send ops alert if needed
    const indexErrorResponse = createIndexErrorResponse(error, {
      endpoint: "/api/clone-conversation",
      collection: getAnswersCollectionName(),
      fields: ["convId", "timestamp"],
      query: `where("convId", "==", ...).orderBy("timestamp", "asc")`,
    });

    if (indexErrorResponse.type === "firestore_index_error") {
      return res.status(503).json(indexErrorResponse);
    }

    return res.status(500).json({ error: "Failed to clone conversation" });
  }
}
