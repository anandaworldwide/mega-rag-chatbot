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
import { getDefaultEmailPreferences, migrateEmailPreferences } from "@/utils/server/emailPreferenceUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import type { EmailCategory } from "@/types/user";

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

      // Migrate email preferences if needed
      const migratedUser = migrateEmailPreferences(data);
      const emailPreferences = migratedUser.emailPreferences || getDefaultEmailPreferences();

      // Load site config to determine enabled email types
      const siteConfig = await loadSiteConfig();
      const enabledEmailTypes: EmailCategory[] = [];

      // Newsletters are always available for login-required sites
      if (siteConfig?.requireLogin) {
        enabledEmailTypes.push("newsletters");

        if (siteConfig?.enableOnboardingEmails) {
          enabledEmailTypes.push("onboarding");
        }
        if (siteConfig?.enableReengagementEmails) {
          enabledEmailTypes.push("reengagement");
        }
        if (siteConfig?.enableSpecialDayEmails) {
          enabledEmailTypes.push("specialDay");
        }
        if (siteConfig?.enableNpsSurveyEmail) {
          enabledEmailTypes.push("nps");
        }
      }

      return res.status(200).json({
        email,
        uuid: data?.uuid || null,
        role,
        firstName: typeof data?.firstName === "string" ? data.firstName : null,
        lastName: typeof data?.lastName === "string" ? data.lastName : null,
        pendingEmail: typeof data?.pendingEmail === "string" ? data.pendingEmail : null,
        emailChangeExpiresAt: data?.emailChangeExpiresAt || null,
        newsletterSubscribed: typeof data?.newsletterSubscribed === "boolean" ? data.newsletterSubscribed : true, // Legacy field for backward compatibility
        emailPreferences,
        enabledEmailTypes,
        hasPassword: !!data?.passwordHash, // Boolean indicating if user has password set
        dismissedPasswordPromo: typeof data?.dismissedPasswordPromo === "boolean" ? data.dismissedPasswordPromo : false,
        verifiedAt: data?.verifiedAt?.toDate?.() ?? null, // When account was activated
        preferredModel: typeof data?.preferredModel === "string" ? data.preferredModel : null,
      });
    }

    if (req.method === "PATCH") {
      const body = (req.body || {}) as {
        firstName?: string;
        lastName?: string;
        cancelEmailChange?: boolean;
        newsletterSubscribed?: boolean;
        emailPreferences?: {
          newsletters?: boolean;
          onboarding?: boolean;
          reengagement?: boolean;
          specialDay?: boolean;
          nps?: boolean;
        };
        dismissedPasswordPromo?: boolean;
        preferredModel?: string;
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

      // Fetch user doc once if we need it for email preferences or activation check
      // Always fetch for activation check
      const userDoc = await firestoreGet(ref, "get user for profile update", email);
      const userData = userDoc.exists ? (userDoc.data() as any) : null;

      // Handle emailPreferences (new multi-category preferences)
      if (body.emailPreferences !== undefined) {
        if (typeof body.emailPreferences !== "object" || body.emailPreferences === null) {
          return res.status(400).json({ error: "Invalid emailPreferences value" });
        }

        // Validate each category is boolean if provided
        const validCategories: Array<keyof typeof body.emailPreferences> = [
          "newsletters",
          "onboarding",
          "reengagement",
          "specialDay",
          "nps",
        ];
        for (const category of validCategories) {
          if (body.emailPreferences[category] !== undefined && typeof body.emailPreferences[category] !== "boolean") {
            return res.status(400).json({ error: `Invalid emailPreferences.${category} value` });
          }
        }

        // Get current preferences to merge
        const currentPreferences = userData?.emailPreferences || {};

        // Merge new preferences with existing ones
        const updatedPreferences = {
          ...currentPreferences,
          ...body.emailPreferences,
        };

        updates.emailPreferences = updatedPreferences;

        // Also update legacy newsletterSubscribed for backward compatibility
        if (body.emailPreferences.newsletters !== undefined) {
          updates.newsletterSubscribed = body.emailPreferences.newsletters;
        }
      }

      // Handle legacy newsletterSubscribed field (for backward compatibility)
      if (body.newsletterSubscribed !== undefined) {
        if (typeof body.newsletterSubscribed !== "boolean") {
          return res.status(400).json({ error: "Invalid newsletter subscription value" });
        }
        updates.newsletterSubscribed = body.newsletterSubscribed;

        // Also update emailPreferences.newsletters
        const currentPreferences = userData?.emailPreferences || getDefaultEmailPreferences();
        updates.emailPreferences = {
          ...currentPreferences,
          newsletters: body.newsletterSubscribed,
        };
      }

      if (body.dismissedPasswordPromo !== undefined) {
        if (typeof body.dismissedPasswordPromo !== "boolean") {
          return res.status(400).json({ error: "Invalid dismissedPasswordPromo value" });
        }
        updates.dismissedPasswordPromo = body.dismissedPasswordPromo;
      }

      if (body.preferredModel !== undefined) {
        if (typeof body.preferredModel !== "string" || body.preferredModel.length > 50) {
          return res.status(400).json({ error: "Invalid preferredModel value" });
        }
        updates.preferredModel = body.preferredModel;
      }

      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updates provided" });

      // Check if this is the first profile completion after activation
      let isCompletingActivation = false;
      if (userDoc?.exists && userData) {
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
