/**
 * React Query Configuration
 *
 * This file configures the React Query client with JWT authentication:
 * - Sets up global error handling
 * - Adds authentication tokens to requests
 * - Implements retry mechanism for auth failures
 * - Configures default query settings
 */

import { QueryClient } from "@tanstack/react-query";
import { withAuth, initializeTokenManager } from "./tokenManager";

// Track if initialization has been attempted
let hasInitialized = false;

// Declare custom event types
declare global {
  interface WindowEventMap {
    fetchError: CustomEvent<{
      url: string;
      status: number;
      statusText: string;
      method: string;
    }>;
  }
}

/**
 * Custom fetch function with authentication
 *
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @returns Promise with fetch response
 */
export async function queryFetch(url: string, options: RequestInit = {}): Promise<Response> {
  // Ensure token manager is initialized before making requests
  if (!hasInitialized) {
    try {
      await initializeTokenManager();
      hasInitialized = true;
    } catch (error) {
      console.warn("Failed to initialize token manager, proceeding anyway:", error);
      // We continue even if initialization fails, as withAuth will retry
    }
  }

  const authOptions = await withAuth(options);
  let response = await fetch(url, authOptions);

  // Silent retry logic for 401 errors
  if (response.status === 401) {
    try {
      // Force token refresh and retry once
      await initializeTokenManager();
      const retryAuthOptions = await withAuth(options);
      const retryResponse = await fetch(url, retryAuthOptions);

      if (retryResponse.ok) {
        return retryResponse;
      } else {
        response = retryResponse; // Use retry response for error handling below
      }
    } catch (_retryError) {
      // Continue with original response for error handling
    }
  }

  // If the response is not ok, emit a custom event for global error handling
  if (!response.ok) {
    // Create a custom event with the response details
    const errorEvent = new CustomEvent("fetchError", {
      detail: {
        url,
        status: response.status,
        statusText: response.statusText,
        method: options.method || "GET",
      },
    });

    // Dispatch the event
    if (typeof window !== "undefined") {
      window.dispatchEvent(errorEvent);
    }

    // Log the error in development
    if (process.env.NODE_ENV === "development") {
      console.error(`API Error: ${response.status} ${response.statusText} for ${url}`);
    }
  }

  return response;
}

// Type for error with status code
interface ErrorWithStatus extends Error {
  status?: number;
}

/**
 * Creates a new QueryClient with authentication support
 *
 * @returns Configured QueryClient instance
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Standard query configuration
        refetchOnWindowFocus: false,
        retry: (failureCount: number, error: unknown) => {
          // Don't retry if status code is 4xx other than 401
          if (error instanceof Error && "status" in error) {
            const status = (error as ErrorWithStatus).status;
            if (status && status >= 400 && status < 500 && status !== 401) {
              return false;
            }
          }
          // For auth failures (401) and other errors, retry up to 3 times
          return failureCount < 3;
        },
        // Custom retry delay for auth failures
        retryDelay: (attemptIndex: number, error: unknown) => {
          // For auth failures, try immediately after token refresh
          if (error instanceof Error && "status" in error && (error as ErrorWithStatus).status === 401) {
            return 0;
          }
          // For other errors, use exponential backoff
          return Math.min(1000 * 2 ** attemptIndex, 30000);
        },
      },
      mutations: {
        // Don't retry mutations by default except for auth failures
        retry: (failureCount: number, error: unknown) => {
          // Only retry once on auth failure
          if (error instanceof Error && "status" in error && (error as ErrorWithStatus).status === 401) {
            return failureCount < 1;
          }
          return false;
        },
      },
    },
  });
}

/**
 * Default QueryClient instance
 */
export const queryClient = createQueryClient();

/**
 * Custom query key factory to ensure consistent keys
 */
export const queryKeys = {
  answers: (page?: number, sortBy?: string) => ["answers", page, sortBy],
  relatedQuestions: (docId: string) => ["relatedQuestions", docId],
  downvotedAnswers: () => ["downvotedAnswers"],
  modelComparison: (queryParams?: Record<string, any>) => ["modelComparison", queryParams],
};
