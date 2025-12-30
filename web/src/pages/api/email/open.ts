import { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

/**
 * Email open tracking endpoint
 * Serves a 1x1 transparent pixel and logs email opens to Firestore
 *
 * Query parameters:
 * - token: Base64 encoded token containing email:campaign:campaignId:timestamp
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting to prevent abuse
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute per IP (emails typically load once)
    name: "email-open-tracking",
  });
  if (!allowed) return;

  try {
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      // Still serve the pixel even if token is missing (some email clients strip params)
      return serveTrackingPixel(res);
    }

    // Decode token to extract email, campaign type, and campaign ID
    try {
      const decoded = Buffer.from(token, "base64").toString("utf-8");
      const [email, campaignType, campaignId] = decoded.split(":");

      if (!email || !campaignType || !campaignId) {
        return serveTrackingPixel(res);
      }

      const userEmail = email.toLowerCase();

      // Log open to Firestore - await to ensure completion before serverless function terminates
      // Without await, Vercel may kill the function after sending the response, causing timeouts
      if (db) {
        const usersCol = getUsersCollectionName();
        const userRef = db.collection(usersCol).doc(userEmail);

        // Create open event document in a subcollection
        const opensRef = userRef.collection("email_opens").doc();

        try {
          await firestoreSet(
            opensRef,
            {
              campaign: campaignType,
              campaignId: campaignId,
              timestamp: firebase.firestore.Timestamp.now(),
              userAgent: req.headers["user-agent"] || null,
              ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
            },
            {},
            `log email open for ${userEmail}`
          );
        } catch (error) {
          // Log error but don't fail the pixel - tracking is best-effort
          console.error("Failed to log email open:", error);
        }
      }

      return serveTrackingPixel(res);
    } catch (_decodeError) {
      // Invalid token, but still serve the pixel
      return serveTrackingPixel(res);
    }
  } catch (error: any) {
    console.error("Error in email open tracking:", error);
    // Always serve the pixel even on error
    return serveTrackingPixel(res);
  }
}

/**
 * Serves a 1x1 transparent PNG pixel
 */
function serveTrackingPixel(res: NextApiResponse) {
  // 1x1 transparent PNG
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", pixel.length.toString());
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).send(pixel);
}
