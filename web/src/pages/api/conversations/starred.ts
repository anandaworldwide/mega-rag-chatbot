import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";

interface StarredConversation {
  convId: string;
  title: string;
  lastMessageAt: any;
  messageCount: number;
  isStarred: boolean; // Always true for starred conversations
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET method
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting - 60 requests per minute for fetching starred conversations
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute
    name: "starred-conversations-fetch",
  });
  if (!allowed) {
    return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
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

    // Parse pagination parameters
    const pageSize = Math.min(parseInt(req.query.limit as string) || 20, 100); // Max 100 per page
    const cursor = req.query.cursor as string;

    // Query for starred conversations with pagination
    let starredQuery = db
      .collection(collectionName)
      .where("uuid", "==", uuid)
      .where("isStarred", "==", true)
      .orderBy("timestamp", "desc")
      .limit(pageSize + 1); // +1 to check if there are more results

    // Apply cursor for pagination
    if (cursor) {
      try {
        const cursorTimestamp = new Date(cursor);
        starredQuery = starredQuery.startAfter(cursorTimestamp);
      } catch (error) {
        return res.status(400).json({ error: "Invalid cursor format" });
      }
    }

    const starredDocs = await firestoreQueryGet(starredQuery, "starred conversations query", `uuid: ${uuid}`);

    // Check if there are more results
    const hasMore = starredDocs.docs.length > pageSize;
    const docsToProcess = hasMore ? starredDocs.docs.slice(0, pageSize) : starredDocs.docs;

    // Determine next cursor from the last document
    let nextCursor = null;
    if (hasMore && docsToProcess.length > 0) {
      const lastDoc = docsToProcess[docsToProcess.length - 1];
      const lastDocData = lastDoc.data();
      if (lastDocData.timestamp) {
        nextCursor = lastDocData.timestamp.toDate().toISOString();
      }
    }

    // Group by conversation ID and aggregate data
    const conversationMap = new Map<
      string,
      {
        docs: any[];
        latestTimestamp: any;
      }
    >();

    docsToProcess.forEach((doc: any) => {
      const data = doc.data();
      const convId = data.convId;

      if (!conversationMap.has(convId)) {
        conversationMap.set(convId, {
          docs: [],
          latestTimestamp: data.timestamp,
        });
      }

      const conversationData = conversationMap.get(convId)!;
      conversationData.docs.push(doc);

      // Update latest timestamp if this document is newer
      if (
        data.timestamp &&
        (!conversationData.latestTimestamp || data.timestamp.seconds > conversationData.latestTimestamp.seconds)
      ) {
        conversationData.latestTimestamp = data.timestamp;
      }
    });

    // Convert to response format
    const starredConversations: StarredConversation[] = Array.from(conversationMap.entries())
      .map(([convId, data]) => {
        // Find the first document (chronologically) to get the title
        const firstDoc = data.docs.sort((a: any, b: any) => {
          const timeA = a.data().timestamp?.seconds || 0;
          const timeB = b.data().timestamp?.seconds || 0;
          return timeA - timeB;
        })[0];

        const firstDocData = firstDoc.data();
        let title = firstDocData.title;

        // Fallback title if not available
        if (!title) {
          const questionWords = firstDocData.question?.trim().split(/\s+/) || [];
          title = questionWords.length <= 5 ? firstDocData.question : questionWords.slice(0, 4).join(" ") + "...";
        }

        return {
          convId,
          title,
          lastMessageAt: data.latestTimestamp,
          messageCount: data.docs.length,
          isStarred: true, // Ensure UI knows these are starred
        } as StarredConversation;
      })
      .sort((a, b) => {
        // Sort by most recent message
        const timeA = a.lastMessageAt?.seconds || 0;
        const timeB = b.lastMessageAt?.seconds || 0;
        return timeB - timeA;
      });

    return res.status(200).json({
      conversations: starredConversations,
      totalCount: starredConversations.length,
      hasMore,
      nextCursor,
      pageSize,
    });
  } catch (error: any) {
    console.error("Error fetching starred conversations:", error);

    return res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
