/**
 * Runtime type validation for Firestore documents
 * Validates that Firestore data matches TypeScript types at runtime
 */

import firebase from "firebase-admin";
import { User } from "@/types/user";

/**
 * Type guard to check if a value is a Firestore Timestamp
 */
export function isFirestoreTimestamp(value: any): value is firebase.firestore.Timestamp {
  return value && typeof value === "object" && typeof value.toDate === "function" && typeof value.seconds === "number";
}

/**
 * Validates a Firestore document as a User type
 * Performs runtime validation to ensure data structure matches TypeScript type
 *
 * @param data - Document data from Firestore
 * @param docId - Document ID (used as email)
 * @returns Validated User object or null if invalid
 */
export function validateUserDocument(data: any, docId: string): User | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  // Basic structure validation
  const user: User = {
    id: docId, // Email is stored as document ID
  };

  // Validate optional fields
  if (data.uuid !== undefined) {
    if (typeof data.uuid !== "string") {
      return null;
    }
    user.uuid = data.uuid;
  }

  if (data.firstName !== undefined) {
    if (typeof data.firstName !== "string") {
      return null;
    }
    user.firstName = data.firstName;
  }

  if (data.lastName !== undefined) {
    if (typeof data.lastName !== "string") {
      return null;
    }
    user.lastName = data.lastName;
  }

  if (data.inviteStatus !== undefined) {
    if (typeof data.inviteStatus !== "string") {
      return null;
    }
    user.inviteStatus = data.inviteStatus as User["inviteStatus"];
  }

  if (data.role !== undefined) {
    if (typeof data.role !== "string") {
      return null;
    }
    user.role = data.role as User["role"];
  }

  // Validate timestamp fields
  if (data.lastActivityAt !== undefined) {
    if (!isFirestoreTimestamp(data.lastActivityAt) && !(data.lastActivityAt instanceof Date)) {
      return null;
    }
    user.lastActivityAt = data.lastActivityAt;
  }

  if (data.lastNpsSurveySentAt !== undefined) {
    if (!isFirestoreTimestamp(data.lastNpsSurveySentAt)) {
      return null;
    }
    user.lastNpsSurveySentAt = data.lastNpsSurveySentAt;
  }

  if (data.lastContentEmailSentAt !== undefined) {
    if (!isFirestoreTimestamp(data.lastContentEmailSentAt)) {
      return null;
    }
    user.lastContentEmailSentAt = data.lastContentEmailSentAt;
  }

  // Validate email preferences
  if (data.emailPreferences !== undefined) {
    if (typeof data.emailPreferences !== "object" || data.emailPreferences === null) {
      return null;
    }
    user.emailPreferences = {
      newsletters: data.emailPreferences.newsletters === true,
      onboarding: data.emailPreferences.onboarding !== false,
      reengagement: data.emailPreferences.reengagement !== false,
      specialDay: data.emailPreferences.specialDay !== false,
      nps: data.emailPreferences.nps !== false,
    };
  }

  // Validate array fields
  if (data.pendingNpsSurveyKeys !== undefined) {
    if (!Array.isArray(data.pendingNpsSurveyKeys)) {
      return null;
    }
    if (!data.pendingNpsSurveyKeys.every((key: any) => typeof key === "string")) {
      return null;
    }
    user.pendingNpsSurveyKeys = data.pendingNpsSurveyKeys;
  }

  return user;
}
