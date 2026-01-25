import type { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import path from "path";
import juice from "juice";
import { marked } from "marked";
import pug from "pug";
import { db } from "@/services/firebase";
import { getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreQueryGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { sendEmail } from "@/utils/server/emailUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { formatFullName } from "@/utils/shared/nameUtils";
import firebase from "firebase-admin";
import pMap from "p-map";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { updateLastContentEmailSent } from "@/utils/server/contentEmailTracker";
import { createErrorResponse, ERROR_CODES } from "@/utils/server/apiErrorResponse";
import { generateOpenTrackingUrl, generateClickTrackingUrl } from "@/utils/server/emailTrackingUtils";
import { addTrackingPixel } from "@/utils/server/emailTemplates";

// Concurrency limit for parallel email sending (balance speed vs rate limits)
// Set to 15 to target ~45 requests/second (3x previous rate of 5 concurrency → 14 req/s)
// AWS SES rate limit is 50/second, targeting 45 for safety margin
const EMAIL_SEND_CONCURRENCY = 15;

interface BatchRequest {
  newsletterId: string;
  batchSize?: number;
}

async function convertMarkdownToHtml(markdownContent: string): Promise<string> {
  try {
    marked.use({
      breaks: true,
      gfm: true,
    });
    const result = await marked(markdownContent);
    return typeof result === "string" ? result : markdownContent.replace(/\n/g, "<br>");
  } catch (error) {
    console.error("Markdown parsing error:", error);
    return markdownContent.replace(/\n/g, "<br>");
  }
}

function renderNewsletterHtml(templateVars: {
  subject: string;
  siteName: string;
  siteShortname: string;
  userName: string;
  content: string;
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl: string;
  settingsUrl: string;
}): string {
  const templatePath = path.join(process.cwd(), "emails", "newsletter.pug");
  const rawHtml = pug.renderFile(templatePath, templateVars);
  return juice(rawHtml);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json(createErrorResponse("Method not allowed", ERROR_CODES.VALIDATION_ERROR));
  }

  if (!db) {
    return res.status(503).json(createErrorResponse("Database not available", ERROR_CODES.DATABASE_ERROR));
  }

  try {
    // Verify superuser role from Firestore (source of truth)
    await requireSuperuserRoleFromFirestore(req);

    const { newsletterId, batchSize = 500 }: BatchRequest = req.body;
    if (!newsletterId) {
      return res.status(400).json(createErrorResponse("newsletterId required", ERROR_CODES.VALIDATION_ERROR));
    }

    // Fetch newsletter metadata (content is stored here, not in queue items)
    const newsletterRef = db.collection(getNewslettersCollectionName()).doc(newsletterId);
    const newsletterDoc = await newsletterRef.get();
    if (!newsletterDoc.exists) {
      return res.status(404).json(createErrorResponse("Newsletter not found", ERROR_CODES.NOT_FOUND));
    }
    const newsletterData = newsletterDoc.data()!;
    const { subject, content, ctaUrl, ctaText } = newsletterData;

    // Fetch pending/failed items (attempts < 3)
    const queueItemsQuery = db
      .collection(`${getNewslettersCollectionName()}/${newsletterId}/queueItems`)
      .where("status", "in", ["pending", "failed"])
      .where("attempts", "<", 3)
      .orderBy("createdAt")
      .limit(batchSize);

    const itemsSnapshot = await firestoreQueryGet(queueItemsQuery, "get queue batch", "newsletter process");

    // Load site config once
    const siteConfig = await loadSiteConfig();
    const siteName = siteConfig?.name || "Ananda Library";
    const siteShortname = siteConfig?.shortname || siteName;
    const jwtSecret = process.env.SECURE_TOKEN;
    const fromEmail = process.env.CONTACT_EMAIL;

    if (!jwtSecret || !fromEmail) {
      return res.status(500).json(createErrorResponse("Configuration missing", ERROR_CODES.CONFIGURATION_ERROR));
    }

    console.log(
      `📬 Processing ${itemsSnapshot.docs.length} newsletter queue items with concurrency ${EMAIL_SEND_CONCURRENCY}`
    );

    // Process queue items in parallel with controlled concurrency
    // Use transaction to prevent race conditions when multiple batches process same items
    const results = await pMap(
      itemsSnapshot.docs,
      async (doc: firebase.firestore.QueryDocumentSnapshot) => {
        const data = doc.data();

        // Use transaction to atomically check status and mark as processing
        // Prevents duplicate sends if multiple batch processes run simultaneously
        let canProcess = false;
        try {
          await db!.runTransaction(async (transaction) => {
            const freshDoc = await transaction.get(doc.ref);
            if (!freshDoc.exists) {
              return;
            }

            const freshData = freshDoc.data();
            // Only process if still pending or failed (not already sent)
            if (
              freshData &&
              (freshData.status === "pending" || (freshData.status === "failed" && freshData.attempts < 3))
            ) {
              // Mark as processing to prevent other batches from picking it up
              transaction.update(doc.ref, {
                status: "processing",
                updatedAt: firebase.firestore.Timestamp.now(),
              });
              canProcess = true;
            }
          });
        } catch (_txError: any) {
          // Transaction failed - skip this item
          return { type: "failed" as const, email: data.email, error: "Transaction failed" };
        }

        if (!canProcess) {
          return { type: "failed" as const, email: data.email, error: "Item already processed" };
        }

        try {
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";

          // Generate unsubscribe token
          const unsubscribeToken = jwt.sign({ email: data.email, purpose: "newsletter_unsubscribe" }, jwtSecret, {
            expiresIn: "1y",
            algorithm: "HS256",
          });
          const rawUnsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${unsubscribeToken}`;

          // Wrap unsubscribe URL with click tracking
          const unsubscribeUrl = generateClickTrackingUrl(
            rawUnsubscribeUrl,
            data.email,
            "newsletter",
            newsletterId,
            "unsubscribe",
            undefined,
            baseUrl
          );

          // Personalization (from queue item - per-user data)
          const firstName = data.firstName;
          const lastName = data.lastName;
          const userName = formatFullName(firstName, lastName) || "Friend";

          // Convert content (from newsletter metadata - shared across all recipients)
          const htmlContent = await convertMarkdownToHtml(content);

          // Wrap CTA URL with click tracking if present
          let trackedCtaUrl: string | undefined;
          if (ctaUrl) {
            trackedCtaUrl = generateClickTrackingUrl(
              ctaUrl,
              data.email,
              "newsletter",
              newsletterId,
              "cta",
              ctaText || "cta-button",
              baseUrl
            );
          }

          const settingsUrl = `${baseUrl}/settings`;
          let html = renderNewsletterHtml({
            subject,
            siteName,
            siteShortname,
            userName,
            content: htmlContent,
            ctaUrl: trackedCtaUrl,
            ctaText,
            unsubscribeUrl,
            settingsUrl,
          });

          // Add open tracking pixel
          const openTrackingUrl = generateOpenTrackingUrl(data.email, "newsletter", newsletterId, baseUrl);
          html = addTrackingPixel(html, openTrackingUrl);

          // Send
          const emailSent = await sendEmail({
            to: data.email,
            subject,
            html,
            from: fromEmail,
          });

          if (emailSent) {
            await firestoreUpdate(doc.ref, { status: "sent", updatedAt: firebase.firestore.Timestamp.now() });
            // Update content email tracking (awaited to ensure completion before function returns)
            const usersCol = getUsersCollectionName();
            const userRef = db!.collection(usersCol).doc(data.email);
            await updateLastContentEmailSent(userRef);
            return { type: "sent" as const, email: data.email };
          } else {
            // Send failed - mark as failed for retry
            await firestoreUpdate(doc.ref, {
              status: "failed",
              error: "Send failed",
              attempts: (data.attempts || 0) + 1,
              updatedAt: firebase.firestore.Timestamp.now(),
            });
            throw new Error("Send failed");
          }
        } catch (error: any) {
          const attempts = (data.attempts || 0) + 1;
          await firestoreUpdate(doc.ref, {
            status: attempts < 3 ? "failed" : "permanently_failed",
            error: error.message,
            attempts,
            updatedAt: firebase.firestore.Timestamp.now(),
          });
          return { type: "failed" as const, email: data.email, error: error.message };
        }
      },
      { concurrency: EMAIL_SEND_CONCURRENCY }
    );

    // Aggregate results from parallel processing
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const result of results) {
      if (result.type === "sent") {
        sent++;
      } else {
        failed++;
        errors.push(`${result.email}: ${result.error}`);
      }
    }

    // Get remaining count after processing
    const remainingQuery = db
      .collection(`${getNewslettersCollectionName()}/${newsletterId}/queueItems`)
      .where("status", "==", "pending");
    const remainingSnapshot = await firestoreQueryGet(remainingQuery, "get remaining count", "newsletter process");
    const remaining = remainingSnapshot.size;

    // Update metadata
    const metaRef = db.collection(getNewslettersCollectionName()).doc(newsletterId);
    await firestoreUpdate(metaRef, {
      sentCount: firebase.firestore.FieldValue.increment(sent),
      failedCount: firebase.firestore.FieldValue.increment(failed),
      status: remaining === 0 ? "completed" : "in_progress",
    });

    return res.status(200).json({ sent, failed, remaining, errors });
  } catch (error: any) {
    // Log sanitized error (prevents API key leakage)
    console.error("Batch processing error:", error instanceof Error ? error.name : "Unknown error");

    // Handle authorization errors separately
    if (error.message?.includes("Unauthorized") || error.message?.includes("Superuser")) {
      return res
        .status(403)
        .json(createErrorResponse("Forbidden: Superuser privileges required", ERROR_CODES.FORBIDDEN));
    }

    // Return safe error message (no sensitive details)
    const safeMessage = getSafeErrorMessage(error, "Batch processing failed");
    return res.status(500).json(createErrorResponse(safeMessage, ERROR_CODES.INTERNAL_ERROR));
  }
}

export default withJwtAuth(handler);
