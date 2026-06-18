// This file handles API requests for fetching and deleting answers.
// It provides functionality to retrieve answers with pagination, sorting, and filtering options,
// as well as deleting individual answers with proper authentication.

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { getTotalDocuments, getAnswersByIds, searchAnswersByQuestion, mapAnswerDocToAnswer } from "@/utils/server/answersUtils";
import { Answer } from "@/types/answer";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet, firestoreDelete } from "@/utils/server/firestoreRetryUtils";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { requireAdminRole } from "@/utils/server/authz";
import { writeAuditLog } from "@/utils/server/auditLog";
import { isAnswersPageAllowed } from "@/utils/server/answersPageAuth";

// Retrieves answers based on specified criteria (page, limit)
// Returns an array of answers and the total number of pages, sorted by most recent
async function getAnswers(page: number, limit: number): Promise<{ answers: Answer[]; totalPages: number }> {
  // Check if db is available
  if (!db) {
    throw new Error("Database not available");
  }

  // Initialize the query with sorting by timestamp (most recent)
  let answersQuery = db.collection(getAnswersCollectionName()).orderBy("timestamp", "desc");

  // Calculate pagination details
  const totalDocs = await getTotalDocuments();
  const totalPages = Math.max(1, Math.ceil(totalDocs / limit)); // Ensure at least 1 page
  const offset = (page - 1) * limit;

  // Apply pagination to the query
  answersQuery = answersQuery.offset(offset).limit(limit);

  // Execute the query and process the results
  const answersSnapshot = await firestoreQueryGet(
    answersQuery,
    "answers list query",
    `offset: ${offset}, limit: ${limit}`
  );

  const answers = answersSnapshot.docs.map((doc: any) => mapAnswerDocToAnswer(doc));

  return { answers, totalPages };
}

// Deletes an answer by its ID
async function deleteAnswerById(id: string): Promise<void> {
  // Check if db is available
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    await firestoreDelete(db.collection(getAnswersCollectionName()).doc(id), "answer deletion", `answerId: ${id}`);
  } catch (error) {
    console.error("Error deleting answer: ", error);
    throw error;
  }
}

// Create a custom handler that applies different auth requirements based on the method
async function apiHandler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  // For GET requests, no authentication is required
  if (method === "GET") {
    return await handleGetRequest(req, res);
  }

  // For DELETE requests, authentication is required - will be handled by withJwtAuth
  if (method === "DELETE") {
    return await handleDeleteRequest(req, res);
  }

  // For unsupported methods
  res.setHeader("Allow", ["GET", "DELETE"]);
  return res.status(405).json({ error: "Method not allowed" });
}

// For GET requests, don't require authentication
const getHandler = withApiMiddleware(apiHandler, { skipAuth: true });

// For DELETE requests, require authentication
const deleteHandler = withApiMiddleware(withJwtAuth(apiHandler));

// Export the main handler that routes based on method
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  if (method === "GET") {
    return getHandler(req, res);
  }

  if (method === "DELETE") {
    return deleteHandler(req, res);
  }

  // For other methods, use the unauthenticated handler to return 405
  return getHandler(req, res);
}

// Main handler function for the API endpoint
async function handleGetRequest(req: NextApiRequest, res: NextApiResponse) {
  // Check authorization first
  const siteConfig = loadSiteConfigSync(process.env.SITE_ID || "default");
  const isAuthorized = await isAnswersPageAllowed(req, res, siteConfig);

  if (!isAuthorized) {
    return res.status(403).json({
      error: "Access denied. You don't have permission to access this resource.",
    });
  }

  // Apply rate limiting (stricter for keyword search)
  const searchQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const isSearchRequest = searchQuery.length > 0;

  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: isSearchRequest ? 20 : 100,
    name: isSearchRequest ? "answers-search-api" : "answers-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  try {
    const { answerIds } = req.query;

    if (answerIds) {
      // Handle fetching specific answers by IDs
      if (typeof answerIds !== "string") {
        return res.status(400).json({
          message: "answerIds parameter must be a comma-separated string.",
        });
      }
      const idsArray = answerIds.split(",");

      const answers = await getAnswersByIds(idsArray);

      if (answers.length === 0) {
        return res.status(404).json({ message: "Answer not found." });
      }

      res.status(200).json(answers);
    } else {
      // Handle fetching answers with pagination or keyword search
      const { page, limit, q, daysBack } = req.query;
      const pageNumber = parseInt(page as string) || 1;
      const limitNumber = parseInt(limit as string) || 10;
      const searchTerm = typeof q === "string" ? q.trim() : "";

      if (searchTerm) {
        if (searchTerm.length < 2) {
          return res.status(400).json({
            message: "Search query must be at least 2 characters.",
          });
        }

        const daysBackNumber = parseInt(daysBack as string) || 30;
        const searchResult = await searchAnswersByQuestion(searchTerm, daysBackNumber, pageNumber, limitNumber);

        return res.status(200).json(searchResult);
      }

      const { answers, totalPages } = await getAnswers(pageNumber, limitNumber);

      res.status(200).json({ answers, totalPages, currentPage: pageNumber });
    }
  } catch (error: unknown) {
    // Error handling for GET requests
    console.error("Error fetching answers: ", error);
    if (error instanceof Error) {
      if ("code" in error && error.code === 8) {
        res.status(429).json({
          message: "Error: Quota exceeded. Please try again later.",
        });
      } else if (error.message === "Database not available") {
        res.status(503).json({ message: "Database not available" });
      } else {
        // Handle Firestore index errors with proper user messaging and ops notifications
        const errorResponse = createIndexErrorResponse(error, {
          endpoint: "/api/answers",
          collection: getAnswersCollectionName(),
          fields: ["timestamp"],
          query: "Paginated answers with sorting",
        });

        res.status(500).json({
          message: "Error fetching answers",
          ...errorResponse,
        });
      }
    } else {
      res.status(500).json({ message: "An unknown error occurred" });
    }
  }
}

// Deletes an answer by its ID
async function handleDeleteRequest(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Handle deleting an answer
    const { answerId } = req.query;
    if (!answerId || typeof answerId !== "string") {
      return res.status(400).json({ message: "answerId parameter is required." });
    }

    // Authorization by site type
    const siteConfig = loadSiteConfigSync();
    const loginRequired = !!siteConfig?.requireLogin;
    if (loginRequired) {
      if (!requireAdminRole(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
    } else {
      const sudo = getSudoCookie(req, res);
      if (!sudo.sudoCookieValue) {
        return res.status(403).json({ message: `Forbidden: ${sudo.message}` });
      }
    }

    await deleteAnswerById(answerId);
    await writeAuditLog(req, "admin_delete_answer", answerId, { outcome: "success" });
    res.status(200).json({ message: "Answer deleted successfully." });
  } catch (error: unknown) {
    // Error handling for DELETE requests
    console.error("Handler: Error deleting answer: ", error);
    if (error instanceof Error) {
      if (error.message === "Database not available") {
        res.status(503).json({ message: "Database not available" });
      } else {
        res.status(500).json({
          message: "Error deleting answer",
          error: error.message,
        });
      }
    } else {
      res.status(500).json({
        message: "Error deleting answer",
        error: "An unknown error occurred",
      });
    }
  }
}
