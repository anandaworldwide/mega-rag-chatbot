/**
 * Content email tracking utility
 * Updates lastContentEmailSentAt timestamp when content emails are sent
 * (newsletters, NPS surveys, onboarding, reengagement, special days)
 * Excludes transactional emails (login links, activation, password resets)
 */

import firebase from "firebase-admin";
import { db } from "@/services/firebase";

/**
 * Updates the lastContentEmailSentAt timestamp for a user
 * This is called after successfully sending any content email
 * Should be awaited to ensure completion before function returns (prevents Vercel timeout issues)
 * Uses a transaction to prevent race conditions when multiple emails are sent concurrently
 *
 * @param userRef - Firestore DocumentReference to the user document
 */
export async function updateLastContentEmailSent(userRef: firebase.firestore.DocumentReference): Promise<void> {
  if (!userRef) {
    return; // Silently skip if ref is missing
  }

  if (!db) {
    console.warn(`Database not available, skipping lastContentEmailSentAt update for user ${userRef.id}`);
    return;
  }

  try {
    const now = firebase.firestore.Timestamp.now();

    // Use transaction to prevent race conditions when multiple emails are sent concurrently
    // This ensures we always get the most recent timestamp, not just the last write
    await db.runTransaction(async (transaction) => {
      // Read current document state
      const docSnapshot = await transaction.get(userRef);

      if (!docSnapshot.exists) {
        // Document doesn't exist, skip update
        return;
      }

      const currentData = docSnapshot.data();
      const currentTimestamp = currentData?.lastContentEmailSentAt;

      // Only update if new timestamp is more recent (defensive check)
      // This prevents race conditions where an older timestamp might overwrite a newer one
      if (!currentTimestamp || now.toMillis() >= currentTimestamp.toMillis()) {
        transaction.update(userRef, {
          lastContentEmailSentAt: now,
        });
      }
    });
  } catch (error: any) {
    // Log error but don't throw - this is a fire-and-forget operation
    // Failure to update tracking shouldn't prevent email sending
    console.error(`Failed to update lastContentEmailSentAt for user ${userRef.id}:`, error.message || error);
  }
}
