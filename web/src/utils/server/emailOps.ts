// This file provides utilities for sending operational alerts via email.
// It uses AWS SES for email delivery and supports multiple recipient addresses.

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { loadSiteConfigSync } from "./loadSiteConfig";

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const SITE_SHORTNAME_FALLBACKS: Record<string, string> = {
  ananda: "Luca",
  "ananda-public": "Vivek",
  crystal: "Crystal",
  jairam: "FJH",
  photo: "PhotoWise",
};

function getSiteShortname(siteId: string): string {
  if (process.env.SITE_CONFIG) {
    const siteConfig = loadSiteConfigSync(siteId);
    if (siteConfig?.shortname?.trim()) {
      return siteConfig.shortname.trim();
    }
  }

  return SITE_SHORTNAME_FALLBACKS[siteId] || siteId;
}

/**
 * Sends an operational alert email to the configured ops team.
 *
 * @param subject - Email subject line
 * @param message - Email body content
 * @param errorDetails - Optional error details to include in the email
 * @returns Promise<boolean> - True if email was sent successfully, false otherwise
 */
export async function sendOpsAlert(
  subject: string,
  message: string,
  errorDetails?: {
    error?: Error;
    context?: Record<string, any>;
    stack?: string;
  },
  options?: {
    alertLabel?: string;
  }
): Promise<boolean> {
  try {
    const opsEmail = process.env.OPS_ALERT_EMAIL;
    if (!opsEmail) {
      console.error("OPS_ALERT_EMAIL environment variable is not set");
      return false;
    }

    // Split multiple email addresses by semicolon
    const recipientEmails = opsEmail
      .split(";")
      .map((email) => email.trim())
      .filter((email) => email.length > 0);

    if (recipientEmails.length === 0) {
      console.error("No valid email addresses found in OPS_ALERT_EMAIL");
      return false;
    }

    // Suppress alerts during testing to prevent spam when tests intentionally fail
    if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
      console.log(`[TEST MODE] Suppressing ops alert: ${subject}`);
      return true; // Return true to indicate successful "sending" for test compatibility
    }

    // Build email body with error details if provided
    let emailBody = message;

    if (errorDetails) {
      emailBody += "\n\n--- Error Details ---\n";

      if (errorDetails.error) {
        emailBody += `Error: ${errorDetails.error.message}\n`;
        emailBody += `Name: ${errorDetails.error.name}\n`;
      }

      if (errorDetails.stack) {
        emailBody += `Stack Trace:\n${errorDetails.stack}\n`;
      }

      if (errorDetails.context) {
        emailBody += `Context: ${JSON.stringify(errorDetails.context, null, 2)}\n`;
      }
    }

    // Add timestamp and environment info
    emailBody += `\n\n--- System Info ---\n`;
    emailBody += `Timestamp: ${new Date().toISOString()}\n`;
    emailBody += `Environment: ${process.env.NODE_ENV || "unknown"}\n`;
    emailBody += `Site ID: ${process.env.SITE_ID || "unknown"}\n`;

    // Determine environment and site for subject line
    const environment = process.env.NODE_ENV === "production" ? "prod" : "dev";
    const siteId = process.env.SITE_ID || "unknown";
    const siteShortname = getSiteShortname(siteId);
    const alertLabel = options?.alertLabel ?? "OPS ALERT";
    const subjectPrefix = alertLabel
      ? `[${siteShortname} chatbot ${environment} ${alertLabel}]`
      : `[${siteShortname} chatbot ${environment}]`;

    const params = {
      Source: process.env.CONTACT_EMAIL || "noreply@ananda.org",
      Destination: {
        ToAddresses: recipientEmails,
      },
      Message: {
        Subject: {
          Data: `${subjectPrefix} ${subject}`,
        },
        Body: {
          Text: {
            Data: emailBody,
          },
        },
      },
    };

    await ses.send(new SendEmailCommand(params));
    console.log(`Ops alert sent successfully to ${recipientEmails.join(", ")}`);
    return true;
  } catch (error) {
    console.error("Failed to send ops alert:", error);
    return false;
  }
}
