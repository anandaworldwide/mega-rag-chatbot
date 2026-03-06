/**
 * User What's New API
 *
 * Handles getting and updating the user's last seen What's New version for bell notification.
 *
 * GET: Returns the user's current lastSeenWhatsNewVersion
 * PATCH: Updates the user's lastSeenWhatsNewVersion
 */

import { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { firestoreGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { getTokenFromRequest } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { createNetworkErrorResponse } from "@/utils/server/networkErrorUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // JWT token is already verified by withApiMiddleware
  // Extract email from the verified token
  let email: string;
  try {
    const payload = getTokenFromRequest(req);
    email = typeof payload?.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) {
      return res.status(400).json({ message: "Malformed session" });
    }
  } catch (_error) {
    return res.status(401).json({ message: "Authentication required" });
  }

  if (!db) {
    return res.status(503).json({ message: "Database not available" });
  }

  try {
    const usersCol = getUsersCollectionName();
    const userDocRef = db.collection(usersCol).doc(email);

    if (req.method === "GET") {
      // Get user's last seen What's New version
      const userDoc = await firestoreGet(userDocRef, "get user whats new version", email);

      const lastSeenWhatsNewVersion = userDoc.exists
        ? userDoc.data()?.lastSeenWhatsNewVersion || 0
        : 0;

      return res.status(200).json({
        lastSeenWhatsNewVersion,
      });
    } else if (req.method === "PATCH") {
      // Update user's last seen What's New version
      const { lastSeenWhatsNewVersion } = req.body;

      if (typeof lastSeenWhatsNewVersion !== "number" || lastSeenWhatsNewVersion < 0) {
        return res.status(400).json({
          message: "Invalid lastSeenWhatsNewVersion - must be a non-negative number",
        });
      }

      await firestoreUpdate(
        userDocRef,
        {
          lastSeenWhatsNewVersion,
          updatedAt: new Date(),
        },
        "update user whats new version",
        email
      );

      return res.status(200).json({
        success: true,
        lastSeenWhatsNewVersion,
      });
    } else {
      return res.status(405).json({ message: "Method not allowed" });
    }
  } catch (error: any) {
    console.error("User What's New API error:", error);

    // Check for network errors
    if (error?.type === "network_error") {
      const networkErrorResponse = createNetworkErrorResponse(error, "loading user what's new");
      return res.status(503).json(networkErrorResponse);
    }

    return res.status(500).json({ message: "Internal server error" });
  }
}

export default withApiMiddleware(handler);
