import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { verifyToken } from "@/utils/server/jwtUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import {
  isSalesforceAccessVerificationDue,
  syncUserAccessLevelFromSalesforce,
} from "@/utils/server/salesforceAccessSync";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 20,
    name: "salesforce_verify_access",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const authCookie = req.cookies?.["auth"];
    if (!authCookie) return res.status(401).json({ error: "Not authenticated" });

    let payload: any;
    try {
      payload = verifyToken(authCookie);
    } catch {
      return res.status(401).json({ error: "Invalid session" });
    }

    const email = typeof payload?.email === "string" ? payload.email.toLowerCase() : null;
    if (!email) return res.status(400).json({ error: "Malformed session" });

    const siteConfig = loadSiteConfigSync();
    if (!siteConfig?.accessControl?.enabled) {
      return res.status(200).json({ success: true, skipped: "access_control_disabled" });
    }

    const userRef = db.collection(getUsersCollectionName()).doc(email);
    const userDoc = await firestoreGet(userRef, "get user for Salesforce access verification", email);
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data() || {};
    const userWithRole = {
      ...userData,
      role: typeof userData.role === "string" ? userData.role : payload.role,
    };
    const salesforceAccessVerificationDue = isSalesforceAccessVerificationDue(userWithRole);
    if (userWithRole.inviteStatus !== "accepted") {
      return res.status(200).json({ success: true, skipped: "not_accepted" });
    }

    if (!salesforceAccessVerificationDue) {
      return res.status(200).json({ success: true, skipped: "fresh" });
    }

    const result = await syncUserAccessLevelFromSalesforce(email, siteConfig);
    if (result.error) {
      return res.status(502).json({ error: result.error, result });
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: getSafeErrorMessage(error, "Failed to verify Salesforce access") });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
