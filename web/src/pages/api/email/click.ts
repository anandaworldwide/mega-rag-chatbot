import { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { verifyClickRedirectSignature } from "@/utils/server/emailTokenUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import {
  getClickRedirectSafeHomeUrl,
  isAllowedClickRedirectHost,
  resolveClickRedirectTarget,
} from "@/utils/server/emailClickRedirectUtils";
import crypto from "crypto";

// Maximum lengths for query parameters to prevent memory exhaustion
const MAX_URL_LENGTH = 2048;
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const MAX_CAMPAIGN_LENGTH = 100;
const MAX_LINK_ID_LENGTH = 500;
const MAX_SIG_LENGTH = 64;

// TTL for email tracking documents
const EMAIL_TRACKING_TTL_DAYS = 180;

function redirectHome(res: NextApiResponse) {
  return res.redirect(302, getClickRedirectSafeHomeUrl());
}

/**
 * Email click tracking endpoint
 * Logs email clicks to Firestore and redirects to the target URL.
 * Requires an HMAC over the recipient and target URL (same secret as open tracking).
 *
 * Query parameters:
 * - url: Target URL (encoded)
 * - email: User email address (encoded)
 * - campaign: Campaign type ("onboarding", "newsletter", "reengagement", "specialDay", "nps")
 * - campaignId: Campaign identifier (e.g., day number for onboarding, newsletterId for newsletters)
 * - type: Link type ("question", "cta", "unsubscribe", "link", "score")
 * - id: Optional link identifier (e.g., question text, score value)
 * - sig: HMAC of email + target URL
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
    const { url, email, campaign, campaignId, type, id, sig } = req.query;

    // Validate required parameters with length limits
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'url' parameter" });
    }
    if (url.length > MAX_URL_LENGTH) {
      return res.status(400).json({ error: "URL exceeds maximum length" });
    }

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'email' parameter" });
    }
    if (email.length > MAX_EMAIL_LENGTH) {
      return res.status(400).json({ error: "Email exceeds maximum length" });
    }

    if (!campaign || typeof campaign !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'campaign' parameter" });
    }
    if (campaign.length > MAX_CAMPAIGN_LENGTH) {
      return res.status(400).json({ error: "Campaign exceeds maximum length" });
    }

    if (!campaignId || typeof campaignId !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'campaignId' parameter" });
    }
    if (campaignId.length > MAX_CAMPAIGN_LENGTH) {
      return res.status(400).json({ error: "Campaign ID exceeds maximum length" });
    }

    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'type' parameter" });
    }

    // Validate type is one of allowed values
    const validTypes = ["question", "cta", "unsubscribe", "link", "score"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: "Invalid 'type' parameter" });
    }

    if (!sig || typeof sig !== "string" || sig.length > MAX_SIG_LENGTH) {
      return redirectHome(res);
    }

    // Next.js already decodes query values once. Do not decode again.
    const targetFromQuery = url;
    const userEmail = email.toLowerCase();
    const campaignType = campaign as "onboarding" | "newsletter" | "reengagement" | "specialDay" | "nps";
    const linkType = type as "question" | "cta" | "unsubscribe" | "link" | "score";
    const linkId = id && typeof id === "string" ? id.substring(0, MAX_LINK_ID_LENGTH) : undefined;

    if (!verifyClickRedirectSignature(userEmail, targetFromQuery, sig)) {
      return redirectHome(res);
    }

    const targetUrl = resolveClickRedirectTarget(targetFromQuery, req);
    if (!targetUrl) {
      return redirectHome(res);
    }

    if (!targetUrl.startsWith("/")) {
      const hostname = new URL(targetUrl).hostname;
      const siteConfig = loadSiteConfigSync();
      if (!isAllowedClickRedirectHost(hostname, siteConfig)) {
        return redirectHome(res);
      }
    }

    // Log click to Firestore with TTL and anonymized IP
    if (db) {
      const usersCol = getUsersCollectionName();
      const userRef = db.collection(usersCol).doc(userEmail);

      // Create click event document in a subcollection
      const clicksRef = userRef.collection("email_clicks").doc();

      // Calculate expiration date for automatic cleanup
      const expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + EMAIL_TRACKING_TTL_DAYS);

      // Hash IP for privacy
      const ipRaw = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
      const ipStr = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
      const ipHash = ipStr ? crypto.createHash("sha256").update(ipStr).digest("hex").substring(0, 16) : null;

      // Use await to ensure logging completes before redirect
      // This prevents data loss when Vercel terminates the function
      try {
        await firestoreSet(
          clicksRef,
          {
            campaign: campaignType,
            campaignId: campaignId,
            type: linkType,
            linkId: linkId || null,
            targetUrl: targetUrl,
            timestamp: firebase.firestore.Timestamp.now(),
            // Anonymize IP by hashing (privacy protection)
            ipHash: ipHash,
            // TTL field for Firestore TTL policy
            expireAt: firebase.firestore.Timestamp.fromDate(expireAt),
          },
          {},
          `log email click for ${userEmail}`
        );
      } catch (error: any) {
        // Log error but don't fail the redirect
        console.error("Failed to log email click:", error);

        // Alert ops on failures (fire-and-forget with proper error handling)
        sendOpsAlert("Email Click Tracking Failure", `Failed to log email click for ${userEmail}: ${error.message}`, {
          context: { campaign: campaignType, campaignId, linkType },
        }).catch((alertError) => {
          console.error("Failed to send ops alert:", alertError);
        });
      }
    }

    // Redirect to target URL
    res.redirect(302, targetUrl);
  } catch (error: any) {
    console.error("Error in email click tracking:", error);
    return redirectHome(res);
  }
}
