// API: Verifies activation token, marks user accepted, and issues JWT session cookie.
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import Cookies from "cookies";
import bcrypt from "bcryptjs";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { isDevelopment } from "@/utils/env";
import { createSignedUUIDCookie } from "@/utils/server/uuidUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import type { EmailCategory } from "@/types/user";
import { isEmailBlacklisted } from "@/utils/server/blacklist";
import { writeAuditLog } from "@/utils/server/auditLog";

async function compareToken(token: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(token, hash);
  } catch {
    return false;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { token, email } = req.body as { token?: string; email?: string };
  if (!token || !email) return res.status(400).json({ error: "Missing token or email" });

  const normalizedVerifyEmail = email.trim().toLowerCase();
  const siteIdVerify = process.env.SITE_ID;
  if (siteIdVerify && (await isEmailBlacklisted(normalizedVerifyEmail, siteIdVerify))) {
    await writeAuditLog(req, "blacklist_block", normalizedVerifyEmail, { endpoint: "verifyMagicLink" });
    return res.status(403).json({ error: "Access denied. Please contact your administrator." });
  }

  const usersCol = getUsersCollectionName();
  const userDocRef = db.collection(usersCol).doc(normalizedVerifyEmail);
  const UUID_INDEX_COLLECTION = process.env.NODE_ENV === "production" ? "prod_uuid_index" : "dev_uuid_index";
  const emailLower = normalizedVerifyEmail;

  try {
    const doc = await firestoreGet(userDocRef, "get user for verify", normalizedVerifyEmail);
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const data = doc.data() as any;

    // SECURITY: Check account status FIRST before any authentication processing
    // Only allow activation for 'pending' (first time) and 'activated_pending_profile' (subsequent clicks before name entry)
    if (data?.inviteStatus !== "pending" && data?.inviteStatus !== "activated_pending_profile") {
      // Provide specific error for already activated accounts - DO NOT LOG THEM IN
      if (data?.inviteStatus === "accepted") {
        return res.status(400).json({
          error: "Account already activated",
          errorCode: "ALREADY_ACTIVATED",
          userStatus: data?.inviteStatus,
        });
      }
      return res.status(400).json({
        error: "Invalid account status",
        errorCode: "INVALID_STATUS",
        userStatus: data?.inviteStatus,
      });
    }
    const now = Date.now();
    const exp = (data?.inviteExpiresAt?.toMillis?.() ?? 0) as number;
    if (!exp || now > exp) return res.status(400).json({ error: "Link expired" });

    const valid = await compareToken(token, data?.inviteTokenHash || "");
    if (!data?.inviteTokenHash || !valid) {
      return res.status(400).json({ error: "Invalid token" });
    }

    // Use proper HTTPS detection for secure cookies (same pattern as login.ts)
    const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();

    // Transactional UUID reservation via index collection to ensure uniqueness
    const cookies = new Cookies(req, res, { secure: isSecure });
    const cookieUuid = cookies.get("uuid");
    const hasCookieUuid = typeof cookieUuid === "string" && cookieUuid.length === 36;
    const accountUuid =
      typeof (data as any)?.uuid === "string" && (data as any).uuid.length === 36 ? (data as any).uuid : undefined;
    const nowTs = firebase.firestore.Timestamp.now();

    let finalUuid: string | undefined = accountUuid as string | undefined;

    let attempts = 0;
    const maxAttempts = 3;
    let candidate = finalUuid || (hasCookieUuid ? (cookieUuid as string) : uuidv4());

    while (attempts < maxAttempts) {
      try {
        await (db as NonNullable<typeof db>).runTransaction(async (tx) => {
          const userSnap = await tx.get(userDocRef);
          const current = userSnap.exists ? (userSnap.data() as any) : {};
          const existingAccountUuid =
            typeof current?.uuid === "string" && current.uuid.length === 36 ? (current.uuid as string) : undefined;

          if (existingAccountUuid) {
            // Ensure index exists (idempotent)
            const indexRef = (db as NonNullable<typeof db>).collection(UUID_INDEX_COLLECTION).doc(existingAccountUuid);
            const indexSnap = await tx.get(indexRef);
            if (!indexSnap.exists) {
              tx.set(indexRef, { email: emailLower, siteId: process.env.SITE_ID || "default", createdAt: nowTs });
            }
            // Mark as activated but pending profile completion
            tx.set(
              userDocRef,
              { inviteStatus: "activated_pending_profile", verifiedAt: nowTs, lastLoginAt: nowTs, updatedAt: nowTs },
              { merge: true }
            );
            finalUuid = existingAccountUuid;
          } else {
            // Reserve candidate or fail if taken by different user
            const indexRef = (db as NonNullable<typeof db>).collection(UUID_INDEX_COLLECTION).doc(candidate);
            const indexSnap = await tx.get(indexRef);
            if (indexSnap.exists && indexSnap.get("email") !== emailLower) {
              throw new Error("uuid-taken");
            }
            tx.set(indexRef, { email: emailLower, siteId: process.env.SITE_ID || "default", createdAt: nowTs });
            tx.set(
              userDocRef,
              {
                uuid: candidate,
                inviteStatus: "activated_pending_profile",
                verifiedAt: nowTs,
                lastLoginAt: nowTs,
                updatedAt: nowTs,
              },
              { merge: true }
            );
            finalUuid = candidate;
          }
        });
        break; // success
      } catch (e: any) {
        if (e && typeof e.message === "string" && e.message.includes("uuid-taken")) {
          candidate = uuidv4();
          attempts += 1;
          continue;
        }
        throw e;
      }
    }

    // Issue JWT for authenticated sessions using SECURE_TOKEN
    const jwtSecret = process.env.SECURE_TOKEN;
    if (!jwtSecret) return res.status(500).json({ error: "JWT secret missing" });

    // Determine effective role for JWT (see magicLogin.ts for precedence rules)
    const effectiveRole = typeof (data as any)?.role === "string" ? (data as any).role : "user";

    const authToken = jwt.sign(
      {
        client: "web",
        email: normalizedVerifyEmail,
        role: effectiveRole,
        site: process.env.SITE_ID || "default",
      },
      jwtSecret,
      {
        expiresIn: "180d",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      }
    );

    // Set authentication and session cookies without unnecessary try/catch
    cookies.set("auth", authToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    // Set signed UUID cookie to prevent spoofing
    // TODO: Remove migration bridge after June 2026 - only signed cookies supported
    cookies.set("uuid", createSignedUUIDCookie(finalUuid as string), {
      httpOnly: false,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    // TODO: Remove migration bridge after June 2026 - only set authToken
    // Set both auth and authToken cookies during migration period
    // auth: legacy cookie for backward compatibility
    cookies.set("auth", authToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    // authToken: new cookie name
    cookies.set("authToken", authToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    // Set client-readable session indicator (allows JS to detect auth cookies exist)
    cookies.set("hasSession", "1", {
      httpOnly: false,
      sameSite: "lax",
      secure: isSecure,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    // Return existing name data if available for pre-population
    const siteConfig = await loadSiteConfig();
    const enabledEmailTypes: EmailCategory[] = [];
    if (siteConfig?.requireLogin) {
      enabledEmailTypes.push("newsletters");
      if (siteConfig?.enableOnboardingEmails) enabledEmailTypes.push("onboarding");
      if (siteConfig?.enableReengagementEmails) enabledEmailTypes.push("reengagement");
      if (siteConfig?.enableSpecialDayEmails) enabledEmailTypes.push("specialDay");
      if (siteConfig?.enableNpsSurveyEmail) enabledEmailTypes.push("nps");
    }

    return res.status(200).json({
      message: "ok",
      uuid: finalUuid,
      firstName: data?.firstName || undefined,
      lastName: data?.lastName || undefined,
      enabledEmailTypes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

// Activation must work for anonymous users; bypass siteAuth requirement
export default withApiMiddleware(handler, { skipAuth: true });
