/**
 * Network error detection and handling utilities
 *
 * Provides functions to detect network connectivity issues and generate
 * user-friendly error messages for frontend display.
 */

export interface NetworkErrorDetails {
  isNetworkError: boolean;
  errorType: "no_connection" | "timeout" | "other";
  userMessage: string;
  shouldRetry: boolean;
}

/**
 * Checks if an error is a network connectivity issue
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorMessage = error.message.toLowerCase();
  const errorCodeRaw = (error as any).code;
  const errorCode =
    typeof errorCodeRaw === "string" ? errorCodeRaw.toLowerCase() : String(errorCodeRaw || "").toLowerCase();

  // Check for DNS resolution failures
  if (errorCode === "enotfound" || errorMessage.includes("getaddrinfo enotfound")) {
    return true;
  }

  // Check for connection timeouts
  if (errorCode === "etimeout" || errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
    return true;
  }

  // Check for connection refused
  if (errorCode === "econnrefused" || errorMessage.includes("connection refused")) {
    return true;
  }

  // Check for ECONNRESET (connection reset by peer)
  if (errorCode === "econnreset" || errorMessage.includes("connection reset")) {
    return true;
  }

  // Check for network unreachable
  if (errorCode === "enetunreach" || errorMessage.includes("network unreachable")) {
    return true;
  }

  // Check nested error causes (e.g., OpenAI APIConnectionError wrapping network errors)
  const cause = (error as any).cause;
  if (cause && isNetworkError(cause)) {
    return true;
  }

  return false;
}

/**
 * Analyzes a network error and provides details for handling
 */
export function analyzeNetworkError(error: unknown): NetworkErrorDetails {
  if (!isNetworkError(error)) {
    return {
      isNetworkError: false,
      errorType: "other",
      userMessage: error instanceof Error ? error.message : "An unexpected error occurred",
      shouldRetry: false,
    };
  }

  const errorCodeRaw = (error as any).code;
  const errorCode =
    typeof errorCodeRaw === "string" ? errorCodeRaw.toLowerCase() : String(errorCodeRaw || "").toLowerCase();
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : "";

  // No internet connection
  if (errorCode === "enotfound" || errorMessage.includes("getaddrinfo enotfound")) {
    return {
      isNetworkError: true,
      errorType: "no_connection",
      userMessage: "Unable to connect to the server. Please check your internet connection and try again.",
      shouldRetry: true,
    };
  }

  // Connection timeout
  if (errorCode === "etimeout" || errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
    return {
      isNetworkError: true,
      errorType: "timeout",
      userMessage: "Connection timed out. The server is taking too long to respond. Please try again.",
      shouldRetry: true,
    };
  }

  // Connection refused
  if (errorCode === "econnrefused" || errorMessage.includes("connection refused")) {
    return {
      isNetworkError: true,
      errorType: "no_connection",
      userMessage: "Unable to connect to the server. Please try again in a moment.",
      shouldRetry: true,
    };
  }

  // Connection reset
  if (errorCode === "econnreset" || errorMessage.includes("connection reset")) {
    return {
      isNetworkError: true,
      errorType: "no_connection",
      userMessage: "Connection lost. Please try again.",
      shouldRetry: true,
    };
  }

  // Network unreachable
  if (errorCode === "enetunreach" || errorMessage.includes("network unreachable")) {
    return {
      isNetworkError: true,
      errorType: "no_connection",
      userMessage: "Network unreachable. Please check your internet connection.",
      shouldRetry: true,
    };
  }

  // Generic network error
  return {
    isNetworkError: true,
    errorType: "other",
    userMessage: "Network error occurred. Please check your connection and try again.",
    shouldRetry: true,
  };
}

/**
 * Creates a standardized error response for network errors
 */
export function createNetworkErrorResponse(
  error: unknown,
  operationName: string = "operation"
): {
  error: string;
  type: string;
  shouldRetry: boolean;
  operation?: string;
} {
  const analysis = analyzeNetworkError(error);

  // Log the network error with operation context
  console.error(`Network error during ${operationName}:`, {
    error: error instanceof Error ? error.message : String(error),
    code: (error as any).code,
    operation: operationName,
    timestamp: new Date().toISOString(),
  });

  return {
    error: analysis.userMessage,
    type: "network_error",
    shouldRetry: analysis.shouldRetry,
    operation: operationName,
  };
}
