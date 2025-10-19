import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withJwtAuth, getTokenFromRequest } from "@/utils/server/jwtUtils";
import { firestoreSet, firestoreGet } from "@/utils/server/firestoreRetryUtils";
import { writeAuditLog } from "@/utils/server/auditLog";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { createEmailParams } from "@/utils/server/emailTemplates";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { isDevelopment } from "@/utils/env";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
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

interface ApprovalRequest {
  requestId: string;
  requesterEmail: string;
  requesterName: string;
  adminEmail: string;
  adminName: string;
  adminLocation: string;
  status: "pending" | "approved" | "denied";
  createdAt: firebase.firestore.Timestamp;
  updatedAt: firebase.firestore.Timestamp;
  adminMessage?: string;
  processedBy?: string;
}

async function sendApprovalEmail(
  requesterEmail: string,
  requesterName: string,
  adminName: string,
  adminMessage?: string,
  req?: NextApiRequest
) {
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
  const loginUrl = `${baseUrl}/login`;

  const message = `Your access request for ${brand} has been approved by ${adminName}.

${adminMessage ? `\nMessage from ${adminName}:\n"${adminMessage}"\n` : ""}
You can now log in to access the chatbot:

${loginUrl}

Welcome to ${brand}!`;

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    requesterEmail,
    `Access Approved - ${brand}`,
    {
      greeting: `Hello ${requesterName},`,
      message,
      baseUrl,
      siteId: process.env.SITE_ID,
      actionUrl: loginUrl,
      actionText: "Log In",
    }
  );

  await ses.send(new SendEmailCommand(params));
}

async function sendDenialEmail(
  requesterEmail: string,
  requesterName: string,
  adminName: string,
  adminEmail: string,
  adminMessage?: string,
  req?: NextApiRequest
) {
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

  const message = `Your access request for ${brand} was reviewed and denied by ${adminName}.

${adminMessage ? `Message from ${adminName}:\n"${adminMessage}"\n\n` : ""}If you believe this was in error or have questions, please contact them at ${adminEmail}.

Thank you for your interest in ${brand}.`;

  const params = createEmailParams(
    process.env.CONTACT_EMAIL || "noreply@ananda.org",
    requesterEmail,
    `Access Request Update - ${brand}`,
    {
      greeting: `Hello ${requesterName},`,
      message,
      baseUrl,
      siteId: process.env.SITE_ID,
    }
  );

  await ses.send(new SendEmailCommand(params));
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "admin_pending_requests",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  // Get admin email from JWT token
  const token = getTokenFromRequest(req);
  const adminEmail = token.email?.toLowerCase();
  if (!adminEmail) {
    return res.status(401).json({ error: "Admin email not found" });
  }

  // Verify admin or superuser role
  if (token.role !== "admin" && token.role !== "superuser") {
    return res.status(403).json({ error: "Admin privileges required" });
  }

  const envPrefix = isDevelopment() ? "dev_" : "prod_";
  const collectionName = `${envPrefix}admin_approval_requests`;

  // GET - List requests by status (default: pending). Admins see their own; superusers see all.
  if (req.method === "GET") {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "pending";
      const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 100);

      let query = db.collection(collectionName).where("status", "==", status);

      // Regular admins: pending → filter by adminEmail; processed → filter by processedBy
      if (token.role !== "superuser") {
        if (status === "pending") {
          query = query.where("adminEmail", "==", adminEmail);
        } else {
          query = query.where("processedBy", "==", adminEmail);
        }
      }

      // Sort by appropriate timestamp
      const orderField = status === "pending" ? "createdAt" : "updatedAt";
      const requestsSnapshot = await query.orderBy(orderField, "desc").limit(limit).get();

      const requests: ApprovalRequest[] = [];
      requestsSnapshot.forEach((doc) => {
        const data = doc.data();
        requests.push({
          ...data,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
          updatedAt: data.updatedAt?.toDate?.() || data.updatedAt,
        } as ApprovalRequest);
      });

      return res.status(200).json({ requests });
    } catch (error: any) {
      // Check if this is a Firestore index error
      const status = typeof req.query.status === "string" ? req.query.status : "pending";
      const fieldsForIndex = (() => {
        if (token.role === "superuser") return ["status", status === "pending" ? "createdAt" : "updatedAt"];
        return [
          "status",
          status === "pending" ? "adminEmail" : "processedBy",
          status === "pending" ? "createdAt" : "updatedAt",
        ];
      })();

      const errorResponse = createIndexErrorResponse(error, {
        endpoint: "/api/admin/pendingRequests",
        collection: collectionName,
        fields: fieldsForIndex,
        query:
          token.role !== "superuser"
            ? status === "pending"
              ? "pending requests filtered by admin email, ordered by creation date"
              : "processed requests filtered by processedBy, ordered by update date"
            : status === "pending"
              ? "all pending requests ordered by creation date"
              : "all processed requests ordered by update date",
      });

      if (errorResponse.type === "firestore_index_error") {
        return res.status(500).json(errorResponse);
      }

      console.error("Error fetching pending requests:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // POST - Approve or deny a request
  if (req.method === "POST") {
    const { requestId, action, message } = req.body as {
      requestId?: string;
      action?: "approve" | "deny";
      message?: string;
    };

    if (!requestId || typeof requestId !== "string") {
      return res.status(400).json({ error: "Request ID is required" });
    }

    if (!action || !["approve", "deny"].includes(action)) {
      return res.status(400).json({ error: "Action must be 'approve' or 'deny'" });
    }

    if (message && typeof message !== "string") {
      return res.status(400).json({ error: "Message must be a string" });
    }

    try {
      const requestRef = db.collection(collectionName).doc(requestId);
      const requestDoc = await requestRef.get();

      if (!requestDoc.exists) {
        return res.status(404).json({ error: "Request not found" });
      }

      const request = requestDoc.data() as ApprovalRequest;

      // Verify this admin is the assigned approver (or is a superuser)
      if (token.role !== "superuser" && request.adminEmail.toLowerCase() !== adminEmail) {
        return res.status(403).json({ error: "You are not authorized to process this request" });
      }

      // Check if already processed
      if (request.status !== "pending") {
        return res.status(400).json({ error: `Request already ${request.status}` });
      }

      const now = firebase.firestore.Timestamp.now();
      const updates: Partial<ApprovalRequest> = {
        status: action === "approve" ? "approved" : "denied",
        updatedAt: now,
        processedBy: adminEmail,
      };

      if (message) {
        updates.adminMessage = message.trim();
      }

      await firestoreSet(requestRef, updates, { merge: true }, `${action} admin approval request`);

      // If approved, create user account and send activation email
      if (action === "approve") {
        try {
          const usersCol = getUsersCollectionName();
          const userDocRef = db.collection(usersCol).doc(request.requesterEmail.toLowerCase());
          const existing = await firestoreGet(userDocRef, "get user", request.requesterEmail);

          // Only create/update if user doesn't already exist as accepted
          if (!existing.exists || existing.data()?.inviteStatus !== "accepted") {
            const token = generateInviteToken();
            const tokenHash = await hashInviteToken(token);
            const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));

            // Parse first and last name from requesterName
            const nameParts = request.requesterName.trim().split(/\s+/);
            const firstName = nameParts[0] || "";
            const lastName = nameParts.slice(1).join(" ") || "";

            await firestoreSet(
              userDocRef,
              {
                role: "user",
                entitlements: { basic: true },
                inviteStatus: "pending",
                inviteTokenHash: tokenHash,
                inviteExpiresAt,
                invitedByEmail: request.adminEmail?.toLowerCase(),
                invitedByName: request.adminName,
                newsletterSubscribed: true,
                firstName: firstName || undefined,
                lastName: lastName || undefined,
                createdAt: existing.exists ? existing.data()?.createdAt : now,
                updatedAt: now,
              },
              existing.exists ? { merge: true } : undefined,
              existing.exists ? "update pending user" : "create user"
            );

            // Send activation email instead of generic approval email
            await sendActivationEmail(request.requesterEmail, token, req, message);
          }
        } catch (userCreationError) {
          console.error("Error creating user account:", userCreationError);
          // Fall back to sending approval email if user creation fails
          try {
            await sendApprovalEmail(request.requesterEmail, request.requesterName, request.adminName, message, req);
          } catch (emailError) {
            console.error("Error sending approval email:", emailError);
          }
        }
      } else {
        // Send denial email
        try {
          await sendDenialEmail(
            request.requesterEmail,
            request.requesterName,
            request.adminName,
            request.adminEmail,
            message,
            req
          );
        } catch (emailError) {
          console.error("Error sending denial email:", emailError);
        }
      }

      // Log audit event
      await writeAuditLog(req, `admin_approval_${action}`, request.requesterEmail.toLowerCase(), {
        outcome: "success",
        requestId,
      });

      return res.status(200).json({
        message: `Request ${action === "approve" ? "approved" : "denied"} successfully`,
        requestId,
      });
    } catch (error: any) {
      console.error(`Error processing approval request:`, error);
      await writeAuditLog(req, "admin_approval_error", undefined, {
        outcome: "server_error",
        error: error.message,
        requestId,
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withApiMiddleware(withJwtAuth(handler));
