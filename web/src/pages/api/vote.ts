// This file handles API requests for recording user votes on answers.
// It implements rate limiting to prevent abuse and uses JWT authentication for security.
// The endpoint accepts POST requests with document ID and vote value.
// If vote is -1, it can optionally include feedbackReason and feedbackComment.
// Vote values can be: 1 (upvote), 0 (neutral), or -1 (downvote).

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { FieldValue } from "firebase-admin/firestore";
import { setCorsHeaders, handleCorsOptions } from "@/utils/server/corsMiddleware";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

// Define valid feedback reasons
const validReasons = [
  "Incorrect Information",
  "Off-Topic Response",
  "Bad Links",
  "Vague or Unhelpful",
  "Technical Issue",
  "Poor Style or Tone",
  "Other",
];

// Define a regex pattern for valid Firestore document IDs
// Firestore auto IDs are typically 20 characters of letters and numbers
const validFirestoreIdPattern = /^[a-zA-Z0-9]{20}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Load site configuration
  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  // Set CORS headers for all requests
  setCorsHeaders(req, res, siteConfig);

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    handleCorsOptions(req, res, siteConfig);
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // 10 requests per 5 minutes
    name: "vote",
  });

  if (!isAllowed) {
    return; // Rate limiter already sent the response
  }

  const { docId, vote, reason, comment } = req.body;

  // --- Validation ---
  if (!docId || typeof docId !== "string") {
    return res.status(400).json({ error: "Missing or invalid document ID" });
  }

  // Validate the document ID format - but make this more flexible
  // Allow both Firestore auto IDs (20 chars) and other possible ID formats
  // Just log a warning if it's not the expected format
  if (!validFirestoreIdPattern.test(docId)) {
    console.warn(`Unusual document ID format: ${docId}`);
    // We'll continue processing but log this for debugging
  }

  if (vote !== 1 && vote !== 0 && vote !== -1) {
    return res.status(400).json({ error: "Invalid vote value" });
  }

  // Validate feedback fields only if vote is -1 and reason is provided
  if (vote === -1 && reason) {
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: "Invalid feedback reason" });
    }
    if (comment && typeof comment !== "string") {
      return res.status(400).json({ error: "Invalid comment format" });
    }
    if (comment && comment.length > 1000) {
      return res.status(400).json({ error: "Comment exceeds maximum length of 1000 characters" });
    }
  }
  // --- End Validation ---

  if (!db) {
    console.error("Database service unavailable");
    return res.status(503).json({ error: "Database service unavailable" });
  }

  try {
    const docRef = db.collection(getAnswersCollectionName()).doc(docId);

    // Use transaction to prevent race conditions when multiple vote changes arrive simultaneously
    await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
      // PHASE 1: ALL READS FIRST (Firestore transaction requirement)
      const docSnap = await tx.get(docRef);

      if (!docSnap.exists) {
        throw new Error("Document not found");
      }

      // PHASE 2: ALL WRITES AFTER ALL READS
      let updateData: { [key: string]: any } = { vote }; // Default update only includes vote

      // If it's a downvote and a reason was provided, add feedback fields
      if (vote === -1 && reason) {
        updateData = {
          ...updateData,
          feedbackReason: reason,
          feedbackComment: comment || "",
          feedbackTimestamp: new Date(),
        };
      } else if (vote === 1 || vote === 0) {
        // Clear feedback fields if vote is changed to upvote/neutral
        updateData = {
          ...updateData,
          feedbackReason: FieldValue.delete(),
          feedbackComment: FieldValue.delete(),
          feedbackTimestamp: FieldValue.delete(),
        };
      }

      tx.update(docRef, updateData);
    });

    res.status(200).json({ message: "Vote and feedback recorded successfully" });
  } catch (error) {
    console.error("Error recording vote/feedback:", error);
    res.status(500).json({ error: "Failed to record vote/feedback" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
