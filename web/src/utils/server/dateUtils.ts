/**
 * Date utilities for server-side operations
 * Centralized timestamp handling to ensure consistency across cron jobs and email features
 */

import firebase from "firebase-admin";

/**
 * Safely extracts milliseconds from a Firestore Timestamp or timestamp-like object.
 * Uses the public API (toMillis) and avoids internal properties.
 *
 * @param timestamp - Firestore Timestamp, Date, or null/undefined
 * @returns Milliseconds since epoch, or null if invalid
 */
export function getTimestampMillis(timestamp: firebase.firestore.Timestamp | Date | null | undefined): number | null {
  if (!timestamp) {
    return null;
  }

  // Handle Firestore Timestamp with toMillis method
  if (typeof (timestamp as firebase.firestore.Timestamp).toMillis === "function") {
    return (timestamp as firebase.firestore.Timestamp).toMillis();
  }

  // Handle Date objects
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }

  // Handle plain objects with toDate method (Firestore Timestamp serialized)
  if (typeof (timestamp as any).toDate === "function") {
    return (timestamp as any).toDate().getTime();
  }

  // Handle plain objects with seconds property (Firestore Timestamp JSON)
  if (typeof (timestamp as any).seconds === "number") {
    const seconds = (timestamp as any).seconds;
    const nanoseconds = (timestamp as any).nanoseconds || 0;
    return seconds * 1000 + Math.floor(nanoseconds / 1000000);
  }

  return null;
}

/**
 * Calculates the number of whole days since a given timestamp
 *
 * @param timestamp - Firestore Timestamp, Date, or null/undefined
 * @param referenceTime - Optional reference time (defaults to now), useful for testing
 * @returns Number of days since the timestamp, or 0 if timestamp is invalid
 */
export function daysSince(
  timestamp: firebase.firestore.Timestamp | Date | null | undefined,
  referenceTime?: number
): number {
  const timestampMs = getTimestampMillis(timestamp);
  if (timestampMs === null) {
    return 0;
  }

  const now = referenceTime ?? Date.now();
  const diffMs = now - timestampMs;

  // Ensure we don't return negative days for future timestamps
  if (diffMs < 0) {
    return 0;
  }

  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Checks if a timestamp falls within a specific day range (inclusive)
 *
 * @param timestamp - Firestore Timestamp, Date, or null/undefined
 * @param minDays - Minimum days ago (inclusive)
 * @param maxDays - Maximum days ago (inclusive)
 * @param referenceTime - Optional reference time for testing
 * @returns true if timestamp falls within the range
 */
export function isWithinDayRange(
  timestamp: firebase.firestore.Timestamp | Date | null | undefined,
  minDays: number,
  maxDays: number,
  referenceTime?: number
): boolean {
  const days = daysSince(timestamp, referenceTime);
  return days >= minDays && days <= maxDays;
}
