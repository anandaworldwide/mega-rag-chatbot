import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import jwt from "jsonwebtoken";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth, getTokenFromRequest, verifyToken } from "@/utils/server/jwtUtils";
import { requireAdminRoleFromFirestore, getRequesterRoleFromFirestore } from "@/utils/server/authz";
import { getUsersCollectionName, getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { loadSiteConfigSync, loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { writeAuditLog } from "@/utils/server/auditLog";
import { isDevelopment } from "@/utils/env";
import { deleteFromCache } from "@/utils/server/redisUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { sanitizeName } from "@/utils/server/inputSanitization";
import { isEmailBlacklisted } from "@/utils/server/blacklist";
import {
  buildAccessLevelResponseFields,
  validateManualAccessLevel,
} from "@/utils/server/accessLevelUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "admin_user_management",
  });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { userId } = req.query as { userId: string };
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Invalid userId" });
  }

  const usersCol = getUsersCollectionName();
  const dbNonNull = db as NonNullable<typeof db>;
  const currentId = userId.toLowerCase();

  if (req.method === "GET") {
    try {
      // Critical security fix – verify admin role from Firestore (source of truth)
      // Prevents stale JWT admin roles from granting access after revocation
      try {
        await requireAdminRoleFromFirestore(req);
      } catch (_error) {
        return res.status(403).json({ error: "Unauthorized: Admin privileges required" });
      }

      const requesterRole = await getRequesterRoleFromFirestore(req);
      const siteConfig = loadSiteConfigSync();
      const doc = await db.collection(usersCol).doc(currentId).get();
      if (!doc.exists) return res.status(404).json({ error: "User not found" });
      const data = doc.data() || {};

      // Fetch user's total question count for all admin roles
      let conversationCount = 0;

      if (data.uuid && (requesterRole === "admin" || requesterRole === "superuser")) {
        try {
          const countQuery = db.collection(getAnswersCollectionName()).where("uuid", "==", data.uuid);

          const countSnapshot = await firestoreQueryGet(countQuery, "admin user question count", `uuid: ${data.uuid}`);

          // Count total number of questions (documents)
          conversationCount = countSnapshot.docs.length;
        } catch (chatError: any) {
          // Don't fail the entire request if question count can't be fetched
          console.warn("Failed to fetch user question count:", chatError?.message);
        }
      }

      // Fetch audit log to determine who added or approved this user
      let addedBy: string | null = null;
      let addedAt: Date | null = null;

      try {
        const prefix = isDevelopment() ? "dev_" : "prod_";
        const auditQuery = db
          .collection(`${prefix}admin_audit`)
          .where("target", "==", currentId)
          .where("action", "in", ["admin_add_user", "admin_approval_approve"])
          .orderBy("createdAt", "desc")
          .limit(1);

        const auditSnapshot = await firestoreQueryGet(
          auditQuery,
          "admin audit log for user creation",
          `target: ${currentId}`
        );

        if (!auditSnapshot.empty) {
          const auditDoc = auditSnapshot.docs[0].data();
          addedBy = auditDoc?.requester?.email || null;
          addedAt = auditDoc?.createdAt?.toDate?.() ?? null;
        }
      } catch (auditError: any) {
        console.warn("Failed to fetch audit log for user:", {
          error: auditError?.message || String(auditError),
          code: auditError?.code,
          stack: auditError?.stack,
          target: currentId,
        });
      }

      return res.status(200).json({
        user: {
          id: currentId,
          email: currentId, // Email is stored as document ID
          uuid: data.uuid || null,
          role: data.role || "user",
          inviteStatus: data.inviteStatus || null,
          verifiedAt: data.verifiedAt?.toDate?.() ?? null,
          lastLoginAt: data.lastLoginAt?.toDate?.() ?? null,
          entitlements: data.entitlements || {},
          firstName: typeof (data as any)?.firstName === "string" ? (data as any).firstName : null,
          lastName: typeof (data as any)?.lastName === "string" ? (data as any).lastName : null,
          newsletterSubscribed:
            typeof (data as any)?.newsletterSubscribed === "boolean" ? (data as any).newsletterSubscribed : false,
          conversationCount,
          addedBy,
          addedAt,
          passwordSet: !!data.passwordHash, // Boolean - whether user has password set
          passwordSetAt: data.passwordSetAt?.toDate?.() ?? null, // When password was set
          isApprover: typeof (data as any)?.isApprover === "boolean" ? (data as any).isApprover : false,
          approverLocation: typeof (data as any)?.approverLocation === "string" ? (data as any).approverLocation : null,
          approverRegion: typeof (data as any)?.approverRegion === "string" ? (data as any).approverRegion : null,
          ...buildAccessLevelResponseFields(data, siteConfig),
        },
      });
    } catch (err: any) {
      const safeMessage = getSafeErrorMessage(err, "Failed to fetch user");
      return res.status(500).json({ error: safeMessage });
    }
  }

  if (req.method === "PATCH") {
    try {
      const body = (req.body || {}) as {
        email?: string;
        role?: string;
        firstName?: string;
        lastName?: string;
        newsletterSubscribed?: boolean;
        isApprover?: boolean;
        approverLocation?: string;
        approverRegion?: string;
        manualAccessLevel?: number | string | null;
      };
      // Critical security fix – verify admin role from Firestore (source of truth)
      // Prevents stale JWT admin roles from granting access after revocation
      try {
        await requireAdminRoleFromFirestore(req);
      } catch (_error) {
        return res.status(403).json({ error: "Unauthorized: Admin privileges required" });
      }

      const requesterRole = await getRequesterRoleFromFirestore(req);
      const updates: Record<string, any> = {};
      const now = firebase.firestore.Timestamp.now();
      const siteConfig = loadSiteConfigSync();
      const requesterEmail = getRequesterEmail(req);

      // Validate role if provided (only superuser can change role)
      if (body.role !== undefined) {
        const allowed = ["user", "admin", "superuser"];
        if (typeof body.role !== "string" || !allowed.includes(body.role)) {
          return res.status(400).json({ error: "Invalid role" });
        }
        if (requesterRole !== "superuser") {
          return res.status(403).json({ error: "Only superuser may change role" });
        }
        updates.role = body.role;
      }

      // Optional name updates
      if (body.firstName !== undefined) {
        if (typeof body.firstName !== "string" || body.firstName.length > 100) {
          return res.status(400).json({ error: "Invalid first name" });
        }
        try {
          updates.firstName = sanitizeName(body.firstName, 100);
        } catch (error: any) {
          return res.status(400).json({ error: `Invalid first name: ${error.message || "Name validation failed"}` });
        }
      }
      if (body.lastName !== undefined) {
        if (typeof body.lastName !== "string" || body.lastName.length > 100) {
          return res.status(400).json({ error: "Invalid last name" });
        }
        try {
          updates.lastName = sanitizeName(body.lastName, 100);
        } catch (error: any) {
          return res.status(400).json({ error: `Invalid last name: ${error.message || "Name validation failed"}` });
        }
      }

      // Newsletter subscription update
      if (body.newsletterSubscribed !== undefined) {
        if (typeof body.newsletterSubscribed !== "boolean") {
          return res.status(400).json({ error: "Invalid newsletter subscription value" });
        }
        updates.newsletterSubscribed = body.newsletterSubscribed;
      }

      if (body.manualAccessLevel !== undefined) {
        if (requesterEmail === currentId) {
          return res.status(403).json({ error: "Admins cannot change their own access level" });
        }

        const validation = validateManualAccessLevel(body.manualAccessLevel, requesterRole, siteConfig);
        if (!validation.valid) {
          return res.status(400).json({ error: validation.error || "Invalid access level" });
        }

        updates.manualAccessLevel = validation.level;
      }

      // Approver fields - only superuser can update, only on admin/superuser roles
      // Only validate when approver fields are being actively set (not just cleared)
      const isSettingApprover = body.isApprover === true;
      const isSettingLocation = body.approverLocation && body.approverLocation.trim().length > 0;
      const isSettingRegion = body.approverRegion && body.approverRegion.trim().length > 0;
      const isSettingAnyApproverField = isSettingApprover || isSettingLocation || isSettingRegion;

      if (body.isApprover !== undefined || body.approverLocation !== undefined || body.approverRegion !== undefined) {
        if (requesterRole !== "superuser") {
          return res.status(403).json({ error: "Only superuser may update approver settings" });
        }

        // Only check role requirement when actually setting approver fields (not clearing them)
        if (isSettingAnyApproverField) {
          // If role is being changed in the same request, use the new role for validation
          // (the Firestore doc still has the old role at this point)
          const effectiveRole = updates.role as string | undefined;
          if (!effectiveRole) {
            const currentUserDoc = await db.collection(usersCol).doc(currentId).get();
            if (!currentUserDoc.exists) {
              return res.status(404).json({ error: "User not found" });
            }
            const currentUserData = currentUserDoc.data() || {};
            const currentUserRole = currentUserData.role || "user";

            if (currentUserRole !== "admin" && currentUserRole !== "superuser") {
              console.warn(`[PATCH /admin/users] 400: approver settings on non-admin role. userId=${currentId}, currentRole=${currentUserRole}`);
              return res.status(400).json({ error: "Approver settings can only be set on admin or superuser roles" });
            }
          } else if (effectiveRole !== "admin" && effectiveRole !== "superuser") {
            console.warn(`[PATCH /admin/users] 400: approver settings with new role="${effectiveRole}". userId=${currentId}`);
            return res.status(400).json({ error: "Approver settings can only be set on admin or superuser roles" });
          }
        }

        if (body.isApprover !== undefined) {
          if (typeof body.isApprover !== "boolean") {
            return res.status(400).json({ error: "Invalid isApprover value" });
          }
          updates.isApprover = body.isApprover;
        }

        if (body.approverLocation !== undefined) {
          // Allow null to clear the field, or validate string length
          if (
            body.approverLocation !== null &&
            (typeof body.approverLocation !== "string" || body.approverLocation.length > 200)
          ) {
            return res.status(400).json({ error: "Invalid approver location (max 200 characters)" });
          }
          updates.approverLocation = body.approverLocation === null ? null : body.approverLocation.trim() || null;
        }

        if (body.approverRegion !== undefined) {
          // Allow null to clear the field, or validate string length
          if (
            body.approverRegion !== null &&
            (typeof body.approverRegion !== "string" || body.approverRegion.length > 200)
          ) {
            return res.status(400).json({ error: "Invalid approver region (max 200 characters)" });
          }
          updates.approverRegion = body.approverRegion === null ? null : body.approverRegion.trim() || null;
        }

        // Clear approvers cache when approver settings are updated
        if (
          updates.isApprover !== undefined ||
          updates.approverLocation !== undefined ||
          updates.approverRegion !== undefined
        ) {
          try {
            const siteConfig = await loadSiteConfig();
            if (siteConfig?.siteId) {
              const cacheKey = `admin_approvers_${siteConfig.siteId}`;
              await deleteFromCache(cacheKey);
            }
          } catch (cacheError) {
            // Non-fatal - log but don't fail the update
            console.warn("Failed to clear approvers cache:", cacheError);
          }
        }
      }

      // If only role/name update (no email change)
      if (!body.email || body.email.toLowerCase() === currentId) {
        if (Object.keys(updates).length === 0) {
          console.warn(`[PATCH /admin/users] 400: no updates. userId=${currentId}, bodyKeys=${JSON.stringify(Object.keys(req.body || {}))}, bodyType=${typeof req.body}`);
          return res.status(400).json({ error: "No updates provided" });
        }
        updates.updatedAt = now;

        // Use transaction to prevent race conditions when multiple admins update simultaneously
        let data: any = {};
        await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
          // PHASE 1: ALL READS FIRST (Firestore transaction requirement)
          const userRef = (db as NonNullable<typeof db>).collection(usersCol).doc(currentId);
          const userSnap = await tx.get(userRef);

          if (!userSnap.exists) {
            throw new Error("User not found in transaction");
          }

          // PHASE 2: ALL WRITES AFTER ALL READS
          tx.set(userRef, updates, { merge: true });

          // Store data for response after transaction completes
          data = { ...userSnap.data(), ...updates };
        });

        if (updates.role) {
          await writeAuditLog(req, "admin_change_role", currentId, {
            role: updates.role,
            outcome: "success",
          });
        }

        // Fetch user's total question count for all admin roles
        let conversationCount = 0;

        if (data.uuid && (requesterRole === "admin" || requesterRole === "superuser")) {
          try {
            const countQuery = db.collection(getAnswersCollectionName()).where("uuid", "==", data.uuid);

            const countSnapshot = await firestoreQueryGet(
              countQuery,
              "admin user question count",
              `uuid: ${data.uuid}`
            );

            // Count total number of questions (documents)
            conversationCount = countSnapshot.docs.length;
          } catch (chatError: any) {
            console.warn("Failed to fetch user question count:", chatError?.message);
          }
        }

        return res.status(200).json({
          user: {
            id: currentId,
            email: currentId, // Email is stored as document ID
            uuid: data.uuid || null,
            role: data.role || "user",
            inviteStatus: data.inviteStatus || null,
            verifiedAt: data.verifiedAt?.toDate?.() ?? null,
            lastLoginAt: data.lastLoginAt?.toDate?.() ?? null,
            entitlements: data.entitlements || {},
            firstName: typeof (data as any)?.firstName === "string" ? (data as any).firstName : null,
            lastName: typeof (data as any)?.lastName === "string" ? (data as any).lastName : null,
            newsletterSubscribed:
              typeof (data as any)?.newsletterSubscribed === "boolean" ? (data as any).newsletterSubscribed : false,
            conversationCount,
            isApprover: typeof (data as any)?.isApprover === "boolean" ? (data as any).isApprover : false,
            approverLocation:
              typeof (data as any)?.approverLocation === "string" ? (data as any).approverLocation : null,
            approverRegion: typeof (data as any)?.approverRegion === "string" ? (data as any).approverRegion : null,
            ...buildAccessLevelResponseFields(data, siteConfig),
          },
        });
      }

      // Email change flow (may include role update too)
      const newEmail = body.email.toLowerCase();
      const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (!emailRegex.test(newEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      const siteIdUserPatch = process.env.SITE_ID;
      if (siteIdUserPatch && (await isEmailBlacklisted(newEmail, siteIdUserPatch))) {
        await writeAuditLog(req, "blacklist_block", newEmail, {
          endpoint: "admin.users.patchEmail",
          actor: "admin",
        });
        return res.status(400).json({ error: "Email is blacklisted" });
      }

      await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
        const currentRef = (db as NonNullable<typeof db>).collection(usersCol).doc(currentId);
        const newRef = (db as NonNullable<typeof db>).collection(usersCol).doc(newEmail);

        const [currentSnap, newSnap] = await Promise.all([tx.get(currentRef), tx.get(newRef)]);
        if (!currentSnap.exists) throw new Error("User not found");
        if (newSnap.exists) throw new Error("Email already in use");

        const data = currentSnap.data() || {};
        const newData = {
          ...data,
          // Apply all validated updates (role, firstName, lastName, approver settings, etc.)
          ...updates,
          updatedAt: now,
        };

        // Remove any existing email field - document ID is source of truth
        delete (newData as any).email;

        tx.set(newRef, newData, { merge: true });
        tx.delete(currentRef);
      });

      await writeAuditLog(req, "admin_change_email", currentId, {
        newEmail,
        outcome: "success",
      });

      // Check if admin is changing their own email and update JWT cookie if so
      try {
        const cookieJwt = req.cookies?.["auth"];
        if (cookieJwt) {
          const payload: any = verifyToken(cookieJwt);
          const requesterEmail = typeof payload?.email === "string" ? payload.email.toLowerCase() : null;

          // If admin is changing their own email, update the JWT cookie
          if (requesterEmail === currentId) {
            const jwtSecret = process.env.SECURE_TOKEN;
            if (jwtSecret) {
              const newAuthPayload = {
                client: "web",
                email: newEmail,
                role: payload.role || "user",
                site: process.env.SITE_ID || "default",
              };
              const newAuthToken = jwt.sign(newAuthPayload, jwtSecret, {
                expiresIn: "180d",
                algorithm: "HS256",
                issuer: "mega-rag-chatbot",
                audience: "mega-rag-chatbot-users",
              });

              // Set the updated auth cookie
              const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
              res.setHeader("Set-Cookie", [
                `auth=${newAuthToken}; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${180 * 24 * 60 * 60}`,
              ]);
            }
          }
        }
      } catch (cookieError) {
        console.error("Failed to update auth cookie after admin email change:", cookieError);
        // Don't fail the email change if cookie update fails - user can manually re-login
      }

      const finalDoc = await (db as NonNullable<typeof db>).collection(usersCol).doc(newEmail).get();
      const out = finalDoc.data() || {};

      // Fetch user's total question count for all admin roles
      let conversationCount = 0;

      if (out.uuid && (requesterRole === "admin" || requesterRole === "superuser")) {
        try {
          const countQuery = db.collection(getAnswersCollectionName()).where("uuid", "==", out.uuid);

          const countSnapshot = await firestoreQueryGet(countQuery, "admin user question count", `uuid: ${out.uuid}`);

          // Count total number of questions (documents)
          conversationCount = countSnapshot.docs.length;
        } catch (chatError: any) {
          console.warn("Failed to fetch user question count:", chatError?.message);
        }
      }

      // Attempt to notify both addresses about the change (suppressed during tests)
      if (process.env.NODE_ENV !== "test" && process.env.JEST_WORKER_ID === undefined) {
        try {
          const ses = new SESClient({
            region: process.env.AWS_REGION || "us-west-2",
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
            },
          });
          const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "Ananda Library";
          const subject = `Your ${brand} account email was updated`;
          const text = `Your account email was changed from ${currentId} to ${newEmail}. If you did not request this change, please contact support immediately.`;
          const source = process.env.CONTACT_EMAIL || "noreply@ananda.org";
          const cmds = [currentId, newEmail].map(
            (addr) =>
              new SendEmailCommand({
                Source: source,
                Destination: { ToAddresses: [addr] },
                Message: { Subject: { Data: subject }, Body: { Text: { Data: text } } },
              })
          );
          for (const cmd of cmds) {
            await ses.send(cmd);
          }
        } catch (e) {
          // Non-fatal: logging only
          console.warn("Email change notification failed:", e);
        }
      }
      return res.status(200).json({
        user: {
          id: newEmail,
          email: newEmail, // Email is stored as document ID
          uuid: out.uuid || null,
          role: out.role || "user",
          inviteStatus: out.inviteStatus || null,
          verifiedAt: out.verifiedAt?.toDate?.() ?? null,
          lastLoginAt: out.lastLoginAt?.toDate?.() ?? null,
          entitlements: out.entitlements || {},
          firstName: typeof (out as any)?.firstName === "string" ? (out as any).firstName : null,
          lastName: typeof (out as any)?.lastName === "string" ? (out as any).lastName : null,
          newsletterSubscribed:
            typeof (out as any)?.newsletterSubscribed === "boolean" ? (out as any).newsletterSubscribed : false,
          conversationCount,
          isApprover: typeof (out as any)?.isApprover === "boolean" ? (out as any).isApprover : false,
          approverLocation: typeof (out as any)?.approverLocation === "string" ? (out as any).approverLocation : null,
          approverRegion: typeof (out as any)?.approverRegion === "string" ? (out as any).approverRegion : null,
          ...buildAccessLevelResponseFields(out, siteConfig),
        },
      });
    } catch (err: any) {
      // Check for specific error types that are safe to expose
      const errorMessage = err?.message || "";
      let status = 500;
      let safeMessage = "Failed to update user";

      if (errorMessage.includes("not found")) {
        status = 404;
        safeMessage = "User not found";
      } else if (errorMessage.includes("already in use")) {
        status = 409;
        safeMessage = "Email already in use";
      } else {
        // For other errors, use sanitized message
        safeMessage = getSafeErrorMessage(err, "Failed to update user");
      }

      return res.status(status).json({ error: safeMessage });
    }
  }

  if (req.method === "DELETE") {
    try {
      // Critical security fix – verify admin role from Firestore (source of truth)
      // Prevents stale JWT admin roles from granting access after revocation
      try {
        await requireAdminRoleFromFirestore(req);
      } catch (_error) {
        return res.status(403).json({ error: "Unauthorized: Admin privileges required" });
      }

      const requesterRole = await getRequesterRoleFromFirestore(req);

      // Get user data before deletion for audit log
      const userDoc = await dbNonNull.collection(usersCol).doc(currentId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const userData = userDoc.data() || {};

      // Prevent self-deletion - check both cookie and header tokens
      try {
        const cookieJwt = req.cookies?.["auth"];
        let requesterEmail: string | null = null;

        if (cookieJwt) {
          const payload: any = verifyToken(cookieJwt);
          requesterEmail = typeof payload?.email === "string" ? payload.email.toLowerCase() : null;
        } else {
          // Fallback to Authorization header
          const headerPayload: any = getTokenFromRequest(req);
          requesterEmail = typeof headerPayload?.email === "string" ? headerPayload.email.toLowerCase() : null;
        }

        if (requesterEmail === currentId) {
          return res.status(400).json({ error: "Cannot delete your own account" });
        }
      } catch {
        // Token verification failed, but we'll continue with deletion
      }

      // Delete the user document
      await dbNonNull.collection(usersCol).doc(currentId).delete();

      // Log the deletion with comprehensive audit info
      await writeAuditLog(req, "admin_delete_user", currentId, {
        deletedUser: {
          email: currentId, // Email is stored as document ID
          role: userData.role || "user",
          inviteStatus: userData.inviteStatus || null,
          firstName: userData.firstName || null,
          lastName: userData.lastName || null,
          uuid: userData.uuid || null,
          createdAt: userData.createdAt || null,
          lastLoginAt: userData.lastLoginAt || null,
        },
        requesterRole,
        outcome: "success",
      });

      return res.status(200).json({
        success: true,
        message: "User deleted successfully",
      });
    } catch (err: any) {
      // Check for specific error types that are safe to expose
      const errorMessage = err?.message || "";
      let status = 500;
      let safeMessage = "Failed to delete user";

      if (errorMessage.includes("not found")) {
        status = 404;
        safeMessage = "User not found";
      } else {
        // For other errors, use sanitized message
        safeMessage = getSafeErrorMessage(err, "Failed to delete user");
      }

      return res.status(status).json({ error: safeMessage });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

function getRequesterEmail(req: NextApiRequest): string | null {
  try {
    const cookieJwt = req.cookies?.["auth"];
    if (cookieJwt) {
      const payload: any = verifyToken(cookieJwt);
      return typeof payload?.email === "string" ? payload.email.toLowerCase() : null;
    }
  } catch {
    // Fall through to header token.
  }

  try {
    const headerPayload: any = getTokenFromRequest(req);
    return typeof headerPayload?.email === "string" ? headerPayload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export default withApiMiddleware(withJwtAuth(handler));
