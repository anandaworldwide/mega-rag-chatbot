// Utilities: Generate/secure login magic tokens and send sign-in emails via SES (separate from activation flow).
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

export function generateLoginToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function hashLoginToken(token: string): Promise<string> {
  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
  return bcrypt.hash(token, saltRounds);
}

export function getLoginExpiryDateHours(hours: number = 1): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function sendLoginEmail(email: string, token: string, redirect?: string, req?: any) {
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

  const redirectPart = redirect ? `&redirect=${encodeURIComponent(redirect)}` : "";
  const url = `${baseUrl}/magic-login?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}${redirectPart}`;
  const siteConfig = loadSiteConfigSync();
  const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "your";

  const message = `Click here to sign in.

This link expires in one hour.`;

  const params = createEmailParams(process.env.CONTACT_EMAIL || "noreply@ananda.org", email, `Sign in to ${brand}`, {
    message,
    baseUrl,
    siteId: process.env.SITE_ID,
    actionUrl: url,
    actionText: "Click here to sign in.",
  });

  await ses.send(new SendEmailCommand(params));
}
