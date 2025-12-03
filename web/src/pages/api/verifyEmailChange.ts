import type { NextApiRequest, NextApiResponse } from "next";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";

import { writeAuditLog } from "@/utils/server/auditLog";
import bcrypt from "bcryptjs";
import { sendEmailChangeConfirmationEmails } from "@/utils/server/userEmailChangeUtils";
import jwt from "jsonwebtoken";

async function compareToken(token: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(token, hash);
  } catch {
    return false;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!db) return res.status(503).json({ error: "Database not available" });

  const { token, email } = req.body as { token?: string; email?: string };
  if (!token || !email) {
    return res.status(400).json({ error: "Missing token or email" });
  }

  const newEmailLower = email.toLowerCase().trim();
  const usersCol = getUsersCollectionName();

  try {
    // Find user with pending email change to this address
    const userQuery = await db.collection(usersCol).where("pendingEmail", "==", newEmailLower).limit(1).get();

    if (userQuery.empty) {
      await writeAuditLog(req, "email_change_verified", newEmailLower, {
        outcome: "failed_no_pending_change",
      });
      return res.status(400).json({ error: "No pending email change found" });
    }

    const userDoc = userQuery.docs[0];
    const userDocData = userDoc.data();
    const currentEmail = userDoc.id; // Email is stored as document ID

    // Verify token
    if (!userDocData.emailChangeTokenHash) {
      await writeAuditLog(req, "email_change_verified", newEmailLower, {
        currentEmail,
        outcome: "failed_no_token",
      });
      return res.status(400).json({ error: "Invalid verification request" });
    }

    const tokenValid = await compareToken(token, userDocData.emailChangeTokenHash);
    if (!tokenValid) {
      await writeAuditLog(req, "email_change_verified", newEmailLower, {
        currentEmail,
        outcome: "failed_invalid_token",
      });
      return res.status(400).json({ error: "Invalid verification token" });
    }

    // Check if token has expired
    const now = Date.now();
    const expiresAt = userDocData.emailChangeExpiresAt?.toMillis?.() ?? 0;
    if (!expiresAt || now > expiresAt) {
      await writeAuditLog(req, "email_change_verified", newEmailLower, {
        currentEmail,
        outcome: "failed_token_expired",
      });
      return res.status(400).json({ error: "Verification link has expired" });
    }

    // Move user document to new email key and clear pending fields
    const usersColRef = db.collection(usersCol);
    const oldDocRef = userDoc.ref;
    const newDocRef = usersColRef.doc(newEmailLower);

    // Create new document with cleared pending fields (email is stored as document ID)
    const updatedUserData = {
      ...userDocData,
      updatedAt: firebase.firestore.Timestamp.now(),
    } as any;

    // Remove pending email change fields and any existing email field
    delete updatedUserData.pendingEmail;
    delete updatedUserData.emailChangeTokenHash;
    delete updatedUserData.emailChangeExpiresAt;
    delete updatedUserData.email; // Remove email field - document ID is source of truth

    // Use a batch to atomically create new document and delete old one
    const batch = db.batch();
    batch.set(newDocRef, updatedUserData);
    batch.delete(oldDocRef);
    await batch.commit();

    // Send confirmation emails to both addresses
    await sendEmailChangeConfirmationEmails(currentEmail, newEmailLower);

    // Update auth cookie with new email to avoid requiring logout/login
    try {
      const jwtSecret = process.env.SECURE_TOKEN;
      if (jwtSecret) {
        const newAuthPayload = {
          client: "web",
          email: newEmailLower,
          role: updatedUserData.role || "user",
          site: process.env.SITE_ID || "default",
        };
        const newAuthToken = jwt.sign(newAuthPayload, jwtSecret, {
          expiresIn: "180d",
          algorithm: "HS256",
          issuer: "mega-rag-chatbot",
          audience: "mega-rag-chatbot-users",
        });

        // Set the updated auth cookie
        res.setHeader("Set-Cookie", [
          `auth=${newAuthToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${180 * 24 * 60 * 60}`,
        ]);
      }
    } catch (cookieError) {
      console.error("Failed to update auth cookie after email change:", cookieError);
      // Don't fail the email change if cookie update fails - user can manually re-login
    }

    // Audit log
    await writeAuditLog(req, "email_change_verified", newEmailLower, {
      previousEmail: currentEmail,
      outcome: "success",
    });

    return res.status(200).json({
      success: true,
      message: "Email address updated successfully",
      newEmail: newEmailLower,
    });
  } catch (err: any) {
    console.error("Email change verification error:", err);
    await writeAuditLog(req, "email_change_verified", newEmailLower, {
      outcome: "failed_server_error",
      error: err.message,
    });
    return res.status(500).json({ error: "Failed to verify email change" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
