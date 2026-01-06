import { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { EmailCategory } from "@/types/user";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import firebase from "firebase-admin";

interface ResubscribeToken {
  email: string;
  purpose: string;
  category?: EmailCategory; // NEW: category-specific resubscribe
  iat: number;
  exp: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting to prevent abuse/subscription toggle attacks
  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute (matches unsubscribe but lower for toggle protection)
    name: "resubscribe",
  });
  if (!allowed) return;

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Invalid or missing token" });
    }

    // Verify JWT token
    const jwtSecret = process.env.SECURE_TOKEN;
    if (!jwtSecret) {
      console.error("SECURE_TOKEN not configured for resubscribe");
      return res.status(500).json({ error: "Server configuration error" });
    }

    let decoded: ResubscribeToken;
    try {
      // Verify algorithm for security (newsletter tokens don't use issuer/audience)
      decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as ResubscribeToken;
    } catch (jwtError: any) {
      if (jwtError.name === "TokenExpiredError") {
        return res.status(400).json({ error: "Resubscribe link has expired" });
      }
      return res.status(400).json({ error: "Invalid resubscribe token" });
    }

    // Validate token purpose (support both legacy and new format)
    const isLegacyToken = decoded.purpose === "newsletter_unsubscribe";
    const isNewToken = decoded.purpose === "email_unsubscribe";
    if (!isLegacyToken && !isNewToken) {
      return res.status(400).json({ error: "Invalid token purpose" });
    }

    const email = decoded.email?.toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Invalid email in token" });
    }

    // Determine category (default to "newsletters" for legacy tokens)
    const category: EmailCategory = decoded.category || "newsletters";

    // Update user's email preference for the specific category
    const usersCol = getUsersCollectionName();
    const userRef = db.collection(usersCol).doc(email);

    const userDoc = await firestoreGet(userRef, "get user for resubscribe", email);
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();
    const currentPreferences = userData?.emailPreferences || {};

    // Update the specific category preference to true
    const updatedPreferences = {
      ...currentPreferences,
      [category]: true,
    };

    // Also update legacy newsletterSubscribed for backward compatibility
    const updates: any = {
      emailPreferences: updatedPreferences,
      updatedAt: firebase.firestore.Timestamp.now(),
    };

    if (category === "newsletters" || isLegacyToken) {
      updates.newsletterSubscribed = true;
    }

    await firestoreSet(userRef, updates, { merge: true }, `resubscribe to ${category}`);

    // Category display names
    const categoryNames: Record<EmailCategory, string> = {
      newsletters: "newsletter updates",
      onboarding: "onboarding emails",
      reengagement: "re-engagement emails",
      specialDay: "special day emails",
      nps: "survey emails",
    };
    const categoryDisplayName = categoryNames[category] || "emails";

    return res.status(200).json({
      success: true,
      message: `Successfully resubscribed to ${categoryDisplayName}`,
    });
  } catch (error: any) {
    console.error("Resubscribe error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
