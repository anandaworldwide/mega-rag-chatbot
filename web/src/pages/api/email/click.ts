import { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

/**
 * Email click tracking endpoint
 * Logs email clicks to Firestore and redirects to the target URL
 *
 * Query parameters:
 * - url: Target URL (encoded)
 * - email: User email address (encoded)
 * - campaign: Campaign type ("onboarding", "newsletter", "reengagement", "specialDay")
 * - campaignId: Campaign identifier (e.g., day number for onboarding, newsletterId for newsletters)
 * - type: Link type ("question", "cta", "unsubscribe", "link")
 * - id: Optional link identifier (e.g., question text)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting to prevent abuse
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute per IP
    name: "email-click-tracking",
  });
  if (!allowed) return;

  try {
    const { url, email, campaign, campaignId, type, id } = req.query;

    // Validate required parameters
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'url' parameter" });
    }
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'email' parameter" });
    }
    if (!campaign || typeof campaign !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'campaign' parameter" });
    }
    if (!campaignId || typeof campaignId !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'campaignId' parameter" });
    }
    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'type' parameter" });
    }

    // Decode URL and email
    const targetUrl = decodeURIComponent(url);
    const userEmail = decodeURIComponent(email).toLowerCase();
    const campaignType = campaign as "onboarding" | "newsletter" | "reengagement" | "specialDay";
    const linkType = type as "question" | "cta" | "unsubscribe" | "link";
    const linkId = id ? decodeURIComponent(id as string) : undefined;

    // Validate URL is safe (must be same origin or allowed external domain)
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    try {
      const urlObj = new URL(targetUrl);
      const baseUrlObj = new URL(baseUrl);

      // Allow same origin or specific external domains
      const isSameOrigin = urlObj.origin === baseUrlObj.origin;
      if (!isSameOrigin) {
        // For now, only allow same-origin redirects for security
        // Can be extended to allow specific external domains if needed
        return res.status(400).json({ error: "Invalid redirect URL" });
      }
    } catch (_urlError) {
      // Relative URLs are fine
      if (!targetUrl.startsWith("/")) {
        return res.status(400).json({ error: "Invalid redirect URL format" });
      }
    }

    // Log click to Firestore (async, don't wait)
    if (db) {
      const usersCol = getUsersCollectionName();
      const userRef = db.collection(usersCol).doc(userEmail);

      // Create click event document in a subcollection
      const clicksRef = userRef.collection("email_clicks").doc();

      firestoreSet(
        clicksRef,
        {
          campaign: campaignType,
          campaignId: campaignId,
          type: linkType,
          linkId: linkId || null,
          targetUrl: targetUrl,
          timestamp: firebase.firestore.Timestamp.now(),
          userAgent: req.headers["user-agent"] || null,
          ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
        },
        {},
        `log email click for ${userEmail}`
      ).catch((error) => {
        // Log error but don't fail the redirect
        console.error("Failed to log email click:", error);
      });
    }

    // Redirect to target URL
    res.redirect(302, targetUrl);
  } catch (error: any) {
    console.error("Error in email click tracking:", error);
    // Still try to redirect if we have a URL
    const { url } = req.query;
    if (url && typeof url === "string") {
      try {
        const targetUrl = decodeURIComponent(url);
        res.redirect(302, targetUrl);
      } catch {
        return res.status(500).json({ error: "Internal server error" });
      }
    } else {
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
