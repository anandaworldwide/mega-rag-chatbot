// Utilities: Generate/secure activation tokens and send branded activation emails via SES.
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

export function generateInviteToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function hashInviteToken(token: string): Promise<string> {
  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
  return bcrypt.hash(token, saltRounds);
}

export function getInviteExpiryDate(days: number = 14): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function sendActivationEmail(email: string, token: string, req?: any, customMessage?: string) {
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

  const url = `${baseUrl}/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  const siteConfig = loadSiteConfigSync();
  const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "your";

  // Build the message with custom message at the top if provided
  let message = "";

  if (customMessage) {
    message = `Your request for access to ${brand} has been approved.

${customMessage}

Click here to activate your account.

This link expires in 14 days.`;
  } else {
    message = `Your request for access to ${brand} has been approved.

Click here to activate your account.

This link expires in 14 days.`;
  }

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    email,
    `Activate your account with ${brand}`,
    {
      message,
      baseUrl,
      siteId: process.env.SITE_ID,
      actionUrl: url,
      actionText: "Click here to activate your account.",
    }
  );

  await ses.send(new SendEmailCommand(params));
}

export async function sendWelcomeEmail(email: string, req?: any) {
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

  const siteConfig = loadSiteConfigSync();
  const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "your";
  const chatbotUrl = baseUrl;

  // Create welcome message with site-specific branding
  const message = `Welcome to ${brand}! Your account has been successfully activated.

You can now start exploring our spiritual teachings and resources by chatting with ${brand}.

Go to ${brand}

We're excited to have you join our community!`;

  const params = createEmailParams(process.env.CONTACT_EMAIL || "noreply@ananda.org", email, `Welcome to ${brand}!`, {
    message,
    baseUrl,
    siteId: process.env.SITE_ID,
    actionUrl: chatbotUrl,
    actionText: `Go to ${brand}`,
  });

  await ses.send(new SendEmailCommand(params));
}
