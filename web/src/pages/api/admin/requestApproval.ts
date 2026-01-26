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
import { sanitizeEmail, sanitizeTextInput, sanitizeName } from "@/utils/server/inputSanitization";
import { getSafeErrorMessage, sanitizeErrorForLogging } from "@/utils/server/errorSanitization";
import { unescapeName } from "@/utils/shared/nameUtils";

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
  knowsAdmin?: boolean;
  nearestCenter?: string;
  connectionHistory?: string;
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
  req?: any,
  additionalContext?: {
    knowsAdmin?: boolean;
    nearestCenter?: string;
    connectionHistory?: string;
  }
) {
  // Unescape names to handle existing data with backslashes
  requesterName = unescapeName(requesterName);
  adminName = unescapeName(adminName);
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

  // Add "knows admin" context if provided
  if (additionalContext?.knowsAdmin === true) {
    message += `\n\nThe requester indicated that you know them.`;
  } else if (additionalContext?.knowsAdmin === false) {
    message += `\n\n⚠️ Note: The requester indicated that you may not know them personally.`;
  }

  // Add nearest center if provided
  if (additionalContext?.nearestCenter) {
    message += `\n\nNearest center: ${additionalContext.nearestCenter}`;
  }

  // Add connection history if provided
  if (additionalContext?.connectionHistory) {
    message += `\n\nAbout their connection:\n${additionalContext.connectionHistory}`;
  }

  if (referenceNote) {
    message += `\n\nSomeone who knows them:\n${referenceNote}`;
  }

  message += `\n\nPlease review this request and approve or deny access.`;

  // Button will be added by email template

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
  // Unescape names to handle existing data with backslashes
  requesterName = unescapeName(requesterName);
  adminName = unescapeName(adminName);
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
      actionUrl: baseUrl,
      actionText: `Visit ${brand}`,
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

  const {
    requesterEmail,
    requesterName,
    adminEmail,
    adminName,
    adminLocation,
    referenceNote,
    knowsAdmin,
    nearestCenter,
    connectionHistory,
  } = req.body as {
    requesterEmail?: string;
    requesterName?: string;
    adminEmail?: string;
    adminName?: string;
    adminLocation?: string;
    referenceNote?: string;
    knowsAdmin?: boolean;
    nearestCenter?: string;
    connectionHistory?: string;
  };

  // Validate and sanitize required fields
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

  // Sanitize email addresses with comprehensive validation
  let sanitizedRequesterEmail: string;
  let sanitizedAdminEmail: string;
  try {
    sanitizedRequesterEmail = sanitizeEmail(requesterEmail, 254);
    sanitizedAdminEmail = sanitizeEmail(adminEmail, 254);
  } catch (error: any) {
    return res.status(400).json({ error: `Invalid email: ${error.message || "Email validation failed"}` });
  }

  // Sanitize text inputs
  let sanitizedRequesterName: string;
  let sanitizedAdminName: string;
  let sanitizedAdminLocation: string;
  let sanitizedReferenceNote: string | undefined;
  let sanitizedNearestCenter: string | undefined;
  let sanitizedConnectionHistory: string | undefined;
  const sanitizedKnowsAdmin = typeof knowsAdmin === "boolean" ? knowsAdmin : undefined;
  try {
    sanitizedRequesterName = sanitizeName(requesterName, 100);
    sanitizedAdminName = sanitizeName(adminName, 100);
    sanitizedAdminLocation = sanitizeTextInput(adminLocation, {
      maxLength: 200,
      allowNewlines: false,
      allowSpecialChars: false,
    });
    if (referenceNote) {
      sanitizedReferenceNote = sanitizeTextInput(referenceNote, {
        maxLength: 1000,
        allowNewlines: true,
        allowSpecialChars: false,
      });
    }
    if (nearestCenter) {
      sanitizedNearestCenter = sanitizeTextInput(nearestCenter, {
        maxLength: 200,
        allowNewlines: false,
        allowSpecialChars: false,
      });
    }
    if (connectionHistory) {
      sanitizedConnectionHistory = sanitizeTextInput(connectionHistory, {
        maxLength: 1000,
        allowNewlines: true,
        allowSpecialChars: false,
      });
    }
  } catch (error: any) {
    return res.status(400).json({ error: `Invalid input: ${error.message || "Input validation failed"}` });
  }

  try {
    // Check if requester email domain is whitelisted
    const siteId = process.env.SITE_ID;
    if (!siteId) {
      return res.status(500).json({ error: "SITE_ID environment variable is not configured" });
    }
    const isWhitelisted = await isEmailDomainWhitelisted(sanitizedRequesterEmail, siteId);

    if (isWhitelisted) {
      // Create user with pending status and send activation email (skip admin approval)
      const usersCol = getUsersCollectionName();
      const userDocRef = db.collection(usersCol).doc(sanitizedRequesterEmail.toLowerCase());
      const existing = await firestoreGet(userDocRef, "check existing user for whitelist", sanitizedRequesterEmail);
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
          await sendActivationEmail(sanitizedRequesterEmail, token, req);
          await writeAuditLog(req, "admin_approval_request", sanitizedRequesterEmail.toLowerCase(), {
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

      // Parse first and last name from sanitized requester name
      const nameParts = sanitizedRequesterName.trim().split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      await firestoreSet(
        userDocRef,
        {
          email: sanitizedRequesterEmail.toLowerCase(),
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
      await sendActivationEmail(sanitizedRequesterEmail, token, req);
      await writeAuditLog(req, "admin_approval_request", sanitizedRequesterEmail.toLowerCase(), {
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
    // (This handles the case where someone tries to resubmit to the same admin)
    const existingRequestsQuery = await db
      .collection(collectionName)
      .where("requesterEmail", "==", sanitizedRequesterEmail.toLowerCase())
      .where("adminEmail", "==", sanitizedAdminEmail.toLowerCase())
      .where("status", "==", "pending")
      .limit(1)
      .get();

    // If pending request exists for same admin, resend the email reminder instead of creating a new entry
    if (!existingRequestsQuery.empty) {
      const existingRequest = existingRequestsQuery.docs[0];
      const existingData = existingRequest.data() as ApprovalRequestData;

      // Resend the admin approval email (reminder)
      try {
        await sendApprovalRequestEmail(
          sanitizedRequesterEmail,
          sanitizedRequesterName,
          sanitizedAdminEmail,
          sanitizedAdminName,
          existingData.requestId,
          sanitizedReferenceNote,
          req,
          {
            knowsAdmin: sanitizedKnowsAdmin,
            nearestCenter: sanitizedNearestCenter,
            connectionHistory: sanitizedConnectionHistory,
          }
        );
      } catch (emailError) {
        console.error("Error sending reminder email:", emailError);
        return res.status(500).json({
          error: "Failed to send reminder email. Please try again or contact support.",
        });
      }

      // Log audit event for reminder
      await writeAuditLog(req, "admin_approval_reminder", sanitizedRequesterEmail.toLowerCase(), {
        outcome: "reminder_sent",
        adminEmail: sanitizedAdminEmail.toLowerCase(),
        requestId: existingData.requestId,
      });

      return res.status(200).json({
        message: "A pending request already exists. We've sent the administrator another reminder.",
        requestId: existingData.requestId,
        isReminder: true,
      });
    }

    // Check if there's ANY pending request for this requesterEmail to a DIFFERENT administrator
    const anyPendingRequestQuery = await db
      .collection(collectionName)
      .where("requesterEmail", "==", sanitizedRequesterEmail.toLowerCase())
      .where("status", "==", "pending")
      .limit(1)
      .get();

    // If there's already a pending request to a different administrator, reject the new submission
    if (!anyPendingRequestQuery.empty) {
      const existingRequest = anyPendingRequestQuery.docs[0];
      const existingData = existingRequest.data() as ApprovalRequestData;

      // Log audit event for blocked duplicate submission
      await writeAuditLog(req, "admin_approval_request", sanitizedRequesterEmail.toLowerCase(), {
        outcome: "blocked_duplicate_submission",
        attemptedAdminEmail: sanitizedAdminEmail.toLowerCase(),
        existingAdminEmail: existingData.adminEmail,
        existingRequestId: existingData.requestId,
      });

      return res.status(400).json({
        error:
          "You already have a pending account activation request. Please wait for a response before submitting another request.",
        existingRequestId: existingData.requestId,
      });
    }

    // No pending request exists, create a new one
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = firebase.firestore.Timestamp.now();

    const approvalRequest: ApprovalRequestData = {
      requesterEmail: sanitizedRequesterEmail.toLowerCase(),
      requesterName: sanitizedRequesterName,
      adminEmail: sanitizedAdminEmail.toLowerCase(),
      adminName: sanitizedAdminName,
      adminLocation: sanitizedAdminLocation,
      ...(sanitizedReferenceNote && { referenceNote: sanitizedReferenceNote }),
      ...(sanitizedKnowsAdmin !== undefined && { knowsAdmin: sanitizedKnowsAdmin }),
      ...(sanitizedNearestCenter && { nearestCenter: sanitizedNearestCenter }),
      ...(sanitizedConnectionHistory && { connectionHistory: sanitizedConnectionHistory }),
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
      sendApprovalRequestEmail(
        sanitizedRequesterEmail,
        sanitizedRequesterName,
        sanitizedAdminEmail,
        sanitizedAdminName,
        requestId,
        sanitizedReferenceNote,
        req,
        {
          knowsAdmin: sanitizedKnowsAdmin,
          nearestCenter: sanitizedNearestCenter,
          connectionHistory: sanitizedConnectionHistory,
        }
      ),
      sendRequesterConfirmationEmail(
        sanitizedRequesterEmail,
        sanitizedRequesterName,
        sanitizedAdminName,
        sanitizedAdminLocation,
        req
      ),
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
    await writeAuditLog(req, "admin_approval_request", sanitizedRequesterEmail.toLowerCase(), {
      outcome: "request_created",
      adminEmail: sanitizedAdminEmail.toLowerCase(),
      requestId,
    });

    return res.status(200).json({
      message: "Approval request submitted successfully",
      requestId,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    const sanitizedError = sanitizeErrorForLogging(error);
    console.error("Error creating approval request:", sanitizedError);

    // Log error audit event with sanitized error
    // Use original email variables if sanitized versions aren't available
    const requesterEmailForLog = sanitizedRequesterEmail || requesterEmail;
    const adminEmailForLog = sanitizedAdminEmail || adminEmail;

    try {
      await writeAuditLog(req, "admin_approval_request", requesterEmailForLog?.toLowerCase(), {
        outcome: "error",
        error: sanitizedError.message,
        adminEmail: adminEmailForLog?.toLowerCase(),
      });
    } catch (auditError) {
      // Audit logging is best-effort - don't fail the main error response if audit fails
      console.error("Failed to write audit log for approval request error:", auditError);
    }

    // Return safe error message to client
    const safeMessage = getSafeErrorMessage(error, "Internal server error");
    return res.status(500).json({ error: safeMessage });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
