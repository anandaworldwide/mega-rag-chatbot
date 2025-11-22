// This file handles API requests for updating admin actions on answers.
// It allows administrators to mark answers as affirmed, ignored, or fixed after review.

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import firebase from "firebase-admin";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // 100 requests per 5 minutes
    name: "admin-action-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteConfig = loadSiteConfigSync();
  const loginRequired = !!siteConfig?.requireLogin;
  if (loginRequired) {
    try {
      // Verify superuser role from Firestore (source of truth)
      await requireSuperuserRoleFromFirestore(req);
    } catch (error: any) {
      if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
        return res.status(403).json({ error: "Forbidden: Superuser privileges required" });
      }
      throw error;
    }
  } else {
    const sudo = getSudoCookie(req, res);
    if (!sudo.sudoCookieValue) {
      return res.status(403).json({ message: `Forbidden: ${sudo.message}` });
    }
  }

  const { docId, action } = req.body;

  if (!docId) {
    return res.status(400).json({ error: "Missing document ID" });
  }

  // Check if db is available
  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const docRef = db.collection(getAnswersCollectionName()).doc(docId);
    if (action === undefined) {
      // If action is undefined, remove the adminAction and adminActionTimestamp fields
      await firestoreUpdate(
        docRef,
        {
          adminAction: firebase.firestore.FieldValue.delete(),
          adminActionTimestamp: firebase.firestore.FieldValue.delete(),
        },
        "admin action removal",
        `docId: ${docId}`
      );
    } else {
      // Otherwise, set the new action and timestamp
      await firestoreUpdate(
        docRef,
        {
          adminAction: action,
          adminActionTimestamp: new Date(),
        },
        "admin action update",
        `docId: ${docId}, action: ${action}`
      );
    }
    res.status(200).json({ message: "Admin action updated" });
  } catch (error) {
    // Use safe error message to prevent information leakage
    const safeMessage = getSafeErrorMessage(error, "Failed to update admin action");
    res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
