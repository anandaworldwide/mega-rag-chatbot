import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withJwtAuth, getTokenFromRequest } from "@/utils/server/jwtUtils";
import { writeAuditLog } from "@/utils/server/auditLog";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { createEmailParams } from "@/utils/server/emailTemplates";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { isDevelopment } from "@/utils/env";
import { createIndexErrorResponse } from "@/utils/server/firestoreIndexErrorHandler";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";
import {
  generateInviteToken,
  hashInviteToken,
  getInviteExpiryDate,
  sendActivationEmail,
} from "@/utils/server/userInviteUtils";
import { unescapeName } from "@/utils/shared/nameUtils";
import { getDefaultEmailPreferences } from "@/utils/server/emailPreferenceUtils";
import { isEmailBlacklisted } from "@/utils/server/blacklist";

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
  processedByName?: string;
}

async function sendDenialEmail(
  requesterEmail: string,
  requesterName: string,
  adminName: string,
  adminEmail: string,
  adminMessage?: string,
  req?: NextApiRequest
) {
  // Unescape names to handle existing data with backslashes
  requesterName = unescapeName(requesterName);
  adminName = unescapeName(adminName);
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
    max: 15, // requests per minute
    name: "admin_pending_requests",
    message: "Too many requests. Please wait a minute and try again.",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  // Get email of user processing this request (could be admin or superuser)
  const token = getTokenFromRequest(req);
  const processorEmail = token.email?.toLowerCase();
  if (!processorEmail) {
    return res.status(401).json({ error: "Admin email not found" });
  }

  // Verify admin or superuser role from Firestore (source of truth)
  try {
    await requireAdminRoleFromFirestore(req);
  } catch (error: any) {
    if (error.message?.includes("Unauthorized") || error.message?.includes("Admin")) {
      return res.status(403).json({ error: "Admin privileges required" });
    }
    throw error;
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
          query = query.where("adminEmail", "==", processorEmail);
        } else {
          query = query.where("processedBy", "==", processorEmail);
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

      // Pre-transaction validation - read the request first
      const requestDoc = await requestRef.get();

      if (!requestDoc.exists) {
        return res.status(404).json({ error: "Request not found" });
      }

      const request = requestDoc.data() as ApprovalRequest;

      // Verify this admin is the assigned approver (or is a superuser)
      if (token.role !== "superuser" && request.adminEmail.toLowerCase() !== processorEmail) {
        return res.status(403).json({ error: "You are not authorized to process this request" });
      }

      // Check if already processed
      if (request.status !== "pending") {
        return res.status(400).json({ error: `Request already ${request.status}` });
      }

      if (action === "approve") {
        const siteIdPending = process.env.SITE_ID;
        const requesterLower = request.requesterEmail.toLowerCase();
        if (siteIdPending && (await isEmailBlacklisted(requesterLower, siteIdPending))) {
          await writeAuditLog(req, "blacklist_block", requesterLower, {
            endpoint: "pendingRequests.approve",
            actor: "admin",
          });
          return res.status(400).json({ error: "Email is blacklisted" });
        }
      }

      // Variables to capture transaction results
      let activationToken: string | null = null;
      let shouldSendActivationEmail = false;

      // Execute approval in a transaction to ensure atomicity
      await db.runTransaction(async (transaction) => {
        // PHASE 1: ALL READS FIRST (Firestore transaction requirement)

        // Re-read request within transaction to ensure consistency
        const txRequestDoc = await transaction.get(requestRef);

        if (!txRequestDoc.exists) {
          throw new Error("Request not found in transaction");
        }

        const txRequest = txRequestDoc.data() as ApprovalRequest;

        // Verify still pending (prevent race conditions)
        if (txRequest.status !== "pending") {
          throw new Error(`Request already ${txRequest.status}`);
        }

        // Look up the name of who is processing this request
        const usersCol = getUsersCollectionName();
        const processorDocRef = db!.collection(usersCol).doc(processorEmail);
        const processorDoc = await transaction.get(processorDocRef);
        let processedByName = processorEmail; // Fallback to email if name not found
        if (processorDoc.exists) {
          const processorData = processorDoc.data();
          const firstName = processorData?.firstName || "";
          const lastName = processorData?.lastName || "";
          if (firstName || lastName) {
            processedByName = `${firstName} ${lastName}`.trim();
          }
        }

        // If approving, read user document now (before any writes)
        let existingUser: firebase.firestore.DocumentSnapshot | null = null;
        let userDocRef: firebase.firestore.DocumentReference | null = null;

        if (action === "approve" && db) {
          userDocRef = db.collection(usersCol).doc(txRequest.requesterEmail.toLowerCase());
          existingUser = await transaction.get(userDocRef);
        }

        // PHASE 2: ALL WRITES AFTER ALL READS

        const now = firebase.firestore.Timestamp.now();
        const updates: Partial<ApprovalRequest> = {
          status: action === "approve" ? "approved" : "denied",
          updatedAt: now,
          processedBy: processorEmail,
          processedByName: processedByName,
        };

        if (message) {
          updates.adminMessage = message.trim();
        }

        // Update approval request status
        transaction.update(requestRef, updates);

        // If approved, create/update user account within the same transaction
        if (action === "approve" && userDocRef && existingUser) {
          // Only create/update if user doesn't already exist as accepted
          if (!existingUser.exists || existingUser.data()?.inviteStatus !== "accepted") {
            const token = generateInviteToken();
            const tokenHash = await hashInviteToken(token);
            const inviteExpiresAt = firebase.firestore.Timestamp.fromDate(getInviteExpiryDate(14));

            // Parse first and last name from requesterName
            const nameParts = txRequest.requesterName.trim().split(/\s+/);
            const firstName = nameParts[0] || "";
            const lastName = nameParts.slice(1).join(" ") || "";

            // Use actual approver info, not the originally assigned admin
            const userData = {
              role: "user",
              entitlements: { basic: true },
              inviteStatus: "pending",
              inviteTokenHash: tokenHash,
              inviteExpiresAt,
              invitedByEmail: processorEmail, // Who actually approved
              invitedByName: processedByName, // Who actually approved
              newsletterSubscribed: true, // Legacy field for backward compatibility
              emailPreferences: getDefaultEmailPreferences(), // New multi-category preferences
              firstName,
              lastName,
              createdAt: existingUser.exists ? existingUser.data()?.createdAt : now,
              updatedAt: now,
            };

            if (existingUser.exists) {
              transaction.update(userDocRef, userData);
            } else {
              transaction.set(userDocRef, userData);
            }

            // Capture token for email sending after transaction
            activationToken = token;
            shouldSendActivationEmail = true;
          }
        }
      });

      // Transaction completed successfully - now handle external operations
      // These operations are outside the transaction because:
      // 1. They can fail without invalidating the database changes
      // 2. They involve external services (email)

      if (action === "approve") {
        if (shouldSendActivationEmail && activationToken) {
          try {
            await sendActivationEmail(request.requesterEmail, activationToken, req, message);
          } catch (emailError) {
            console.error("Error sending activation email:", emailError);
            // Email failure doesn't invalidate the approval - user can request resend
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

      // Log audit event (outside transaction)
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
