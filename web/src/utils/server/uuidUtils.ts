import type { NextApiRequest, NextApiResponse } from "next";
import { NextRequest } from "next/server";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { JwtPayload } from "@/utils/server/jwtUtils";
import crypto from "crypto";
import Cookies from "cookies";
import { isDevelopment } from "@/utils/env";

// UUID cookie signing using HMAC-SHA256 with SECRET_KEY
// TODO: Remove migration bridge after June 2026 - only accept signed cookies
if (!process.env.SECRET_KEY) {
  throw new Error(
    "SECRET_KEY environment variable is required. Application cannot start without proper encryption key."
  );
}

const secretKey = crypto.createHash("sha256").update(process.env.SECRET_KEY).digest();

/**
 * Creates HMAC signature for UUID cookie
 * @param uuid - The UUID to sign
 * @returns HMAC-SHA256 signature as hex string
 */
function signUUID(uuid: string): string {
  const hmac = crypto.createHmac("sha256", secretKey);
  hmac.update(uuid);
  return hmac.digest("hex");
}

/**
 * Verifies HMAC signature for UUID cookie
 * @param uuid - The UUID to verify
 * @param signature - The signature to verify against
 * @returns true if signature is valid
 */
function verifyUUIDSignature(uuid: string, signature: string): boolean {
  const expectedSignature = signUUID(uuid);
  // timingSafeEqual requires buffers of the same length
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

/**
 * Validates UUID format (RFC 4122)
 * @param uuid - String to validate
 * @returns true if valid UUID format
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Creates a signed UUID cookie value
 * Format: {uuid}--{hmac_signature}
 * @param uuid - The UUID to sign
 * @returns Signed cookie value
 */
export function createSignedUUIDCookie(uuid: string): string {
  const signature = signUUID(uuid);
  return `${uuid}--${signature}`;
}

/**
 * Parses and verifies a signed UUID cookie
 * @param cookieValue - The cookie value (may be signed or unsigned for migration)
 * @returns Object with uuid and isValidSignature flag
 */
function parseUUIDCookie(cookieValue: string): { uuid: string; isValidSignature: boolean } | null {
  if (!cookieValue) {
    return null;
  }

  // Check if cookie is signed (contains "--" separator)
  if (cookieValue.includes("--")) {
    const [uuid, signature] = cookieValue.split("--");
    if (!uuid || !signature) {
      return null;
    }

    // Verify signature
    const isValid = verifyUUIDSignature(uuid, signature);
    return { uuid, isValidSignature: isValid };
  }

  // Unsigned cookie (legacy) - return as-is for migration support
  return { uuid: cookieValue, isValidSignature: false };
}

/**
 * Securely retrieves UUID based on site configuration and authentication status
 *
 * For authenticated sites (requireLogin: true):
 * - Uses UUID from JWT token payload (secure, cryptographically signed)
 *
 * For anonymous sites (requireLogin: false):
 * - Uses UUID from cookies (signed with HMAC to prevent spoofing)
 * - TODO: Remove migration bridge after June 2026 - only accept signed cookies
 *
 * @param req - Next.js API request object
 * @param res - Next.js API response object (optional, needed for cookie migration)
 * @param userPayload - Verified JWT payload (if authenticated)
 * @returns Object with success/error status and UUID or error message
 */
export function getSecureUUID(
  req: NextApiRequest,
  res?: NextApiResponse,
  userPayload?: JwtPayload
): { success: true; uuid: string } | { success: false; error: string; statusCode: number } {
  const siteConfig = loadSiteConfigSync();

  if (siteConfig?.requireLogin) {
    // For authenticated sites: Use secure UUID from JWT token
    if (!userPayload?.uuid) {
      return {
        success: false,
        error: "UUID not found in authentication token",
        statusCode: 400,
      };
    }
    return { success: true, uuid: userPayload.uuid };
  } else {
    // For anonymous sites: Use UUID from cookies (signed to prevent spoofing)
    const rawCookie = req.cookies?.["uuid"];
    if (!rawCookie) {
      return {
        success: false,
        error: "UUID not found in cookies",
        statusCode: 400,
      };
    }

    // Parse cookie (handles both signed and unsigned for migration)
    const parsed = parseUUIDCookie(rawCookie);
    if (!parsed) {
      return {
        success: false,
        error: "Invalid UUID cookie format",
        statusCode: 400,
      };
    }

    const { uuid, isValidSignature } = parsed;

    // Validate UUID format
    if (!isValidUUID(uuid)) {
      return {
        success: false,
        error: "Invalid UUID format",
        statusCode: 400,
      };
    }

    // TODO: Remove migration bridge after June 2026
    // Migration: If unsigned cookie found, silently upgrade to signed cookie
    if (!isValidSignature && res) {
      try {
        const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
        const cookies = new Cookies(req, res, { secure: isSecure });
        const signedCookie = createSignedUUIDCookie(uuid);
        cookies.set("uuid", signedCookie, {
          httpOnly: false, // Needed for client-side access
          sameSite: "lax",
          secure: isSecure,
          maxAge: 180 * 24 * 60 * 60 * 1000, // 180 days
          path: "/",
        });
      } catch (migrationError) {
        // Silently fail migration - user can still use unsigned cookie during migration
        console.warn("Failed to migrate UUID cookie to signed format:", migrationError);
      }
    }

    // After June 2026: Only accept signed cookies
    // if (!isValidSignature) {
    //   return {
    //     success: false,
    //     error: "Invalid UUID cookie signature",
    //     statusCode: 400,
    //   };
    // }

    return { success: true, uuid };
  }
}

/**
 * Securely resolves UUID from an App Router request (no cookie migration write).
 */
export function getSecureUUIDFromAppRequest(
  req: NextRequest,
  userPayload?: JwtPayload
): { success: true; uuid: string } | { success: false; error: string; statusCode: number } {
  const siteConfig = loadSiteConfigSync();

  if (siteConfig?.requireLogin) {
    if (!userPayload?.uuid) {
      return {
        success: false,
        error: "UUID not found in authentication token",
        statusCode: 400,
      };
    }
    return { success: true, uuid: userPayload.uuid };
  }

  const rawCookie = req.cookies.get("uuid")?.value;
  if (!rawCookie) {
    return {
      success: false,
      error: "UUID not found in cookies",
      statusCode: 400,
    };
  }

  const parsed = parseUUIDCookie(rawCookie);
  if (!parsed) {
    return {
      success: false,
      error: "Invalid UUID cookie format",
      statusCode: 400,
    };
  }

  const { uuid } = parsed;
  if (!isValidUUID(uuid)) {
    return {
      success: false,
      error: "Invalid UUID format",
      statusCode: 400,
    };
  }

  return { success: true, uuid };
}

/**
 * Type guard to check if the result is successful
 */
export function isUUIDSuccess(result: ReturnType<typeof getSecureUUID>): result is { success: true; uuid: string } {
  return result.success;
}
