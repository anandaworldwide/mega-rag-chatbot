import { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import Cookies from "cookies";
import jwt from "jsonwebtoken";
import cors, { runMiddleware } from "@/utils/server/corsMiddleware";
import { genericRateLimiter, deleteRateLimitCounter } from "@/utils/server/genericRateLimiter";
import { isDevelopment } from "@/utils/env";
import validator from "validator";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { isEmailBlacklisted } from "@/utils/server/blacklist";
import { writeAuditLog } from "@/utils/server/auditLog";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method === "POST") {
    // Apply rate limiting
    const isAllowed = await genericRateLimiter(req, res, {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 8, // 8 requests per 15 minutes
      name: "login",
    });

    if (!isAllowed) return;

    const { email, password, redirect } = req.body;

    // Input validation
    if (typeof email !== "string" || !validator.isEmail(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (typeof password !== "string" || validator.isEmpty(password)) {
      return res.status(400).json({ message: "Invalid password" });
    }
    if (!validator.isLength(password, { min: 6, max: 100 })) {
      return res.status(400).json({ message: "Invalid password length" });
    }
    if (
      redirect &&
      redirect !== "/" &&
      !validator.isURL(redirect, {
        require_tld: false,
        allow_protocol_relative_urls: true,
        require_protocol: false,
        allow_fragments: false,
        allow_query_components: true,
      }) &&
      !redirect.startsWith("/")
    ) {
      console.log("Invalid redirect URL:", redirect);
      return res.status(400).json({ message: "Invalid redirect URL" });
    }

    // Sanitize inputs
    const sanitizedEmail = email.toLowerCase().trim();
    const sanitizedPassword = password.trim();
    const sanitizedRedirect = redirect ? decodeURIComponent(redirect.trim()) : "/";

    console.log("Received login request for email:", sanitizedEmail, "with redirect:", sanitizedRedirect);

    const siteIdLogin = process.env.SITE_ID;
    if (siteIdLogin && (await isEmailBlacklisted(sanitizedEmail, siteIdLogin))) {
      await writeAuditLog(req, "blacklist_block", sanitizedEmail, { endpoint: "login" });
      return res.status(403).json({ message: "Access denied. Please contact your administrator." });
    }

    if (!db) {
      return res.status(503).json({ message: "Database not available" });
    }

    const usersCol = getUsersCollectionName();
    const userDocRef = db.collection(usersCol).doc(sanitizedEmail);

    try {
      const userSnap = await firestoreGet(userDocRef, "user login", sanitizedEmail);
      if (!userSnap.exists) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const userData = userSnap.data() as any;
      if (userData.inviteStatus !== "accepted" || userData.role === "inactive") {
        return res.status(401).json({ message: "Account not activated" });
      }

      if (!userData.passwordHash) {
        return res.status(400).json({ message: "Password not set" });
      }

      const match = await bcrypt.compare(sanitizedPassword, userData.passwordHash);
      if (!match) {
        return res.status(403).json({ message: "Invalid credentials" });
      }

      // Generate JWT
      const jwtSecret = process.env.SECURE_TOKEN;
      if (!jwtSecret) {
        return res.status(500).json({ message: "Server configuration error" });
      }

      const tokenPayload = {
        client: "web",
        email: sanitizedEmail,
        role: userData.role,
        entitlements: userData.entitlements || {},
        site: process.env.SITE_ID || "default",
      };
      // Use 180 days expiry to match other login endpoints (magicLogin, loginWithPassword)
      const jwtToken = jwt.sign(tokenPayload, jwtSecret, {
        expiresIn: "180d",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });

      const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
      const cookies = new Cookies(req, res, { secure: isSecure });

      // TODO: Remove migration bridge after June 2026 - only set authToken
      // Set both auth and authToken cookies during migration period
      // auth: legacy cookie for backward compatibility
      cookies.set("auth", jwtToken, {
        httpOnly: true,
        secure: isSecure,
        maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
        sameSite: "lax",
        path: "/",
      });
      // authToken: new cookie name
      cookies.set("authToken", jwtToken, {
        httpOnly: true,
        secure: isSecure,
        maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
        sameSite: "lax",
        path: "/",
      });
      // Set client-readable session indicator (allows JS to detect auth cookies exist)
      cookies.set("hasSession", "1", {
        httpOnly: false,
        secure: isSecure,
        maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
        sameSite: "lax",
        path: "/",
      });

      // Delete the rate limit counter after successful login
      await deleteRateLimitCounter(req, "login");

      return res.status(200).json({ message: "Authenticated", redirect: sanitizedRedirect });
    } catch (err) {
      console.error("Login error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  } else {
    res.status(405).json({ message: "Method not allowed" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
