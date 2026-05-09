/**
 * JWT Authentication Utilities
 *
 * This module provides utilities for JWT token verification and API route protection.
 * It leverages the existing SECURE_TOKEN from the authentication system to verify tokens,
 * avoiding the need for separate JWT signing keys.
 *
 * The utilities support:
 * 1. Direct token verification
 * 2. Extracting and verifying tokens from API requests
 * 3. Creating protected API route handlers with JWT authentication
 */

import { NextApiRequest, NextApiResponse } from "next";
import jwt, { Algorithm } from "jsonwebtoken";
import Cookies from "cookies";
import { createErrorCorsHeaders } from "./corsMiddleware";
import { writeAuditLog } from "./auditLog";
import { isDevelopment } from "@/utils/env";

/**
 * JWT verification options for security
 * - algorithms: Only allow HS256 to prevent algorithm confusion attacks
 * - issuer: Verify the token was issued by this application
 * - audience: Verify the token is intended for this application's users
 */
const JWT_VERIFY_OPTIONS = {
  algorithms: ["HS256" as Algorithm],
  issuer: "mega-rag-chatbot",
  audience: "mega-rag-chatbot-users",
};

/**
 * JWT signing options for security
 * - algorithm: Use HS256 for signing
 * - issuer: Identify this application as the token issuer
 * - audience: Specify the intended token audience
 *
 * Export this to ensure consistent signing across all endpoints
 */
export const JWT_SIGN_OPTIONS = {
  algorithm: "HS256",
  issuer: "mega-rag-chatbot",
  audience: "mega-rag-chatbot-users",
};

/**
 * Interface defining the structure of the JWT payload
 * - client: Identifies the client type ("web" or "wordpress")
 * - email: User's email address (for authenticated users)
 * - role: User's role (for authenticated users)
 * - uuid: User's UUID (for authenticated users)
 * - iat: Issued at timestamp
 * - exp: Expiration timestamp
 */
export interface JwtPayload {
  client: string;
  email?: string;
  role?: string;
  uuid?: string;
  iat: number;
  exp: number;
}

/**
 * Verifies a JWT token and returns the decoded payload
 *
 * This function uses the application's SECURE_TOKEN as the JWT secret,
 * leveraging the existing authentication infrastructure instead of
 * requiring a separate JWT_SECRET.
 *
 * @param token The JWT token to verify
 * @returns The decoded token payload with client information
 * @throws Error if token is invalid, expired, or if SECURE_TOKEN is not configured
 */
export function verifyToken(token: string): JwtPayload {
  try {
    // Use the existing SECURE_TOKEN from login system for JWT verification
    const jwtSecret = process.env.SECURE_TOKEN as string;

    if (!jwtSecret) {
      throw new Error("JWT signing key is not configured");
    }

    // Critical security fix – verify algorithm, issuer, and audience
    // Prevents algorithm confusion attacks and token misuse
    const decoded = jwt.verify(token, jwtSecret, JWT_VERIFY_OPTIONS);
    return decoded as unknown as JwtPayload;
  } catch (error) {
    // Preserve the error message for 'JWT signing key is not configured'
    if (error instanceof Error && error.message === "JWT signing key is not configured") {
      throw error;
    }

    // For all other errors, throw a standardized message
    // to avoid leaking information about the verification process
    throw new Error("Invalid or expired token");
  }
}

/**
 * Extracts and verifies the JWT token from a request's Authorization header
 *
 * Handles the common pattern of extracting a Bearer token from the
 * Authorization header and verifying it in one operation.
 *
 * @param req The Next.js API request
 * @returns The decoded token payload with client information
 * @throws Error if no token is provided or if the token is invalid
 */
export function getTokenFromRequest(req: NextApiRequest): JwtPayload {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("No token provided");
  }

  const token = authHeader.split(" ")[1];
  return verifyToken(token);
}

/**
 * Higher-order function that creates a middleware for JWT authentication
 *
 * This middleware automatically handles token extraction and verification
 * before allowing the original handler to process the request. If token
 * verification fails, it returns an appropriate error response.
 *
 * Usage:
 * export default withApiMiddleware(withJwtAuth(handler));
 *
 * @param handler The API route handler to protect
 * @returns A wrapped handler that performs JWT verification
 */
/**
 * Clears all auth-related cookies to force the client into a logged-out state.
 * Mirrors the cookie set cleared by /api/logout.
 */
function clearAuthCookies(req: NextApiRequest, res: NextApiResponse): void {
  try {
    // Match the `secure` attribute used when these cookies are originally set
    // (see magicLogin/verifyMagicLink/loginWithPassword). Browsers per RFC 6265
    // may reject overwrites that don't match Secure, leaving stale cookies on
    // the client after session revocation.
    const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
    const cookies = new Cookies(req, res, { secure: isSecure });
    const names = ["authToken", "auth", "isLoggedIn", "uuid", "hasSession"];
    for (const name of names) {
      cookies.set(name, "", {
        expires: new Date(0),
        path: "/",
        secure: isSecure,
        sameSite: "lax",
      });
    }
  } catch (err) {
    console.error("Failed to clear auth cookies on session revoke:", err);
  }
}

export function withJwtAuth(
  handler: (req: NextApiRequest, res: NextApiResponse, ...args: any[]) => Promise<void> | void
) {
  return async (req: NextApiRequest, res: NextApiResponse, ...args: any[]) => {
    try {
      const token = getTokenFromRequest(req);
      if (!token) {
        const corsHeaders = createErrorCorsHeaders(req);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        return res.status(401).json({ error: "Authentication required" });
      }

      // Session revocation: boot blacklisted users even if their JWT is still valid.
      if (token.email) {
        const siteId = process.env.SITE_ID;
        if (siteId) {
          const { checkEmailBlacklist } = await import("./blacklist");
          const result = await checkEmailBlacklist(token.email, siteId);
          if (!result.skipped) {
            console.info(
              `[blacklist-cache] cache=${result.cacheHit ? "hit" : "miss"} ` +
                `method=${req.method ?? "unknown"} url=${req.url ?? "unknown"}`
            );
          }
          if (result.blocked) {
            clearAuthCookies(req, res);
            try {
              await writeAuditLog(req, "blacklist_session_revoked", token.email.toLowerCase(), {
                endpoint: req.url || "unknown",
              });
            } catch (auditErr) {
              console.error("Failed to write audit log for session revoke:", auditErr);
            }
            const corsHeaders = createErrorCorsHeaders(req);
            Object.entries(corsHeaders).forEach(([key, value]) => {
              res.setHeader(key, value);
            });
            return res.status(401).json({ message: "session_revoked" });
          }
        }
      }

      return handler(req, res, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Authentication failed";
      return res.status(401).json({ error: message });
    }
  };
}
