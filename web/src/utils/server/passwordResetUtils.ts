// Utilities: Generate/secure password reset tokens and send reset emails via SES
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { loadSiteConfigSync } from "./loadSiteConfig";
import { createEmailParams } from "./emailTemplates";

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

/**
 * Generates a cryptographically secure random token for password reset
 * @returns 32-byte random token as hex string
 */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes a password reset token using bcrypt
 * @param token - The plaintext reset token
 * @returns Promise resolving to the hashed token
 */
export async function hashResetToken(token: string): Promise<string> {
  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
  return bcrypt.hash(token, saltRounds);
}

/**
 * Gets the expiry date for a password reset token (1 hour from now)
 * @param hours - Number of hours until expiry (default: 1)
 * @returns Date object representing the expiry time
 */
export function getResetExpiryDate(hours: number = 1): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Sends a password reset email via AWS SES
 * @param email - Recipient email address
 * @param token - Password reset token (not hashed)
 * @param req - Optional Express request object for domain detection
 */
export async function sendPasswordResetEmail(email: string, token: string, req?: any) {
  // Use request domain if available, otherwise fall back to configured domain
  let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_BASE_URL environment variable is required for email generation");
  }

  if (req && req.headers) {
    const host = req.headers.host;
    const protocol = req.headers["x-forwarded-proto"] || (host?.includes("localhost") ? "http" : "https");
    if (host) {
      baseUrl = `${protocol}://${host}`;
    }
  }

  const url = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const siteConfig = loadSiteConfigSync();
  const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "your";

  const message = `You requested to reset your password for ${brand}.

Click here to reset your password.

This link expires in one hour.

If you did not request a password reset, you can safely ignore this email.`;

  const params = createEmailParams(process.env.CONTACT_EMAIL || "noreply@ananda.org", email, `Reset your password`, {
    message,
    baseUrl,
    siteId: process.env.SITE_ID,
    actionUrl: url,
    actionText: "Click here to reset your password.",
  });

  await ses.send(new SendEmailCommand(params));
}
