/**
 * General email utilities for the Ananda Library Chatbot
 * Provides functions for sending various types of emails via AWS SES
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { validateEmail, EmailValidationLevel } from "./emailValidation";

// Initialize SES client
const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
}

/**
 * Sends an email via AWS SES
 *
 * @param options - Email configuration options
 * @returns Promise<boolean> - True if email was sent successfully
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  try {
    const { to, subject, html, text, from } = options;

    // Validate required fields
    if (!to || !subject) {
      throw new Error("Email 'to' and 'subject' are required");
    }

    if (!html && !text) {
      throw new Error("Either 'html' or 'text' content is required");
    }

    // Normalize recipients to array
    const recipients = Array.isArray(to) ? to : [to];

    // Validate email addresses using centralized validation
    for (const email of recipients) {
      const validation = validateEmail(email, EmailValidationLevel.BASIC);
      if (!validation.isValid) {
        throw new Error(`Invalid email address: ${email} - ${validation.error}`);
      }
    }

    // Default from address
    const fromAddress = from || process.env.CONTACT_EMAIL || "noreply@ananda.org";

    // Build email body
    const body: any = {};
    if (html) {
      body.Html = { Data: html };
    }
    if (text) {
      body.Text = { Data: text };
    }

    // Prepare SES parameters
    const params = {
      Source: fromAddress,
      Destination: {
        ToAddresses: recipients,
      },
      Message: {
        Subject: { Data: subject },
        Body: body,
      },
    };

    // Send email
    await ses.send(new SendEmailCommand(params));
    console.log(`✅ Email sent successfully to: ${recipients.join(", ")}`);
    return true;
  } catch (error: any) {
    const errorDetails = {
      error: error.message,
      code: error.code || "UNKNOWN",
      statusCode: error.$metadata?.httpStatusCode || "UNKNOWN",
      requestId: error.$metadata?.requestId || "UNKNOWN",
    };
    console.error(`❌ Failed to send email to ${options.to}:`, errorDetails);
    console.error(`❌ From: ${options.from || process.env.CONTACT_EMAIL || "noreply@ananda.org"}`);
    console.error(`❌ Subject: ${options.subject}`);
    return false;
  }
}

/**
 * Sends a batch of emails with rate limiting
 * Useful for newsletter sending to avoid SES rate limits
 *
 * @param emails - Array of email options
 * @param batchSize - Number of emails to send per batch (default: 45)
 * @param delayMs - Delay between batches in milliseconds (default: 1000)
 * @returns Promise with success/error counts
 */
export async function sendEmailBatch(
  emails: EmailOptions[],
  batchSize: number = 45,
  delayMs: number = 1000
): Promise<{ successCount: number; errorCount: number; errors: string[] }> {
  let successCount = 0;
  let errorCount = 0;
  const errors: string[] = [];

  // Process emails in batches
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (emailOptions) => {
        try {
          await sendEmail(emailOptions);
          successCount++;
        } catch (error: any) {
          errorCount++;
          const recipient = Array.isArray(emailOptions.to) ? emailOptions.to.join(", ") : emailOptions.to;
          const errorMsg = `${recipient}: ${error.message}`;
          errors.push(errorMsg);
          console.error(`Failed to send email to ${recipient}:`, error);
        }
      })
    );

    // Add delay between batches (except for the last batch)
    if (i + batchSize < emails.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { successCount, errorCount, errors };
}
