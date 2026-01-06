import { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyOpenToken } from "@/utils/server/emailTokenUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import crypto from "crypto";

// Maximum token length to prevent memory exhaustion attacks
const MAX_TOKEN_LENGTH = 1024;

// TTL for email tracking documents (90 days in seconds)
// Used when creating Firestore documents with expireAt field
const EMAIL_TRACKING_TTL_DAYS = 90;

/**
 * Email open tracking endpoint
 * Serves a 1x1 transparent pixel and logs email opens to Firestore
 * Uses signed tokens to prevent forgery
 *
 * Query parameters:
 * - token: Base64 encoded signed token containing email:campaign:campaignId:timestamp:signature
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Debug: Log entry point with unique request ID to correlate with any errors
  const requestId = `open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[EmailOpen] START ${requestId}`);

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

    // Input validation: limit token length to prevent memory exhaustion
    if (token.length > MAX_TOKEN_LENGTH) {
      console.warn("Email open tracking: token exceeds maximum length");
      return serveTrackingPixel(res);
    }

    // Verify and decode the signed token
    const payload = verifyOpenToken(token);

    if (!payload) {
      // Invalid token format, but still serve the pixel
      return serveTrackingPixel(res);
    }

    // Check if token signature is valid
    if (!payload.isValid) {
      console.warn(`Email open tracking: invalid token signature for ${payload.email}`);
      // Still serve pixel but don't log (potential forgery attempt)
      return serveTrackingPixel(res);
    }

    const userEmail = payload.email;

    // Log open to Firestore with proper error handling
    if (db) {
      const usersCol = getUsersCollectionName();
      const userRef = db.collection(usersCol).doc(userEmail);

      // Create open event document in a subcollection with TTL
      const opensRef = userRef.collection("email_opens").doc();

      // Calculate expiration date for automatic cleanup
      const expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + EMAIL_TRACKING_TTL_DAYS);

      try {
        await firestoreSet(
          opensRef,
          {
            campaign: payload.campaignType,
            campaignId: payload.campaignId,
            timestamp: firebase.firestore.Timestamp.now(),
            // Anonymize IP by hashing (privacy protection)
            ipHash: hashIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""),
            // TTL field for Firestore TTL policy (requires Firestore TTL to be configured)
            expireAt: firebase.firestore.Timestamp.fromDate(expireAt),
          },
          {},
          `log email open for ${userEmail}`
        );
      } catch (error: any) {
        // Log error but don't fail the pixel - tracking is best-effort
        console.error("Failed to log email open:", error);

        // Alert ops on repeated failures (fire-and-forget with proper error handling)
        sendOpsAlert("Email Open Tracking Failure", `Failed to log email open for ${userEmail}: ${error.message}`, {
          context: { campaign: payload.campaignType, campaignId: payload.campaignId },
        }).catch((alertError) => {
          console.error("Failed to send ops alert:", alertError);
        });
      }
    }

    console.log(`[EmailOpen] END ${requestId} - success`);
    return serveTrackingPixel(res);
  } catch (error: any) {
    console.error(`[EmailOpen] END ${requestId} - error:`, error);
    // Always serve the pixel even on error
    return serveTrackingPixel(res);
  }
}

/**
 * Hashes an IP address for privacy-preserving storage
 * Uses a prefix to allow for some geographic analysis while protecting full IP
 */
function hashIp(ip: string | string[] | undefined): string | null {
  if (!ip) return null;
  const ipStr = Array.isArray(ip) ? ip[0] : ip;
  if (!ipStr) return null;

  return crypto.createHash("sha256").update(ipStr).digest("hex").substring(0, 16);
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
