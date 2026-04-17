/**
 * Centralized retry utility for Google Cloud Firestore operations
 * Handles code 14 (UNAVAILABLE) errors and "Policy checks are unavailable" messages
 * with exponential backoff retry logic and timeout protection.
 */

import { sendOpsAlert } from "./emailOps";
import { isNetworkError, analyzeNetworkError } from "./networkErrorUtils";

// Firestore operation timeout (ms) - just under Vercel's 15s limit
const FIRESTORE_OPERATION_TIMEOUT = 14000;

/**
 * Helper function to determine if an error is a Google Cloud code 14 (UNAVAILABLE) error
 * that should be retried.
 */
export function isCode14Error(error: unknown): boolean {
  if (error instanceof Error) {
    // Check for explicit code 14
    if ("code" in error && (error as any).code === 14) {
      return true;
    }
    // Check for "Policy checks are unavailable" message
    if (error.message.includes("Policy checks are unavailable")) {
      return true;
    }
    // Check for other common Google Cloud transient error patterns
    if (
      error.message.includes("UNAVAILABLE") ||
      error.message.includes("DEADLINE_EXCEEDED") ||
      error.message.includes("EBUSY")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Enhanced error logging with operation details and diagnostics
 */
function logFirestoreError(error: unknown, operationName: string, context?: string): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  const contextStr = context ? ` (${context})` : "";

  console.error(`Firestore ${operationName}${contextStr} failed:`, {
    error: errorMessage,
    stack: errorStack,
    context: context,
    operation: operationName,
    timestamp: new Date().toISOString(),
  });

  // Add diagnostics for common Firestore issues
  if (errorMessage.includes("DEADLINE_EXCEEDED") || errorMessage.includes("timeout")) {
    console.error(`FIRESTORE TIMEOUT DETECTED: The ${operationName} operation likely exceeded Firestore's deadline. 
      This could be due to:
      1. Network latency between your server and Firestore
      2. Firestore instance under heavy load
      3. Complex queries or large document operations
      4. Rate limiting on Firestore
      Consider adding circuit breakers or batch processing to handle this scenario.`);
  }
}

/**
 * Retry wrapper for Google Cloud operations with timeout protection and enhanced error handling.
 * Uses exponential backoff with a maximum of 3 attempts and 14-second timeout per attempt.
 *
 * @param operation - The async operation to retry
 * @param operationName - Human-readable name for logging
 * @param context - Additional context for logging (optional)
 * @returns Promise resolving to the operation result
 */
export async function retryOnCode14<T>(
  operation: () => Promise<T>,
  operationName: string = "operation",
  context?: string
): Promise<T> {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create a timeout with stored ID for later cleanup
      let timeoutId: NodeJS.Timeout | null = null;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Firestore ${operationName} timed out after ${FIRESTORE_OPERATION_TIMEOUT}ms`));
        }, FIRESTORE_OPERATION_TIMEOUT);
      });

      try {
        // Race the operation against the timeout
        const result = await Promise.race([operation(), timeoutPromise]);

        // If operation succeeds, clear the timeout
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        return result as T;
      } catch (error) {
        // Clear the timeout in case of error as well
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // Check for network errors - these shouldn't be retried with exponential backoff
        if (isNetworkError(error)) {
          const networkAnalysis = analyzeNetworkError(error);
          const contextStr = context ? ` (${context})` : "";
          console.error(
            `Network connectivity issue during ${operationName}${contextStr}: ${networkAnalysis.userMessage}`
          );

          // Throw immediately with user-friendly message - don't retry network errors
          const networkError = new Error(networkAnalysis.userMessage);
          (networkError as any).code = (error as any).code;
          (networkError as any).type = "network_error";
          throw networkError;
        }

        // Log the error with enhanced details
        logFirestoreError(error, operationName, context);

        if (isCode14Error(error) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
          const contextStr = context ? ` (${context})` : "";
          console.warn(
            `Google Cloud policy checks unavailable during ${operationName}${contextStr} (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // If it's a code 14 error and we've exhausted retries, send ops alert
        if (isCode14Error(error) && attempt >= maxRetries) {
          const contextStr = context ? ` (${context})` : "";
          try {
            await sendOpsAlert(
              `CRITICAL: Firestore Database Connection Failure`,
              `Firestore operation "${operationName}${contextStr}" failed after ${maxRetries} retry attempts with Code 14 (UNAVAILABLE) errors.

This indicates persistent database connectivity issues that are preventing core functionality including:
- Saving chat logs and user interactions
- User authentication and session management
- Vote tracking and analytics
- Related questions processing

IMMEDIATE ACTION REQUIRED: Check Firestore service status and connection health.`,
              {
                error: error instanceof Error ? error : new Error(String(error)),
                context: {
                  operationName,
                  context,
                  maxRetries,
                  lastAttempt: attempt,
                  errorType: "firestore_code_14",
                  timestamp: new Date().toISOString(),
                },
              }
            );
          } catch (emailError) {
            console.error("Failed to send Firestore ops alert:", emailError);
          }
        }

        // If it's a code 14 error and we've exhausted retries, or it's a different error, throw it
        throw error;
      }
    } catch (error) {
      // Check for network errors - these shouldn't be retried with exponential backoff
      if (isNetworkError(error)) {
        const networkAnalysis = analyzeNetworkError(error);
        const contextStr = context ? ` (${context})` : "";
        console.error(
          `Network connectivity issue during ${operationName}${contextStr}: ${networkAnalysis.userMessage}`
        );

        // Throw immediately with user-friendly message - don't retry network errors
        const networkError = new Error(networkAnalysis.userMessage);
        (networkError as any).code = (error as any).code;
        (networkError as any).type = "network_error";
        throw networkError;
      }

      // Log the error with enhanced details
      logFirestoreError(error, operationName, context);

      if (isCode14Error(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
        const contextStr = context ? ` (${context})` : "";
        console.warn(
          `Google Cloud policy checks unavailable during ${operationName}${contextStr} (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // If it's a code 14 error and we've exhausted retries, send ops alert
      if (isCode14Error(error) && attempt >= maxRetries) {
        const contextStr = context ? ` (${context})` : "";
        try {
          await sendOpsAlert(
            `CRITICAL: Firestore Database Connection Failure`,
            `Firestore operation "${operationName}${contextStr}" failed after ${maxRetries} retry attempts with Code 14 (UNAVAILABLE) errors.

This indicates persistent database connectivity issues that are preventing core functionality including:
- Saving chat logs and user interactions  
- User authentication and session management
- Vote tracking and analytics
- Related questions processing

IMMEDIATE ACTION REQUIRED: Check Firestore service status and connection health.`,
            {
              error: error instanceof Error ? error : new Error(String(error)),
              context: {
                operationName,
                context,
                maxRetries,
                lastAttempt: attempt,
                errorType: "firestore_code_14",
                timestamp: new Date().toISOString(),
              },
            }
          );
        } catch (emailError) {
          console.error("Failed to send Firestore ops alert:", emailError);
        }
      }

      // If it's a code 14 error and we've exhausted retries, or it's a different error, throw it
      throw error;
    }
  }

  // This should never be reached, but TypeScript requires it
  throw new Error("Unexpected end of retry loop");
}

/**
 * Wrapper for Firestore document get operations with retry logic
 */
export async function firestoreGet<T = any>(
  docRef: any,
  operationName: string = "document get",
  context?: string
): Promise<T> {
  return retryOnCode14(() => docRef.get(), operationName, context);
}

/** Max refs per Firestore `getAll` call to stay within RPC limits. */
const FIRESTORE_GET_ALL_CHUNK_SIZE = 100;

/**
 * Batch-fetch document snapshots with the same retry behavior as {@link firestoreGet}.
 * Results are ordered to match the concatenation of each chunk (same order as `docRefs`).
 */
export async function firestoreGetAll(
  firestore: { getAll: (...refs: any[]) => Promise<any[]> },
  docRefs: any[],
  operationName: string = "document getAll",
  context?: string
): Promise<any[]> {
  if (docRefs.length === 0) {
    return [];
  }
  const snapshots: any[] = [];
  for (let i = 0; i < docRefs.length; i += FIRESTORE_GET_ALL_CHUNK_SIZE) {
    const chunk = docRefs.slice(i, i + FIRESTORE_GET_ALL_CHUNK_SIZE);
    const batchSnaps = await retryOnCode14(
      () => firestore.getAll(...chunk),
      operationName,
      context !== undefined ? `${context};offset=${i}` : `offset=${i}`
    );
    snapshots.push(...batchSnaps);
  }
  return snapshots;
}

/**
 * Wrapper for Firestore document set operations with retry logic
 */
export async function firestoreSet(
  docRef: any,
  data: any,
  options?: any,
  operationName: string = "document set",
  context?: string
): Promise<void> {
  return retryOnCode14(() => (options ? docRef.set(data, options) : docRef.set(data)), operationName, context);
}

/**
 * Wrapper for Firestore document update operations with retry logic
 */
export async function firestoreUpdate(
  docRef: any,
  data: any,
  operationName: string = "document update",
  context?: string
): Promise<void> {
  return retryOnCode14(() => docRef.update(data), operationName, context);
}

/**
 * Wrapper for Firestore document delete operations with retry logic
 */
export async function firestoreDelete(
  docRef: any,
  operationName: string = "document delete",
  context?: string
): Promise<void> {
  return retryOnCode14(() => docRef.delete(), operationName, context);
}

/**
 * Wrapper for Firestore collection add operations with retry logic
 */
export async function firestoreAdd(
  collectionRef: any,
  data: any,
  operationName: string = "document add",
  context?: string
): Promise<any> {
  return retryOnCode14(() => collectionRef.add(data), operationName, context);
}

/**
 * Wrapper for Firestore batch commit operations with retry logic
 */
export async function firestoreBatchCommit(
  batch: any,
  operationName: string = "batch commit",
  context?: string
): Promise<void> {
  return retryOnCode14(() => batch.commit(), operationName, context);
}

/**
 * Wrapper for Firestore query get operations with retry logic
 */
export async function firestoreQueryGet<T = any>(
  query: any,
  operationName: string = "query get",
  context?: string
): Promise<T> {
  return retryOnCode14(() => query.get(), operationName, context);
}
