/**
 * Utilities for admin pending-access-request NAG emails.
 * First reminder after 3 days pending; follow-ups every 3 days thereafter.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import firebase from "firebase-admin";
import { createEmailParams } from "@/utils/server/emailTemplates";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { daysSince } from "@/utils/server/dateUtils";
import { unescapeName } from "@/utils/shared/nameUtils";

export const NAG_INTERVAL_DAYS = 3;

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

/**
 * Returns true when a pending request should receive a NAG email.
 * - First nag: request has been pending >= NAG_INTERVAL_DAYS
 * - Follow-ups: >= NAG_INTERVAL_DAYS since lastNaggedAt
 */
export function shouldNagPendingAccessRequest(
  createdAt: firebase.firestore.Timestamp | Date | null | undefined,
  lastNaggedAt: firebase.firestore.Timestamp | Date | null | undefined,
  referenceTime?: number
): boolean {
  const daysPending = daysSince(createdAt, referenceTime);
  if (daysPending < NAG_INTERVAL_DAYS) {
    return false;
  }

  if (!lastNaggedAt) {
    return true;
  }

  return daysSince(lastNaggedAt, referenceTime) >= NAG_INTERVAL_DAYS;
}

export async function sendPendingAccessRequestNagEmail(options: {
  requesterEmail: string;
  requesterName: string;
  adminEmail: string;
  adminName: string;
  requestId: string;
  daysPending: number;
  referenceNote?: string;
  knowsAdmin?: boolean;
  nearestCenter?: string;
  connectionHistory?: string;
}): Promise<void> {
  const requesterName = unescapeName(options.requesterName);
  const adminName = unescapeName(options.adminName);

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_BASE_URL environment variable is required for email generation");
  }

  const siteConfig = await loadSiteConfig();
  const brand = siteConfig?.shortname || siteConfig?.name || process.env.SITE_ID || "Ananda Library Chatbot";
  const reviewUrl = `${baseUrl}/admin/approvals?request=${options.requestId}`;

  let message = `This is a reminder: ${requesterName} (${options.requesterEmail}) requested access to ${brand} ${options.daysPending} day${options.daysPending === 1 ? "" : "s"} ago, and the request is still pending.`;

  if (options.knowsAdmin === true) {
    message += `\n\nThe requester indicated that you know them.`;
  } else if (options.knowsAdmin === false) {
    message += `\n\n⚠️ Note: The requester indicated that you may not know them personally.`;
  }

  if (options.nearestCenter) {
    message += `\n\nNearest center: ${options.nearestCenter}`;
  }

  if (options.connectionHistory) {
    message += `\n\nAbout their connection:\n${options.connectionHistory}`;
  }

  if (options.referenceNote) {
    message += `\n\nSomeone who knows them:\n${options.referenceNote}`;
  }

  message += `\n\nPlease review this request and approve or deny access.`;

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    options.adminEmail,
    `Reminder: Pending ${brand} Access Request for ${requesterName}`,
    {
      greeting: `Hi ${adminName},`,
      message,
      baseUrl,
      siteId: process.env.SITE_ID,
      actionUrl: reviewUrl,
      actionText: "Review Request",
    }
  );

  await ses.send(new SendEmailCommand(params));
}
