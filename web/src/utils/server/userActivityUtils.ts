/**
 * User activity tracking utilities
 * Updates lastActivityAt timestamp on user documents when users engage with chat, search, or conversations
 */

import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";

/**
 * Updates the lastActivityAt timestamp for a user by UUID
 * This is a fire-and-forget operation - errors are logged but don't fail the request
 *
 * @param uuid - User UUID to update
 */
export async function updateUserActivity(uuid: string): Promise<void> {
  if (!uuid || !db) {
    return; // Silently skip if UUID is missing or DB is unavailable
  }

  try {
    const usersCol = getUsersCollectionName();
    const usersRef = db.collection(usersCol);

    // Find user by UUID field
    const userQuery = usersRef.where("uuid", "==", uuid).limit(1);
    const snapshot = await userQuery.get();

    if (snapshot.empty) {
      // User not found - this is expected for anonymous users or non-login sites
      // Silently skip - no need to log
      return;
    }

    const userDoc = snapshot.docs[0];
    const now = firebase.firestore.Timestamp.now();

    // Update lastActivityAt timestamp
    await firestoreUpdate(userDoc.ref, { lastActivityAt: now }, "update user activity timestamp", `uuid: ${uuid}`);
  } catch (error: any) {
    // Log error but don't throw - this is a fire-and-forget operation
    console.error(`Failed to update user activity for UUID ${uuid}:`, error.message || error);
  }
}
