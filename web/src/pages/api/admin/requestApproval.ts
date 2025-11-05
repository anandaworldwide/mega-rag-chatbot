import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { writeAuditLog } from "@/utils/server/auditLog";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { createEmailParams } from "@/utils/server/emailTemplates";
import { isDevelopment } from "@/utils/env";
import { isEmailDomainWhitelisted } from "@/utils/server/domainWhitelistUtils";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import {
  generateInviteToken,
  hashInviteToken,
  getInviteExpiryDate,
  sendActivationEmail,
} from "@/utils/server/userInviteUtils";

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

interface ApprovalRequestData {
  requesterEmail: string;
  requesterName: string;
  adminEmail: string;
  adminName: string;
  adminLocation: string;
  referenceNote?: string;
  requestId: string;
  status: "pending";
  createdAt: firebase.firestore.Timestamp;
  updatedAt: firebase.firestore.Timestamp;
}

export async function sendApprovalRequestEmail(
  requesterEmail: string,
  requesterName: string,
  adminEmail: string,
  adminName: string,
  requestId: string,
  referenceNote: string | undefined,
  req?: any
) {
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

  const siteConfig = await loadSiteConfig();
  const brand = siteConfig?.shortname || siteConfig?.name || process.env.SITE_ID || "Ananda Library Chatbot";

  // Create review URL for admin
  const reviewUrl = `${baseUrl}/admin/approvals?request=${requestId}`;

  let message = `${requesterName} (${requesterEmail}) has requested access to ${brand}.`;

  if (referenceNote) {
    message += `\n\nReference: ${referenceNote}`;
  }

  message += `\n\nPlease review this request and approve or deny access.

Review Request

(Or visit ${reviewUrl})

This request requires your approval to proceed.`;

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    adminEmail,
    `New ${brand} Access Request for ${requesterName}`,
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

export async function sendRequesterConfirmationEmail(
  requesterEmail: string,
  requesterName: string,
  adminName: string,
  adminLocation: string,
  req?: any
) {
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

  const siteConfig = await loadSiteConfig();
  const brand = siteConfig?.name || siteConfig?.shortname || process.env.SITE_ID || "Ananda Library Chatbot";

  const message = `Thank you for your interest in ${brand}. Your access request has been submitted to ${adminName} (${adminLocation}).

They will review your request and get back to you soon. You should receive a response within three business days.

If you have any questions in the meantime, feel free to contact us.

Best regards,
The ${brand} Team`;

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    requesterEmail,
    "Access Request Submitted",
    {
      greeting: `Hi ${requesterName},`,
      message,
      baseUrl,
      siteId: process.env.SITE_ID,
    }
  );

  await ses.send(new SendEmailCommand(params));
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Apply rate limiting
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute
    name: "admin_request_approval",
  });
  if (!allowed) return;

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { requesterEmail, requesterName, adminEmail, adminName, adminLocation, referenceNote } = req.body as {
    requesterEmail?: string;
    requesterName?: string;
    adminEmail?: string;
    adminName?: string;
    adminLocation?: string;
    referenceNote?: string;
  };

  // Validate required fields
  if (!requesterEmail || typeof requesterEmail !== "string") {
    return res.status(400).json({ error: "Requester email is required" });
  }
  if (!requesterName || typeof requesterName !== "string") {
    return res.status(400).json({ error: "Requester name is required" });
  }
  if (!adminEmail || typeof adminEmail !== "string") {
    return res.status(400).json({ error: "Admin email is required" });
  }
  if (!adminName || typeof adminName !== "string") {
    return res.status(400).json({ error: "Admin name is required" });
  }
  if (!adminLocation || typeof adminLocation !== "string") {
    return res.status(400).json({ error: "Admin location is required" });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(requesterEmail) || !emailRegex.test(adminEmail)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  try {
    // Check if requester email domain is whitelisted
    const siteId = process.env.SITE_ID;
    if (!siteId) {
      return res.status(500).json({ error: "SITE_ID environment variable is not configured" });
    }
    const isWhitelisted = await isEmailDomainWhitelisted(requesterEmail, siteId);

    if (isWhitelisted) {
      // Create user with pending status and send activation email (skip admin approval)
      const usersCol = getUsersCollectionName();
      const userDocRef = db.collection(usersCol).doc(requesterEmail.toLowerCase());
      const existing = await firestoreGet(userDocRef, "check existing user for whitelist", requesterEmail);
      const now = firebase.firestore.Timestamp.now();

      if (existing.exists) {
        const data = existing.data() as any;
        if (data?.inviteStatus === "accepted") {
          return res.status(200).json({
            message: "User already active",
            isWhitelisted: true,
          });
        }
        if (data?.inviteStatus === "pending") {
          // Resend activation email
          const token = generateInviteToken();
          const tokenHash = await hashInviteToken(token);
          const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));
          await firestoreSet(
            userDocRef,
            { inviteTokenHash: tokenHash, inviteExpiresAt, updatedAt: now },
            { merge: true },
            "update pending user for whitelist resend"
          );
          await sendActivationEmail(requesterEmail, token, req);
          await writeAuditLog(req, "admin_approval_request", requesterEmail.toLowerCase(), {
            outcome: "activation_resent_whitelisted",
          });
          return res.status(200).json({
            message: "activation-sent",
            isWhitelisted: true,
          });
        }
      }

      // Create new user
      const token = generateInviteToken();
      const tokenHash = await hashInviteToken(token);
      const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));

      // Parse first and last name from requesterName
      const nameParts = requesterName.trim().split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      await firestoreSet(
        userDocRef,
        {
          email: requesterEmail.toLowerCase(),
          role: "user",
          entitlements: { basic: true },
          inviteStatus: "pending",
          inviteTokenHash: tokenHash,
          inviteExpiresAt,
          newsletterSubscribed: true,
          firstName,
          lastName,
          createdAt: now,
          updatedAt: now,
        },
        undefined,
        "create user via whitelisted domain"
      );
      await sendActivationEmail(requesterEmail, token, req);
      await writeAuditLog(req, "admin_approval_request", requesterEmail.toLowerCase(), {
        outcome: "created_pending_user_whitelisted",
      });
      return res.status(200).json({
        message: "activation-sent",
        isWhitelisted: true,
      });
    }

    // Not whitelisted - proceed with normal approval flow
    const envPrefix = isDevelopment() ? "dev" : "prod";
    const collectionName = `${envPrefix}_admin_approval_requests`;

    // Check if there's already a pending request for this requesterEmail + adminEmail combination
    const existingRequestsQuery = await db
      .collection(collectionName)
      .where("requesterEmail", "==", requesterEmail.toLowerCase())
      .where("adminEmail", "==", adminEmail.toLowerCase())
      .where("status", "==", "pending")
      .limit(1)
      .get();

    // If pending request exists, resend the email reminder instead of creating a new entry
    if (!existingRequestsQuery.empty) {
      const existingRequest = existingRequestsQuery.docs[0];
      const existingData = existingRequest.data() as ApprovalRequestData;

      // Resend the admin approval email (reminder)
      try {
        await sendApprovalRequestEmail(
          requesterEmail,
          requesterName,
          adminEmail,
          adminName,
          existingData.requestId,
          referenceNote,
          req
        );
      } catch (emailError) {
        console.error("Error sending reminder email:", emailError);
        return res.status(500).json({
          error: "Failed to send reminder email. Please try again or contact support.",
        });
      }

      // Log audit event for reminder
      await writeAuditLog(req, "admin_approval_reminder", requesterEmail.toLowerCase(), {
        outcome: "reminder_sent",
        adminEmail: adminEmail.toLowerCase(),
        requestId: existingData.requestId,
      });

      return res.status(200).json({
        message: "A pending request already exists. We've sent the administrator another reminder.",
        requestId: existingData.requestId,
        isReminder: true,
      });
    }

    // No pending request exists, create a new one
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = firebase.firestore.Timestamp.now();

    const approvalRequest: ApprovalRequestData = {
      requesterEmail: requesterEmail.toLowerCase(),
      requesterName: requesterName.trim(),
      adminEmail: adminEmail.toLowerCase(),
      adminName: adminName.trim(),
      adminLocation: adminLocation.trim(),
      ...(referenceNote && { referenceNote: referenceNote.trim() }),
      requestId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    // Store in Firestore
    await firestoreSet(
      db.collection(collectionName).doc(requestId),
      approvalRequest,
      undefined,
      "create admin approval request"
    );

    // Send emails (in parallel for better performance)
    const emailPromises = [
      sendApprovalRequestEmail(requesterEmail, requesterName, adminEmail, adminName, requestId, referenceNote, req),
      sendRequesterConfirmationEmail(requesterEmail, requesterName, adminName, adminLocation, req),
    ];

    try {
      await Promise.all(emailPromises);
    } catch (emailError) {
      console.error("Error sending approval emails:", emailError);

      // If emails fail to send, we should inform the user rather than silently succeed
      // Clean up the created request since emails couldn't be sent
      try {
        await db.collection(collectionName).doc(requestId).delete();
        console.log(`Cleaned up approval request ${requestId} due to email failure`);
      } catch (cleanupError) {
        console.error("Failed to clean up approval request after email error:", cleanupError);
      }

      // Return appropriate error message based on the email error type
      let errorMessage = "Failed to send approval emails. Please try again or contact support.";

      if (emailError && typeof emailError === "object" && "message" in emailError) {
        const message = (emailError as any).message || "";
        if (message.includes("not verified") || message.includes("MessageRejected")) {
          errorMessage =
            "Email sending failed due to unverified email addresses. Please contact support for assistance.";
        } else if (message.includes("rate limit") || message.includes("throttling")) {
          errorMessage = "Email sending is temporarily unavailable due to rate limits. Please try again later.";
        }
      }

      return res.status(500).json({
        error: errorMessage,
        details: process.env.NODE_ENV === "development" ? (emailError as any)?.message : undefined,
      });
    }

    // Log audit event
    await writeAuditLog(req, "admin_approval_request", requesterEmail.toLowerCase(), {
      outcome: "request_created",
      adminEmail: adminEmail.toLowerCase(),
      requestId,
    });

    return res.status(200).json({
      message: "Approval request submitted successfully",
      requestId,
    });
  } catch (error: any) {
    console.error("Error creating approval request:", error);

    // Log error audit event
    try {
      await writeAuditLog(req, "admin_approval_request", requesterEmail?.toLowerCase(), {
        outcome: "error",
        error: error.message,
        adminEmail: adminEmail?.toLowerCase(),
      });
    } catch {}

    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
