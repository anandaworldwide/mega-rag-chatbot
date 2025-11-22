// API: Login with email and password, issues JWT session cookie
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import Cookies from "cookies";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { comparePassword } from "@/utils/server/passwordUtils";
import { isDevelopment } from "@/utils/env";
import { writeAuditLog } from "@/utils/server/auditLog";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Check if password feature is enabled (only for sites with requireLogin)
  const siteConfig = loadSiteConfigSync();
  if (!siteConfig?.requireLogin) {
    return res.status(403).json({ error: "Password authentication not available for this site" });
  }

  // Rate limit: 5 attempts per 15 minutes per IP
  const allowed = await genericRateLimiter(req, res, { windowMs: 15 * 60 * 1000, max: 5, name: "login-password" });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== "string") return res.status(400).json({ error: "Email is required" });
  if (!password || typeof password !== "string") return res.status(400).json({ error: "Password is required" });

  const usersCol = getUsersCollectionName();
  const userDocRef = db.collection(usersCol).doc(email.toLowerCase());
  const UUID_INDEX_COLLECTION = isDevelopment() ? "dev_uuid_index" : "prod_uuid_index";
  const emailLower = email.toLowerCase();

  try {
    const doc = await firestoreGet(userDocRef, "password login", email);
    if (!doc.exists) {
      // No user enumeration - return generic error
      await writeAuditLog(req, "user_login_failed", emailLower, {
        outcome: "failure",
        reason: "user_not_found",
        method: "password",
      });
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const data = doc.data() as any;
    if (data?.inviteStatus !== "accepted") {
      await writeAuditLog(req, "user_login_failed", emailLower, {
        outcome: "failure",
        reason: "account_not_activated",
        method: "password",
      });
      return res.status(400).json({ error: "Account not activated" });
    }

    if (!data?.passwordHash) {
      await writeAuditLog(req, "user_login_failed", emailLower, {
        outcome: "failure",
        reason: "no_password_set",
        method: "password",
      });
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Verify password
    const passwordMatches = await comparePassword(password, data.passwordHash);
    if (!passwordMatches) {
      await writeAuditLog(req, "user_login_failed", emailLower, {
        outcome: "failure",
        reason: "incorrect_password",
        method: "password",
      });
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Use proper HTTPS detection for secure cookies (same pattern as magicLogin.ts)
    const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();

    // Determine UUID: if account has none, adopt legacy cookie if valid, else generate new
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
          if (!userSnap.exists) {
            throw new Error("User disappeared during transaction");
          }
          const currentUuid = userSnap.get("uuid");
          const existingAccountUuid =
            typeof currentUuid === "string" && currentUuid.length === 36 ? currentUuid : undefined;

          if (existingAccountUuid) {
            tx.set(userDocRef, { lastLoginAt: nowTs, updatedAt: nowTs }, { merge: true });
            finalUuid = existingAccountUuid;
          } else {
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
                lastLoginAt: nowTs,
                updatedAt: nowTs,
              },
              { merge: true }
            );
            finalUuid = candidate;
          }
        });
        break;
      } catch (e: any) {
        if (e && typeof e.message === "string" && e.message.includes("uuid-taken")) {
          candidate = uuidv4();
          attempts += 1;
          continue;
        }
        throw e;
      }
    }

    const jwtSecret = process.env.SECURE_TOKEN;
    if (!jwtSecret) return res.status(500).json({ error: "JWT secret missing" });

    // Determine effective role for JWT: use explicit role field; default to "user"
    const effectiveRole = typeof (data as any)?.role === "string" ? (data as any).role : "user";

    const authToken = jwt.sign(
      {
        client: "web",
        email: email.toLowerCase(),
        role: effectiveRole,
        site: process.env.SITE_ID || "default",
      },
      jwtSecret,
      { expiresIn: "180d" }
    );

    try {
      cookies.set("auth", authToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecure,
        maxAge: 180 * 24 * 60 * 60 * 1000,
        path: "/",
      });

      cookies.set("uuid", finalUuid as string, {
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
    } catch (cookieError) {
      throw cookieError;
    }

    // Audit log successful login
    await writeAuditLog(req, "user_login_success", emailLower, {
      outcome: "success",
      method: "password",
    });

    return res.status(200).json({ message: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
