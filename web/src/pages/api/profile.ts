// API: Returns current user's profile info (email, uuid, role) based on auth JWT cookie
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { verifyToken } from "@/utils/server/jwtUtils";
import { writeAuditLog } from "@/utils/server/auditLog";
import { sendWelcomeEmail } from "@/utils/server/userInviteUtils";
import { getDefaultEmailPreferences } from "@/utils/server/emailPreferenceUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Rate limit
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 120,
    name: "profile",
  });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

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

    const usersCol = getUsersCollectionName();
    const ref = db.collection(usersCol).doc(email);
    if (req.method === "GET") {
      const doc = await firestoreGet(ref, "get profile user", email);
      if (!doc.exists) return res.status(404).json({ error: "User not found" });

      const data = doc.data() as any;
      const roleFromDb = typeof data?.role === "string" ? data.role : undefined;
      const roleFromToken = typeof payload?.role === "string" ? payload.role : undefined;
      const role = roleFromDb || roleFromToken || "user";
      return res.status(200).json({
        email,
        uuid: data?.uuid || null,
        role,
        firstName: typeof data?.firstName === "string" ? data.firstName : null,
        lastName: typeof data?.lastName === "string" ? data.lastName : null,
        pendingEmail: typeof data?.pendingEmail === "string" ? data.pendingEmail : null,
        emailChangeExpiresAt: data?.emailChangeExpiresAt || null,
        newsletterSubscribed: typeof data?.newsletterSubscribed === "boolean" ? data.newsletterSubscribed : true, // Default to true for existing users
        hasPassword: !!data?.passwordHash, // Boolean indicating if user has password set
        dismissedPasswordPromo: typeof data?.dismissedPasswordPromo === "boolean" ? data.dismissedPasswordPromo : false,
        verifiedAt: data?.verifiedAt?.toDate?.() ?? null, // When account was activated
      });
    }

    if (req.method === "PATCH") {
      const body = (req.body || {}) as {
        firstName?: string;
        lastName?: string;
        cancelEmailChange?: boolean;
        newsletterSubscribed?: boolean;
        dismissedPasswordPromo?: boolean;
      };
      const updates: Record<string, any> = {};

      if (body.firstName !== undefined) {
        if (typeof body.firstName !== "string" || body.firstName.length > 100) {
          return res.status(400).json({ error: "Invalid first name" });
        }
        updates.firstName = body.firstName.trim();
      }
      if (body.lastName !== undefined) {
        if (typeof body.lastName !== "string" || body.lastName.length > 100) {
          return res.status(400).json({ error: "Invalid last name" });
        }
        updates.lastName = body.lastName.trim();
      }
      if (body.cancelEmailChange === true) {
        updates.pendingEmail = firebase.firestore.FieldValue.delete();
        updates.emailChangeTokenHash = firebase.firestore.FieldValue.delete();
        updates.emailChangeExpiresAt = firebase.firestore.FieldValue.delete();
      }
      if (body.newsletterSubscribed !== undefined) {
        if (typeof body.newsletterSubscribed !== "boolean") {
          return res.status(400).json({ error: "Invalid newsletter subscription value" });
        }
        updates.newsletterSubscribed = body.newsletterSubscribed;
      }
      if (body.dismissedPasswordPromo !== undefined) {
        if (typeof body.dismissedPasswordPromo !== "boolean") {
          return res.status(400).json({ error: "Invalid dismissedPasswordPromo value" });
        }
        updates.dismissedPasswordPromo = body.dismissedPasswordPromo;
      }

      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updates provided" });

      // Check if this is the first profile completion after activation
      const userDoc = await firestoreGet(ref, "get user for profile update", email);
      let isCompletingActivation = false;
      if (userDoc.exists) {
        const userData = userDoc.data() as any;
        if (userData?.inviteStatus === "activated_pending_profile") {
          // Mark as fully accepted when they complete their profile
          updates.inviteStatus = "accepted";
          isCompletingActivation = true;

          // Initialize email preferences if not set (migrate from legacy newsletterSubscribed)
          if (!userData?.emailPreferences) {
            updates.emailPreferences = getDefaultEmailPreferences();
            // Also set newsletterSubscribed for backward compatibility
            if (userData?.newsletterSubscribed !== undefined) {
              updates.emailPreferences.newsletters = userData.newsletterSubscribed !== false;
            }
          }

          // Start onboarding sequence (cron will send first email)
          if (!userData?.onboardingStartedAt) {
            updates.onboardingStartedAt = firebase.firestore.Timestamp.now();
            updates.onboardingEmailsSent = [];
          }
        }
      }

      updates.updatedAt = firebase.firestore.Timestamp.now();
      await db.collection(usersCol).doc(email).set(updates, { merge: true });

      // Log activation completion for digest tracking and send welcome email
      if (isCompletingActivation) {
        await writeAuditLog(req, "user_activation_completed", email, {
          outcome: "activation_completed",
        });

        // Send welcome email after successful activation completion
        try {
          await sendWelcomeEmail(email, req);
        } catch (emailError) {
          // Log email error but don't fail the profile update
          console.error("Failed to send welcome email:", emailError);
        }
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e: any) {
    const safeMessage = getSafeErrorMessage(e, "Failed to load profile");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
