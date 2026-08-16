/**
 * User activity tracking utilities
 * Updates lastActivityAt timestamp on user documents when users engage with chat or conversations
 */

import { db } from "@/services/firebase";
import { getUsersCollectionName } from "@/utils/server/firestoreUtils";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import firebase from "firebase-admin";

/**
 * Updates the lastActivityAt timestamp for a user by UUID
 * IMPORTANT: Must be awaited in API routes to prevent Vercel from terminating
 * the function before this completes. Use Promise.race with a timeout if needed.
 *
 * @param uuid - User UUID to update
 * @param callerContext - Optional context string identifying which endpoint called this (for debugging)
 */
export async function updateUserActivity(uuid: string, callerContext?: string): Promise<void> {
  if (!uuid || !db) {
    return; // Silently skip if UUID is missing or DB is unavailable
  }

  const startTime = Date.now();
  const context = callerContext || "unknown";

  try {
    const usersCol = getUsersCollectionName();
    const usersRef = db.collection(usersCol);

    // Find user by UUID field
    const userQuery = usersRef.where("uuid", "==", uuid).limit(1);
    const queryStartTime = Date.now();
    const snapshot = await userQuery.get();
    const queryDuration = Date.now() - queryStartTime;

    if (snapshot.empty) {
      // User not found - this is expected for anonymous users or non-login sites
      // Silently skip - no need to log
      return;
    }

    const userDoc = snapshot.docs[0];
    const now = firebase.firestore.Timestamp.now();

    // Update lastActivityAt timestamp
    const updateStartTime = Date.now();
    await firestoreUpdate(userDoc.ref, { lastActivityAt: now }, "update user activity timestamp", `uuid: ${uuid}`);
    const updateDuration = Date.now() - updateStartTime;

    // Log successful completion with timing (helps debug if these complete before EPIPE)
    const totalDuration = Date.now() - startTime;
    if (totalDuration > 500) {
      // Only log slow operations to avoid noise
      console.log(
        `[UserActivity] SUCCESS for ${uuid.slice(0, 8)}... from ${context} - query: ${queryDuration}ms, update: ${updateDuration}ms, total: ${totalDuration}ms`
      );
    }
  } catch (error: any) {
    const totalDuration = Date.now() - startTime;
    const errorMessage = error.message || String(error);
    const isEpipe = errorMessage.includes("EPIPE");

    // Capture stack trace to identify the ACTUAL caller
    const stackTrace = new Error().stack || "no stack";

    // Enhanced error logging to diagnose Vercel termination vs stale connection issues
    console.error(
      `[UserActivity] FAILED for UUID ${uuid} from ${context}:`,
      JSON.stringify({
        error: errorMessage,
        isEpipe,
        durationMs: totalDuration,
        likelyFunctionTermination: isEpipe && totalDuration < 100,
        likelyStaleConnection: isEpipe && totalDuration >= 100,
        callerContext: context,
        // Stack trace to see exactly who called this
        stack: stackTrace.split("\n").slice(0, 8).join(" -> "),
        timestamp: new Date().toISOString(),
      })
    );
  }
}
