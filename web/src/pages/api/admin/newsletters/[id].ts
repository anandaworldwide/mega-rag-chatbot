import type { NextApiRequest, NextApiResponse } from "next";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { requireSuperuserRole } from "@/utils/server/authz";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { getNewslettersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";

interface NewsletterDetailsResponse {
  id: string;
  subject: string;
  content: string;
  sentAt: string;
  sentBy: string;
  totalQueued: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  status: string;
  ctaUrl?: string;
  ctaText?: string;
  recipients: {
    email: string;
    status: "sent" | "failed" | "pending";
    attempts: number;
    updatedAt?: string;
    error?: string;
  }[];
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const rateLimitPassed = await genericRateLimiter(req, res, {
    name: "newsletterDetails",
    max: 20,
    windowMs: 60 * 1000, // 1 minute
  });

  if (!rateLimitPassed) {
    return; // Rate limiter handles the response
  }

  try {
    // Require superuser role
    await requireSuperuserRole(req);

    const { id } = req.query;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Newsletter ID is required" });
    }

    // Check if database is available
    if (!db) {
      return res.status(503).json({ error: "Database not available" });
    }

    const newslettersCollection = getNewslettersCollectionName();

    // Fetch newsletter metadata
    const newsletterRef = db.collection(newslettersCollection).doc(id);
    const newsletterDoc = await newsletterRef.get();

    if (!newsletterDoc.exists) {
      return res.status(404).json({ error: "Newsletter not found" });
    }

    const newsletterData = newsletterDoc.data();
    if (!newsletterData) {
      return res.status(404).json({ error: "Newsletter data not found" });
    }

    // Fetch queue items (recipients)
    const queueItemsQuery = db.collection(`${newslettersCollection}/${id}/queueItems`).orderBy("createdAt");

    const queueItemsSnapshot = await firestoreQueryGet(queueItemsQuery);
    const queueItems = queueItemsSnapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        email: data.email || "",
        status: data.status || "pending",
        attempts: data.attempts || 0,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString(),
        error: data.error || undefined,
      };
    });

    // Calculate counts
    const sentCount = queueItems.filter((item: any) => item.status === "sent").length;
    const failedCount = queueItems.filter((item: any) => item.status === "failed").length;
    const pendingCount = queueItems.filter((item: any) => item.status === "pending").length;

    // Prepare response
    const response: NewsletterDetailsResponse = {
      id: newsletterDoc.id,
      subject: newsletterData.subject || "",
      content: newsletterData.content || "",
      sentAt:
        newsletterData.sentAt?.toDate?.()?.toISOString() || newsletterData.createdAt?.toDate?.()?.toISOString() || "",
      sentBy: newsletterData.sentBy || "",
      totalQueued: newsletterData.totalQueued || 0,
      sentCount,
      failedCount,
      pendingCount,
      status: newsletterData.status || "unknown",
      ctaUrl: newsletterData.ctaUrl,
      ctaText: newsletterData.ctaText,
      recipients: queueItems,
    };

    return res.status(200).json(response);
  } catch (error: any) {
    console.error("Failed to fetch newsletter details:", error);

    // Handle specific error types
    if (error.message?.includes("Unauthorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (error.message?.includes("not found")) {
      return res.status(404).json({ error: "Newsletter not found" });
    }

    return res.status(500).json({
      error: "Failed to fetch newsletter details",
      details: error.message,
    });
  }
}

export default withJwtAuth(handler);
