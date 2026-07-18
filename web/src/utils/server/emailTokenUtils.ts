/**
 * Email token utilities for generating and verifying secure tokens
 * Used for unsubscribe links, open tracking, and click tracking
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";
import { EmailCategory } from "@/types/user";

/**
 * Generates a signed unsubscribe token for a specific email category
 *
 * @param email - User email address
 * @param category - Email category ("onboarding", "newsletters", "reengagement")
 * @returns JWT token string
 * @throws Error if SECURE_TOKEN is not configured
 */
export function generateUnsubscribeToken(email: string, category: EmailCategory | string): string {
  const jwtSecret = process.env.SECURE_TOKEN;
  if (!jwtSecret) {
    throw new Error("SECURE_TOKEN not configured");
  }

  return jwt.sign(
    {
      email: email.toLowerCase(),
      purpose: "email_unsubscribe",
      category: category,
    },
    jwtSecret,
    {
      algorithm: "HS256", // Use HS256 for unsubscribe tokens (no issuer/audience)
      expiresIn: "1y", // Long expiry for unsubscribe links
    }
  );
}

function assertTokenFieldSafe(value: string, fieldName: string): void {
  if (value.includes(":")) {
    throw new Error(`${fieldName} cannot contain ':' for email tracking tokens`);
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Generates a signed open tracking token using HMAC
 * This prevents token forgery for analytics manipulation
 *
 * @param email - User email address
 * @param campaignType - Type of campaign
 * @param campaignId - Campaign identifier
 * @returns Base64 encoded token with HMAC signature
 */
export function generateSignedOpenToken(email: string, campaignType: string, campaignId: string | number): string {
  const normalizedEmail = email.toLowerCase();
  assertTokenFieldSafe(normalizedEmail, "email");
  assertTokenFieldSafe(campaignType, "campaignType");
  assertTokenFieldSafe(String(campaignId), "campaignId");

  const secret = process.env.SECURE_TOKEN;
  if (!secret) {
    // Fall back to unsigned token if no secret (for backwards compatibility)
    console.warn("SECURE_TOKEN not configured - using unsigned open tracking token");
    const payload = `${normalizedEmail}:${campaignType}:${campaignId}:${Date.now()}`;
    return Buffer.from(payload).toString("base64");
  }

  const timestamp = Date.now();
  const payload = `${normalizedEmail}:${campaignType}:${campaignId}:${timestamp}`;

  // Create HMAC signature
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const signature = hmac.digest("hex").substring(0, 16); // Use first 16 chars for brevity

  // Combine payload and signature
  const signedPayload = `${payload}:${signature}`;
  return Buffer.from(signedPayload).toString("base64");
}

/**
 * Result of verifying an open tracking token
 */
export interface OpenTokenPayload {
  email: string;
  campaignType: string;
  campaignId: string;
  timestamp: number;
  isValid: boolean;
}

/**
 * Verifies and decodes a signed open tracking token
 *
 * @param token - Base64 encoded token
 * @returns Decoded payload with validity flag
 */
export function verifyOpenToken(token: string): OpenTokenPayload | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split(":");

    // Legacy unsigned = 4 parts; signed = 5. Reject other lengths.
    if (parts.length !== 4 && parts.length !== 5) {
      return null;
    }

    const [email, campaignType, campaignId, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    if (!email || !campaignType || !campaignId || isNaN(timestamp)) {
      return null;
    }

    // If no signature (legacy token), mark as valid but log warning
    if (!signature) {
      console.warn("Received legacy unsigned open tracking token");
      return {
        email: email.toLowerCase(),
        campaignType,
        campaignId,
        timestamp,
        isValid: true, // Accept legacy tokens during transition
      };
    }

    // Verify signature
    const secret = process.env.SECURE_TOKEN;
    if (!secret) {
      // Can't verify without secret
      return {
        email: email.toLowerCase(),
        campaignType,
        campaignId,
        timestamp,
        isValid: false,
      };
    }

    const payload = `${email}:${campaignType}:${campaignId}:${timestampStr}`;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest("hex").substring(0, 16);

    const isValid = timingSafeEqualHex(signature, expectedSignature);

    return {
      email: email.toLowerCase(),
      campaignType,
      campaignId,
      timestamp,
      isValid,
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Generates a click tracking token (uses same signing as open tracking)
 *
 * @param email - User email address
 * @param campaignType - Type of campaign
 * @param campaignId - Campaign identifier
 * @param linkType - Type of link clicked
 * @param linkId - Optional link identifier
 * @returns Signed token
 */
export function generateSignedClickToken(
  email: string,
  campaignType: string,
  campaignId: string | number,
  linkType: string,
  linkId?: string
): string {
  const normalizedEmail = email.toLowerCase();
  const normalizedLinkId = linkId || "";
  assertTokenFieldSafe(normalizedEmail, "email");
  assertTokenFieldSafe(campaignType, "campaignType");
  assertTokenFieldSafe(String(campaignId), "campaignId");
  assertTokenFieldSafe(linkType, "linkType");
  assertTokenFieldSafe(normalizedLinkId, "linkId");

  const secret = process.env.SECURE_TOKEN;
  if (!secret) {
    console.warn("SECURE_TOKEN not configured - using unsigned click tracking token");
  }

  const timestamp = Date.now();
  const payload = `click:${normalizedEmail}:${campaignType}:${campaignId}:${linkType}:${normalizedLinkId}:${timestamp}`;

  if (!secret) {
    return Buffer.from(payload).toString("base64");
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const signature = hmac.digest("hex").substring(0, 16);

  return Buffer.from(`${payload}:${signature}`).toString("base64");
}

/**
 * Result of verifying a click tracking token
 */
export interface ClickTokenPayload {
  email: string;
  campaignType: string;
  campaignId: string;
  linkType: string;
  linkId: string | null;
  timestamp: number;
  isValid: boolean;
}

/**
 * Verifies and decodes a signed click tracking token
 *
 * @param token - Base64 encoded token
 * @returns Decoded payload with validity flag, or null if invalid format
 */
export function verifyClickToken(token: string): ClickTokenPayload | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split(":");

    // click:email:campaignType:campaignId:linkType:linkId:timestamp[:signature]
    if ((parts.length !== 7 && parts.length !== 8) || parts[0] !== "click") {
      return null;
    }

    const [, email, campaignType, campaignId, linkType, linkId, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    if (!email || !campaignType || !campaignId || !linkType || isNaN(timestamp)) {
      return null;
    }

    // Legacy token without signature
    if (!signature) {
      console.warn("Received legacy unsigned click tracking token");
      return {
        email: email.toLowerCase(),
        campaignType,
        campaignId,
        linkType,
        linkId: linkId || null,
        timestamp,
        isValid: true, // Accept during transition
      };
    }

    // Verify signature
    const secret = process.env.SECURE_TOKEN;
    if (!secret) {
      return {
        email: email.toLowerCase(),
        campaignType,
        campaignId,
        linkType,
        linkId: linkId || null,
        timestamp,
        isValid: false,
      };
    }

    const payload = `click:${email}:${campaignType}:${campaignId}:${linkType}:${linkId || ""}:${timestampStr}`;
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest("hex").substring(0, 16);

    const isValid = timingSafeEqualHex(signature, expectedSignature);

    return {
      email: email.toLowerCase(),
      campaignType,
      campaignId,
      linkType,
      linkId: linkId || null,
      timestamp,
      isValid,
    };
  } catch (_error) {
    return null;
  }
}
