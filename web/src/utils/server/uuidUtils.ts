import type { NextApiRequest, NextApiResponse } from "next";
import { NextRequest } from "next/server";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { JwtPayload } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import crypto from "crypto";
import Cookies from "cookies";
import { isDevelopment } from "@/utils/env";

const UUID_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// UUID cookie signing using HMAC-SHA256 with SECRET_KEY
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
 * Ensures anonymous visitors on public sites have a signed uuid cookie.
 * Called from /api/web-token during app bootstrap so cookie-based endpoints work
 * without client-side unsigned cookie writes.
 */
export function ensureAnonymousVisitorUuidCookie(req: NextApiRequest, res: NextApiResponse): void {
  const siteConfig = loadSiteConfigSync();
  if (siteConfig?.requireLogin) {
    return;
  }

  if (req.cookies?.["authToken"]) {
    return;
  }

  const rawCookie = req.cookies?.["uuid"];
  const parsed = rawCookie ? parseUUIDCookie(rawCookie) : null;
  if (parsed?.isValidSignature && isValidUUID(parsed.uuid)) {
    return;
  }

  let uuid: string;
  if (rawCookie && isValidUUID(rawCookie)) {
    uuid = rawCookie;
  } else if (parsed && isValidUUID(parsed.uuid)) {
    uuid = parsed.uuid;
  } else {
    uuid = crypto.randomUUID();
  }

  try {
    const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
    const cookies = new Cookies(req, res, { secure: isSecure });
    cookies.set("uuid", createSignedUUIDCookie(uuid), {
      httpOnly: false,
      sameSite: "lax",
      secure: isSecure,
      maxAge: UUID_COOKIE_MAX_AGE_MS,
      path: "/",
    });
  } catch (error) {
    console.warn("Failed to set signed uuid cookie for anonymous visitor:", error);
  }
}

/**
 * Parses and verifies a signed UUID cookie
 * @param cookieValue - The signed cookie value ({uuid}--{signature})
 * @returns Object with uuid and isValidSignature flag, or null if malformed
 */
function parseUUIDCookie(cookieValue: string): { uuid: string; isValidSignature: boolean } | null {
  if (!cookieValue || !cookieValue.includes("--")) {
    return null;
  }

  const [uuid, signature] = cookieValue.split("--");
  if (!uuid || !signature) {
    return null;
  }

  const isValid = verifyUUIDSignature(uuid, signature);
  return { uuid, isValidSignature: isValid };
}

/**
 * Securely retrieves UUID based on site configuration and authentication status
 *
 * For authenticated sites (requireLogin: true):
 * - Uses UUID from JWT token payload (secure, cryptographically signed)
 *
 * For anonymous sites (requireLogin: false):
 * - Uses UUID from cookies (signed with HMAC to prevent spoofing)
 *
 * @param req - Next.js API request object
 * @param res - Next.js API response object (optional, retained for call-site compatibility)
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

    const parsed = parseUUIDCookie(rawCookie);
    if (!parsed) {
      return {
        success: false,
        error: "Invalid UUID cookie format",
        statusCode: 400,
      };
    }

    const { uuid, isValidSignature } = parsed;

    if (!isValidUUID(uuid)) {
      return {
        success: false,
        error: "Invalid UUID format",
        statusCode: 400,
      };
    }

    if (!isValidSignature) {
      return {
        success: false,
        error: "Invalid UUID cookie signature",
        statusCode: 400,
      };
    }

    return { success: true, uuid };
  }
}

/**
 * Securely resolves UUID from an App Router request.
 * Prefer {@link resolveSecureUuidFromAppRequest} for login-required sites.
 */
export function getSecureUUIDFromAppRequest(
  req: NextRequest,
  userPayload?: JwtPayload
): UuidResolutionResult {
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

  return resolveUuidFromAppRequestCookie(req);
}

export type UuidResolutionResult =
  | { success: true; uuid: string }
  | { success: false; error: string; statusCode: number };

/**
 * Resolves the authenticated user's profile UUID for login-required sites.
 * Uses JWT uuid when present; otherwise loads uuid from the user's Firestore profile.
 */
export async function resolveAuthenticatedProfileUuid(token: JwtPayload): Promise<UuidResolutionResult> {
  if (token.uuid && isValidUUID(token.uuid)) {
    return { success: true, uuid: token.uuid };
  }

  const email = typeof token.email === "string" ? token.email.toLowerCase() : null;
  if (!email) {
    return {
      success: false,
      error: "UUID not found in authentication token",
      statusCode: 400,
    };
  }

  if (!db) {
    return {
      success: false,
      error: "Database not available",
      statusCode: 503,
    };
  }

  const userDoc = await firestoreGet(
    db.collection(getUsersCollectionName()).doc(email),
    "resolve authenticated profile uuid",
    email
  );
  const profileUuid = userDoc.exists ? userDoc.data()?.uuid : undefined;

  if (typeof profileUuid === "string" && isValidUUID(profileUuid)) {
    return { success: true, uuid: profileUuid };
  }

  return {
    success: false,
    error: "User profile UUID not found",
    statusCode: 400,
  };
}

/** Resolves the UUID that should be persisted on answer documents. */
export async function resolvePersistUuidForRequest(
  requireLogin: boolean,
  token: JwtPayload,
  bodyUuid: string
): Promise<UuidResolutionResult> {
  if (requireLogin) {
    return resolveAuthenticatedProfileUuid(token);
  }

  if (!bodyUuid || !isValidUUID(bodyUuid)) {
    return {
      success: false,
      error: "UUID is required and must be a valid v4 UUID",
      statusCode: 400,
    };
  }

  return { success: true, uuid: bodyUuid };
}

function resolveUuidFromAppRequestCookie(req: NextRequest): UuidResolutionResult {
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

  const { uuid, isValidSignature } = parsed;
  if (!isValidUUID(uuid)) {
    return {
      success: false,
      error: "Invalid UUID format",
      statusCode: 400,
    };
  }

  if (!isValidSignature) {
    return {
      success: false,
      error: "Invalid UUID cookie signature",
      statusCode: 400,
    };
  }

  return { success: true, uuid };
}

/**
 * Async App Router UUID resolver. Login-required sites load profile uuid from Firestore
 * when the JWT omits it; anonymous sites continue to use the signed uuid cookie.
 */
export async function resolveSecureUuidFromAppRequest(
  req: NextRequest,
  userPayload?: JwtPayload
): Promise<UuidResolutionResult> {
  const siteConfig = loadSiteConfigSync();

  if (siteConfig?.requireLogin) {
    if (!userPayload) {
      return {
        success: false,
        error: "Authentication required",
        statusCode: 401,
      };
    }
    return resolveAuthenticatedProfileUuid(userPayload);
  }

  return resolveUuidFromAppRequestCookie(req);
}

/**
 * Type guard to check if the result is successful
 */
export function isUUIDSuccess(result: ReturnType<typeof getSecureUUID>): result is { success: true; uuid: string } {
  return result.success;
}
