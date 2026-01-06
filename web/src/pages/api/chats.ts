// Lists chats (question/answer pairs) for a given UUID in reverse chronological order
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { createNetworkErrorResponse } from "@/utils/server/networkErrorUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 60,
    name: "chats-api",
  });
  if (!allowed) return;
  const { uuid, limit, convId, startAfter, starred } = req.query;

  // UUID is required unless convId is provided (for legacy document support)
  if (!uuid || typeof uuid !== "string") {
    if (!convId || typeof convId !== "string") {
      return res.status(400).json({ error: "uuid query parameter is required when convId is not provided" });
    }
  }

  const limitNum = Math.min(Math.max(parseInt(String(limit || 10), 10) || 10, 1), 200);

  try {
    if (!db) return res.status(503).json({ error: "Database not available" });

    // Build query based on available parameters
    let query: FirebaseFirestore.Query | FirebaseFirestore.CollectionReference =
      db.collection(getAnswersCollectionName());

    // For legacy document support: if only convId is provided, query by convId only
    if (convId && typeof convId === "string") {
      query = query.where("convId", "==", convId);

      // Add UUID filter only if UUID is also provided
      if (uuid && typeof uuid === "string") {
        query = query.where("uuid", "==", uuid);
      }
    } else if (uuid && typeof uuid === "string") {
      // Standard case: query by UUID only
      query = query.where("uuid", "==", uuid);
    }

    // Add starred filter if requested
    if (starred === "true") {
      query = query.where("isStarred", "==", true);
    }

    query = query.orderBy("timestamp", "desc");

    // Add pagination cursor if provided
    if (startAfter && typeof startAfter === "string") {
      // Parse the timestamp from ISO string
      const startAfterDate = new Date(startAfter);
      query = query.startAfter(startAfterDate);
    }

    query = query.limit(limitNum);

    const contextString = convId
      ? `uuid: ${uuid || "none"}, convId: ${convId}, limit: ${limitNum}, startAfter: ${startAfter || "none"}, starred: ${starred || "false"}`
      : `uuid: ${uuid || "none"}, limit: ${limitNum}, startAfter: ${startAfter || "none"}, starred: ${starred || "false"}`;

    const snapshot = await firestoreQueryGet(query, "user chats list", contextString);

    const chats = snapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        id: doc.id,
        question: data.question,
        answer: data.answer,
        timestamp: data.timestamp,

        collection: data.collection,
        convId: data.convId || null, // Include convId in response
        title: data.title || null, // Include title in response
        sources: data.sources || null, // Include sources in response
        suggestions: data.suggestions || null, // Include suggestions in response
        isStarred: data.isStarred || false, // Include star state in response
      };
    });

    // Track user activity when loading conversations (especially saved conversations via convId)
    // MUST await to prevent Vercel from terminating before completion
    if (uuid && typeof uuid === "string") {
      try {
        // Await with 3s timeout to prevent Vercel from killing the operation
        await Promise.race([
          updateUserActivity(uuid, "chats-api"),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Silently handle errors - activity tracking is non-critical
      }
    }

    return res.status(200).json(chats);
  } catch (error: any) {
    // Check for network errors first
    if (error?.type === "network_error") {
      const networkErrorResponse = createNetworkErrorResponse(error, "loading conversations");
      return res.status(503).json(networkErrorResponse);
    }

    // Handle Firestore index errors with proper user messaging and ops notifications
    const fields = [];
    let queryDesc = "";

    if (convId && uuid) {
      fields.push("uuid", "convId", "timestamp");
      queryDesc = `uuid=${uuid}, convId=${convId}, orderBy timestamp desc`;
    } else if (convId) {
      fields.push("convId", "timestamp");
      queryDesc = `convId=${convId}, orderBy timestamp desc`;
    } else if (uuid) {
      fields.push("uuid", "timestamp");
      queryDesc = `uuid=${uuid}, orderBy timestamp desc`;
    }

    const errorResponse = createIndexErrorResponse(error, {
      endpoint: "/api/chats",
      collection: getAnswersCollectionName(),
      fields,
      query: queryDesc,
    });

    return res.status(500).json(errorResponse);
  }
}
