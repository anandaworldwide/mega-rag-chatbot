// API: Shared-password verification for self-provisioning unknown emails (grace transition).
// Creates a pending user with basic entitlements and sends activation email (14 days) on success.
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { writeAuditLog } from "@/utils/server/auditLog";
import {
  generateInviteToken,
  hashInviteToken,
  getInviteExpiryDate,
  sendActivationEmail,
} from "@/utils/server/userInviteUtils";
import { isEmailDomainWhitelisted } from "@/utils/server/domainWhitelistUtils";
import { getDefaultEmailPreferences } from "@/utils/server/emailPreferenceUtils";
import { sanitizeEmail } from "@/utils/server/inputSanitization";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // 5 attempts/hour/IP soft lock
  const allowed = await genericRateLimiter(req, res, { windowMs: 60 * 60 * 1000, max: 5, name: "verify-access" });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") return res.status(400).json({ error: "Invalid email" });

  // Sanitize and validate email with comprehensive security checks
  let sanitizedEmailAddr: string;
  try {
    sanitizedEmailAddr = sanitizeEmail(email, 254);
  } catch (error: any) {
    return res.status(400).json({ error: `Invalid email: ${error.message || "Email validation failed"}` });
  }

  const siteId = process.env.SITE_ID;
  if (!siteId) {
    return res.status(500).json({ error: "SITE_ID environment variable is not configured" });
  }
  const isWhitelisted = await isEmailDomainWhitelisted(sanitizedEmailAddr, siteId);

  if (!isWhitelisted) {
    await writeAuditLog(req, "self_provision_attempt", sanitizedEmailAddr.toLowerCase(), {
      outcome: "non_whitelisted_request",
    });
    return res.status(200).json({ message: "requires_admin_approval" });
  }

  const usersCol = getUsersCollectionName();
  const userDocRef = db.collection(usersCol).doc(sanitizedEmailAddr.toLowerCase());

  try {
    const existing = await firestoreGet(userDocRef, "verify access", sanitizedEmailAddr);
    const now = firebase.firestore.Timestamp.now();

    if (existing.exists) {
      const data = existing.data() as any;
      if (data?.inviteStatus === "accepted") return res.status(200).json({ message: "already active" });
      // pending → resend activation
      const token = generateInviteToken();
      const tokenHash = await hashInviteToken(token);
      const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));
      await firestoreSet(
        userDocRef,
        { inviteTokenHash: tokenHash, inviteExpiresAt, updatedAt: now },
        { merge: true },
        "resend activation on verify access"
      );
      await sendActivationEmail(sanitizedEmailAddr, token, req);
      await writeAuditLog(req, "self_provision_attempt", sanitizedEmailAddr.toLowerCase(), {
        outcome: "resent_pending_activation_whitelisted",
      });
      return res.status(200).json({ message: "activation-resent" });
    }

    // Create pending user with basic entitlements
    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));
    await firestoreSet(
      userDocRef,
      {
        email: sanitizedEmailAddr.toLowerCase(),
        role: "user",
        entitlements: { basic: true },
        inviteStatus: "pending",
        inviteTokenHash: tokenHash,
        inviteExpiresAt,
        newsletterSubscribed: true, // Legacy field for backward compatibility
        emailPreferences: getDefaultEmailPreferences(), // New multi-category preferences
        createdAt: now,
        updatedAt: now,
      },
      undefined,
      "create user via verify access"
    );
    await sendActivationEmail(sanitizedEmailAddr, token, req);
    await writeAuditLog(req, "self_provision_attempt", sanitizedEmailAddr.toLowerCase(), {
      outcome: "created_pending_user_whitelisted",
    });
    return res.status(200).json({ message: "created" });
  } catch (err) {
    const safeMessage = getSafeErrorMessage(err, "An error occurred");
    try {
      await writeAuditLog(req, "self_provision_attempt", sanitizedEmailAddr.toLowerCase(), {
        outcome: "server_error",
        error: safeMessage,
      });
    } catch {
      // Ignore audit log errors - already returning error response
    }
    return res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
