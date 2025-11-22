import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { getUsersCollectionName, getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { withJwtAuth, getTokenFromRequest } from "@/utils/server/jwtUtils";
import firebase from "firebase-admin";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

interface NewsletterRequest {
  subject: string;
  content: string;
  ctaUrl?: string;
  ctaText?: string;
  includeRoles?: {
    users: boolean;
    admins: boolean;
    superusers: boolean;
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const allowed = await genericRateLimiter(req, res, {
    name: "sendNewsletter",
    max: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    // Validate superuser role from Firestore (source of truth)
    await requireSuperuserRoleFromFirestore(req);

    // Get user info from JWT token
    const tokenPayload = getTokenFromRequest(req);
    const adminEmail = tokenPayload.email || "unknown";

    // Validate request body
    const { subject, content, ctaUrl, ctaText, includeRoles }: NewsletterRequest = req.body;

    if (!subject || typeof subject !== "string" || subject.trim().length === 0) {
      return res.status(400).json({ error: "Subject is required" });
    }

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return res.status(400).json({ error: "Content is required" });
    }

    if (subject.length > 200) {
      return res.status(400).json({ error: "Subject too long (max 200 characters)" });
    }

    if (content.length > 50000) {
      return res.status(400).json({ error: "Content too long (max 50,000 characters)" });
    }

    // Validate optional CTA fields
    if (ctaUrl && (!ctaText || ctaText.trim().length === 0)) {
      return res.status(400).json({ error: "CTA text is required when CTA URL is provided" });
    }

    if (ctaText && (!ctaUrl || ctaUrl.trim().length === 0)) {
      return res.status(400).json({ error: "CTA URL is required when CTA text is provided" });
    }

    // Validate role selection (default to all roles if not provided)
    const roleSelection = includeRoles || { users: true, admins: true, superusers: true };

    if (!roleSelection.users && !roleSelection.admins && !roleSelection.superusers) {
      return res.status(400).json({ error: "At least one user role must be selected" });
    }

    // Get subscribed users based on role selection
    const usersCol = getUsersCollectionName();

    // Build array of allowed roles
    const allowedRoles: string[] = [];
    if (roleSelection.users) allowedRoles.push("user");
    if (roleSelection.admins) allowedRoles.push("admin");
    if (roleSelection.superusers) allowedRoles.push("superuser");

    // Query users with selected roles
    const subscribedUsersQuery = db
      .collection(usersCol)
      .where("newsletterSubscribed", "==", true)
      .where("inviteStatus", "==", "accepted") // Only send to fully activated users
      .where("role", "in", allowedRoles); // Filter by selected roles

    const subscribedUsersSnapshot = await firestoreQueryGet(
      subscribedUsersQuery,
      "get subscribed users by role",
      "newsletter send"
    );

    if (subscribedUsersSnapshot.empty) {
      const selectedRoleNames = [];
      if (roleSelection.users) selectedRoleNames.push("Users");
      if (roleSelection.admins) selectedRoleNames.push("Admins");
      if (roleSelection.superusers) selectedRoleNames.push("Super Users");

      return res.status(400).json({
        error: "No newsletter subscribers found",
        details: `There are currently no ${selectedRoleNames.join(", ")} with newsletter subscriptions enabled. You can enable newsletter subscriptions for users in the admin user management page, or run the newsletter opt-in migration script to enable it for all existing users.`,
      });
    }

    const subscribedUsers = subscribedUsersSnapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => ({
      email: doc.id,
      data: doc.data(),
    }));

    console.log(`Queueing newsletter for ${subscribedUsers.length} subscribers`);

    // Generate unique newsletterId
    const newsletterId = db.collection(getNewslettersCollectionName()).doc().id;

    // Queue emails in Firestore
    const batch = db.batch();
    subscribedUsers.forEach((user: { email: string; data: any }) => {
      const queueRef = db!.collection(`${getNewslettersCollectionName()}/${newsletterId}/queueItems`).doc();
      batch.set(queueRef, {
        email: user.email,
        subject: subject.trim(),
        content: content.trim(),
        ctaUrl: ctaUrl?.trim() || null,
        ctaText: ctaText?.trim() || null,
        firstName: user.data?.firstName || null,
        lastName: user.data?.lastName || null,
        status: "pending",
        attempts: 0,
        createdAt: firebase.firestore.Timestamp.now(),
      });
    });

    await batch.commit();

    // Save newsletter metadata
    const now = firebase.firestore.Timestamp.now();
    const newsletterDoc = {
      subject: subject.trim(),
      content: content.trim(),
      ctaUrl: ctaUrl?.trim() || null,
      ctaText: ctaText?.trim() || null,
      sentAt: now,
      sentBy: adminEmail,
      newsletterId,
      status: "queued",
      totalQueued: subscribedUsers.length,
      sentCount: 0,
      failedCount: 0,
      createdAt: now,
    };

    await firestoreSet(
      db.collection(getNewslettersCollectionName()).doc(newsletterId),
      newsletterDoc,
      undefined,
      "save newsletter metadata"
    );

    console.log(`📊 Newsletter queued successfully:`, {
      newsletterId,
      totalQueued: subscribedUsers.length,
    });

    return res.status(200).json({
      message: "Newsletter queued successfully",
      newsletterId,
      totalQueued: subscribedUsers.length,
    });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Newsletter sending error:", error instanceof Error ? error.name : "Unknown error");
    
    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res.status(403).json({
        error: "Forbidden: Superuser privileges required",
      });
    }
    
    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Failed to send newsletter");
    return res.status(500).json({
      error: safeMessage,
    });
  }
}

export default withJwtAuth(handler);
