import { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";

interface ResubscribeToken {
  email: string;
  purpose: string;
  iat: number;
  exp: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

    // Validate token purpose
    if (decoded.purpose !== "newsletter_unsubscribe") {
      return res.status(400).json({ error: "Invalid token purpose" });
    }

    const email = decoded.email?.toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Invalid email in token" });
    }

    // Update user's newsletter subscription
    const usersCol = getUsersCollectionName();
    const userRef = db.collection(usersCol).doc(email);

    const userDoc = await firestoreGet(userRef, "get user for resubscribe", email);
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update newsletter subscription to true
    await firestoreSet(
      userRef,
      {
        newsletterSubscribed: true,
        updatedAt: firebase.firestore.Timestamp.now(),
      },
      { merge: true },
      "resubscribe to newsletter"
    );

    return res.status(200).json({
      success: true,
      message: "Successfully resubscribed to newsletter",
    });
  } catch (error: any) {
    console.error("Resubscribe error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
