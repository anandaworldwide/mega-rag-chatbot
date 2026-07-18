/**
 * JWT Authentication Utilities for App Router
 *
 * This module provides App Router-specific utilities for JWT token verification.
 * It adapts the existing JWT validation from the Pages Router to work with App Router endpoints.
 *
 * The utilities support:
 * 1. Direct token verification (same as in Pages Router)
 * 2. Extracting and verifying tokens from App Router requests
 * 3. Creating middleware-like functions for JWT authentication in route handlers
 */

import { NextRequest, NextResponse } from "next/server";
import { JwtPayload, verifyToken } from "./jwtUtils";
import { loadSiteConfigSync } from "./loadSiteConfig";
import * as corsMiddleware from "./corsMiddleware";
import { isDevelopment } from "@/utils/env";

/**
 * Extracts and verifies the JWT token from a request's Authorization header
 *
 * Handles the common pattern of extracting a Bearer token from the
 * Authorization header and verifying it in one operation.
 *
 * @param req The Next.js App Router API request
 * @returns The decoded token payload with client information
 * @throws Error if no token is provided or if the token is invalid
 */
export function getTokenFromAppRequest(req: NextRequest): JwtPayload {
  const authHeader = req.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("No token provided");
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    throw new Error("No token provided");
  }
  return verifyToken(token);
}

function clearAuthCookiesOnResponse(response: NextResponse, req: NextRequest): void {
  try {
    const isSecure = req.headers.get("x-forwarded-proto") === "https" || !isDevelopment();
    const expire = new Date(0);
    for (const name of ["authToken", "uuid", "hasSession"]) {
      response.cookies.set(name, "", {
        expires: expire,
        path: "/",
        secure: isSecure,
        sameSite: "lax",
      });
    }
  } catch (err) {
    console.error("Failed to clear auth cookies on App Router session revoke:", err);
  }
}

function attachAuthErrorCors(errorResponse: NextResponse, req: NextRequest): NextResponse {
  const siteConfig = loadSiteConfigSync();
  if (siteConfig) {
    return corsMiddleware.addCorsHeaders(errorResponse, req, siteConfig);
  }

  if (isDevelopment()) {
    const origin = req.headers.get("origin");
    errorResponse.headers.set("Access-Control-Allow-Origin", origin || "*");
    errorResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    errorResponse.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    errorResponse.headers.set("Access-Control-Allow-Credentials", origin ? "true" : "false");
  }
  return errorResponse;
}

/**
 * Higher-order function that creates a middleware-like function for JWT authentication
 * specifically designed for App Router route handlers
 *
 * This function verifies a JWT token before allowing the handler to proceed.
 * If token verification fails, it returns an appropriate error response.
 *
 * @param handler The function to wrap with JWT authentication
 * @returns A function that first performs JWT verification
 */
export function withAppRouterJwtAuth<T>(
  handler: (req: NextRequest, context: any, token: JwtPayload) => Promise<T>
): (req: NextRequest, context?: any) => Promise<T | Response> {
  return async (req: NextRequest, context: any = {}): Promise<T | Response> => {
    try {
      // Get and verify the token
      const jwtPayload = getTokenFromAppRequest(req);

      // Session revocation: boot blacklisted users even if their JWT is still valid.
      if (jwtPayload.email) {
        const siteId = process.env.SITE_ID;
        if (siteId) {
          const { checkEmailBlacklist } = await import("./blacklist");
          const result = await checkEmailBlacklist(jwtPayload.email, siteId);
          if (result.blocked) {
            const revokeResponse = NextResponse.json({ message: "session_revoked" }, { status: 401 });
            clearAuthCookiesOnResponse(revokeResponse, req);
            return attachAuthErrorCors(revokeResponse, req);
          }
        }
      }

      // If verification succeeds, call the original handler with the token payload
      return handler(req, context, jwtPayload);
    } catch (error) {
      // Log the error for debugging (but don't expose sensitive details to client)
      const errorMessage = error instanceof Error ? error.message : "Authentication failed";
      console.error("[JWT Auth] Token verification failed:", errorMessage);

      // Log additional context for debugging
      const authHeader = req.headers.get("authorization");
      if (authHeader) {
        const tokenPreview = authHeader.substring(0, 20) + "...";
        console.error("[JWT Auth] Token preview:", tokenPreview);
      } else {
        console.error("[JWT Auth] No Authorization header found");
      }

      const errorResponse = NextResponse.json({ error: errorMessage }, { status: 401 });
      return attachAuthErrorCors(errorResponse, req);
    }
  };
}
