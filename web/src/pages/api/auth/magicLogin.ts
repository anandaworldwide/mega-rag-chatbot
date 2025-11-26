// API: Validates login magic token and issues JWT session cookie for accepted users. Token remains valid until 1-hour expiry.
import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import Cookies from "cookies";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { isDevelopment } from "@/utils/env";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { createSignedUUIDCookie } from "@/utils/server/uuidUtils";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!db) return res.status(503).json({ error: "Database not available" });

  const { token, email } = req.body as { token?: string; email?: string };
  if (!token || !email) return res.status(400).json({ error: "Missing token or email" });

  const usersCol = getUsersCollectionName();
  const userDocRef = db.collection(usersCol).doc(email.toLowerCase());
  const UUID_INDEX_COLLECTION = process.env.NODE_ENV === "production" ? "prod_uuid_index" : "dev_uuid_index";
  const emailLower = email.toLowerCase();

  try {
    const doc = await firestoreGet(userDocRef, "magic login", email);
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const data = doc.data() as any;
    if (data?.inviteStatus !== "accepted") return res.status(400).json({ error: "Account not activated" });

    const exp = (data?.loginTokenExpiresAt?.toMillis?.() ?? 0) as number;
    if (!exp || Date.now() > exp) return res.status(400).json({ error: "Link expired" });
    if (!data?.loginTokenHash) return res.status(400).json({ error: "Invalid token" });

    const valid = await bcrypt.compare(token, data.loginTokenHash);
    if (!valid) return res.status(400).json({ error: "Invalid token" });

    // Use proper HTTPS detection for secure cookies (same pattern as login.ts)
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
          const current = userSnap.exists ? (userSnap.data() as any) : {};
          const existingAccountUuid =
            typeof current?.uuid === "string" && current.uuid.length === 36 ? (current.uuid as string) : undefined;

          // Update login timestamp but keep token valid until expiry
          const updateFields = {
            lastLoginAt: nowTs,
            updatedAt: nowTs,
          } as any;

          if (existingAccountUuid) {
            // Ensure index exists (idempotent)
            const indexRef = (db as NonNullable<typeof db>).collection(UUID_INDEX_COLLECTION).doc(existingAccountUuid);
            const indexSnap = await tx.get(indexRef);
            if (!indexSnap.exists) {
              tx.set(indexRef, { email: emailLower, siteId: process.env.SITE_ID || "default", createdAt: nowTs });
            }
            tx.set(userDocRef, updateFields, { merge: true });
            finalUuid = existingAccountUuid;
          } else {
            // Reserve candidate or fail if taken by different user
            const indexRef = (db as NonNullable<typeof db>).collection(UUID_INDEX_COLLECTION).doc(candidate);
            const indexSnap = await tx.get(indexRef);
            if (indexSnap.exists && indexSnap.get("email") !== emailLower) {
              throw new Error("uuid-taken");
            }
            tx.set(indexRef, { email: emailLower, siteId: process.env.SITE_ID || "default", createdAt: nowTs });
            tx.set(userDocRef, { ...updateFields, uuid: candidate }, { merge: true });
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
      {
        expiresIn: "180d",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      }
    );

    try {
      cookies.set("auth", authToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecure,
        maxAge: 180 * 24 * 60 * 60 * 1000,
        path: "/",
      });

      // Set signed UUID cookie to prevent spoofing
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
    } catch (cookieError) {
      throw cookieError;
    }
    return res.status(200).json({ message: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
