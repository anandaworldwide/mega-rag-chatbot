/**
 * Web Token API Endpoint
 *
 * This endpoint generates JWT tokens for the web frontend client.
 * It solves a critical security problem: the frontend needs tokens but can't securely
 * store the SECURE_TOKEN needed to obtain them.
 *
 * By creating tokens directly from environment variables, this endpoint provides
 * a secure way for the frontend to obtain authentication without exposing secrets.
 *
 * Security considerations:
 * - Only accessible via GET for simplicity
 * - Server-side environment variables are never exposed to the client
 * - Error messages are generic to avoid leaking implementation details
 * - Always issues tokens (authenticated with user info if valid auth cookie present,
 *   or anonymous without user info if no/invalid auth cookie)
 * - Authorization decisions are delegated to downstream endpoints (chat API, contact
 *   form, etc.) which can check if the token contains user info or accept anonymous tokens
 * - Does NOT trust client-controlled headers (like Referer) for authorization decisions
 */

import { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import jwt from "jsonwebtoken";
import Cookies from "cookies";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { isDevelopment } from "@/utils/env";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { ensureAnonymousVisitorUuidCookie } from "@/utils/server/uuidUtils";

function clearInvalidAuthCookies(req: NextApiRequest, res: NextApiResponse): void {
  const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
  const cookies = new Cookies(req, res, { secure: isSecure });
  cookies.set("authToken", "", {
    expires: new Date(0),
    path: "/",
  });
  cookies.set("hasSession", "", {
    expires: new Date(0),
    path: "/",
  });
}

/**
 * API handler for the web token endpoint
 *
 * @param req The Next.js API request
 * @param res The Next.js API response
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // 100 requests per 5 minutes per IP
    name: "web-token-requests",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  // Only allow GET requests to simplify client usage
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Always issue tokens (authenticated or anonymous)
    // Authorization decisions are made by downstream endpoints (chat API, contact form, etc.)
    // This endpoint is a token factory, not an authorization gatekeeper

    const authToken = req.cookies["authToken"];

    if (authToken) {
      try {
        const jwtSecret = process.env.SECURE_TOKEN;
        if (!jwtSecret) {
          console.error("Missing SECURE_TOKEN environment variable for JWT verification");
          return res.status(500).json({ error: "Server configuration error" });
        }

        jwt.verify(authToken, jwtSecret, {
          algorithms: ["HS256"],
          issuer: "mega-rag-chatbot",
          audience: "mega-rag-chatbot-users",
        });
      } catch (jwtError) {
        const siteConfig = loadSiteConfigSync();
        const requiresLogin = siteConfig?.requireLogin === true;

        clearInvalidAuthCookies(req, res);

        if (requiresLogin) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const errorMsg = jwtError instanceof Error ? jwtError.message : String(jwtError);
        console.warn(`Invalid auth cookie in web-token request (cleared): ${errorMsg}`);
      }
    }

    // Verify SECURE_TOKEN is available in environment variables
    if (!process.env.SECURE_TOKEN) {
      console.error("Missing SECURE_TOKEN environment variable");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Create JWT payload - conditionally include user info if authenticated
    const payload: any = {
      client: "web",
      iat: Math.floor(Date.now() / 1000),
    };

    const authCookie = req.cookies?.["authToken"];
    if (authCookie) {
      try {
        const userPayload = verifyToken(authCookie) as any;
        if (userPayload?.email && db) {
          const userDoc = await firestoreGet(
            db.collection(getUsersCollectionName()).doc(userPayload.email),
            "get user UUID for JWT",
            userPayload.email
          );

          if (userDoc.exists) {
            const userData = userDoc.data();
            payload.email = userPayload.email;
            payload.role = userPayload.role || userData?.role || "user";
            payload.uuid = userData?.uuid;
          }
        }
      } catch (_error) {
        const siteConfig = loadSiteConfigSync();
        const requiresLogin = siteConfig?.requireLogin === true;

        clearInvalidAuthCookies(req, res);

        if (requiresLogin) {
          return res.status(401).json({ error: "Authentication required" });
        }
      }
    }

    ensureAnonymousVisitorUuidCookie(req, res);

    try {
      const webToken = jwt.sign(payload, process.env.SECURE_TOKEN, {
        expiresIn: "15m",
        algorithm: "HS256",
        issuer: "mega-rag-chatbot",
        audience: "mega-rag-chatbot-users",
      });
      return res.status(200).json({ token: webToken });
    } catch (tokenError) {
      console.error("Error creating web token:", tokenError);
      return res.status(500).json({ error: "Failed to create token" });
    }
  } catch (error) {
    console.error("Error in web token endpoint:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
