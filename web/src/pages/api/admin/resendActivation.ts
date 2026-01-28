// API: Admin resends activation for a pending user. Extends expiry and emails a fresh activation link.
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth, getTokenFromRequest } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";
import { sanitizeEmail } from "@/utils/server/inputSanitization";
import {
  generateInviteToken,
  hashInviteToken,
  getInviteExpiryDate,
  sendActivationEmail,
} from "@/utils/server/userInviteUtils";
import { writeAuditLog } from "@/utils/server/auditLog";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 60,
    name: "admin-resend-activation",
  });
  if (!allowed) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) return res.status(503).json({ error: "Database not available" });

  // Authorization: admin or superuser only (verified from Firestore source of truth)
  try {
    await requireAdminRoleFromFirestore(req);
  } catch (error: any) {
    if (error.message?.includes("Unauthorized") || error.message?.includes("Admin")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    throw error;
  }

  const { email, customMessage } = req.body as { email?: string; customMessage?: string };
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Invalid email" });
  }

  // Sanitize and validate email with comprehensive security checks
  let sanitizedEmail: string;
  try {
    sanitizedEmail = sanitizeEmail(email, 254);
  } catch (error: any) {
    return res.status(400).json({ error: `Invalid email: ${error.message || "Email validation failed"}` });
  }

  // Validate customMessage if provided
  const validCustomMessage =
    typeof customMessage === "string" && customMessage.trim() ? customMessage.trim() : undefined;

  const usersCol = getUsersCollectionName();
  const userDocRef = db.collection(usersCol).doc(sanitizedEmail.toLowerCase());

  try {
    // Identify inviter admin from JWT and fetch name from users collection (if available)
    let inviterEmail: string | undefined;
    let inviterName: string | undefined;
    try {
      const token = getTokenFromRequest(req);
      inviterEmail = token.email?.toLowerCase();
      if (inviterEmail && db) {
        const inviterSnap = await firestoreGet(
          db.collection(usersCol).doc(inviterEmail),
          "get inviter user",
          inviterEmail
        );
        const inviterData = inviterSnap.exists ? (inviterSnap.data() as any) : undefined;
        const first = (inviterData?.firstName || "").toString().trim();
        const last = (inviterData?.lastName || "").toString().trim();
        const full = `${first} ${last}`.trim();
        inviterName = full || undefined;
      }
    } catch {
      // Ignore inviter lookup errors - non-critical
    }

    const existing = await firestoreGet(userDocRef, "get user", sanitizedEmail);
    if (!existing.exists) return res.status(404).json({ error: "User not found" });
    const data = existing.data() as any;
    if (data?.inviteStatus !== "pending") return res.status(400).json({ error: "Not pending" });

    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));
    await firestoreSet(
      userDocRef,
      {
        inviteTokenHash: tokenHash,
        inviteExpiresAt,
        updatedAt: firebase.firestore.Timestamp.now(),
        invitedByEmail: inviterEmail || data?.invitedByEmail,
        invitedByName: inviterName || data?.invitedByName,
      },
      { merge: true },
      "resend activation"
    );
    await sendActivationEmail(sanitizedEmail, token, req, validCustomMessage);
    await writeAuditLog(req, "admin_resend_activation", sanitizedEmail.toLowerCase(), { outcome: "success" });
    return res.status(200).json({ message: "resent" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
