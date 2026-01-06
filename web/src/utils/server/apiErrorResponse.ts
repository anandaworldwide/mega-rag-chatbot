/**
 * Standardized API error response utilities
 * Ensures consistent error format across all API endpoints
 */

export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Creates a standardized error response object
 *
 * @param message - Human-readable error message
 * @param code - Optional error code for programmatic handling
 * @param details - Optional additional error details
 * @returns Standardized error response object
 */
export function createErrorResponse(
  message: string,
  code?: string,
  details?: Record<string, unknown>
): ApiErrorResponse {
  const response: ApiErrorResponse = { error: message };
  if (code) {
    response.code = code;
  }
  if (details) {
    response.details = details;
  }
  return response;
}

/**
 * Standard error codes used across the application
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
} as const;
