/**
 * Error Sanitization Utilities
 *
 * Prevents information leakage in production by:
 * - Removing stack traces from user-facing errors
 * - Sanitizing error messages to remove API keys, tokens, and sensitive data
 * - Providing safe error messages for production vs development
 */

import { isDevelopment } from "@/utils/env";

/**
 * Patterns that indicate sensitive information in error messages
 */
const SENSITIVE_PATTERNS = [
  // API keys and tokens
  /api[_-]?key["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /token["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /secret["\s:=]+([a-zA-Z0-9_-]{20,})/gi,
  /password["\s:=]+([^\s"']+)/gi,
  /bearer\s+([a-zA-Z0-9_-]{20,})/gi,
  
  // Pinecone API keys (UUID format)
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  
  // OpenAI API keys (sk- prefix)
  /sk-[a-zA-Z0-9]{32,}/gi,
  
  // AWS credentials
  /AKIA[0-9A-Z]{16}/gi,
  /aws[_-]?access[_-]?key[_-]?id["\s:=]+([A-Z0-9]{20,})/gi,
  /aws[_-]?secret[_-]?access[_-]?key["\s:=]+([A-Za-z0-9/+=]{40,})/gi,
  
  // JWT tokens
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  
  // Database connection strings
  /mongodb:\/\/[^\s"']+/gi,
  /postgres:\/\/[^\s"']+/gi,
  /mysql:\/\/[^\s"']+/gi,
  
  // Email addresses (sometimes sensitive)
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  
  // File paths (may reveal server structure)
  /\/[a-zA-Z0-9_/-]+\.(key|pem|crt|env|config)/gi,
];

/**
 * Sanitizes an error message to remove sensitive information
 * @param errorMessage - The error message to sanitize
 * @returns Sanitized error message safe for user-facing output
 */
export function sanitizeErrorMessage(errorMessage: string): string {
  if (!errorMessage || typeof errorMessage !== "string") {
    return "An error occurred";
  }

  let sanitized = errorMessage;

  // Remove sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Replace with generic placeholder
      if (match.includes("@")) {
        return "[email-redacted]";
      }
      if (match.includes("://")) {
        return "[connection-string-redacted]";
      }
      if (match.length > 20) {
        return "[redacted]";
      }
      return match.substring(0, 4) + "...";
    });
  }

  // Remove common error stack trace indicators
  sanitized = sanitized.replace(/at\s+[^\n]+/g, "");
  sanitized = sanitized.replace(/Error:\s*/g, "");
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  return sanitized || "An error occurred";
}

/**
 * Creates a safe error response for production
 * @param error - The error object
 * @param defaultMessage - Default message if error cannot be safely displayed
 * @returns Safe error message for user-facing output
 */
export function getSafeErrorMessage(
  error: unknown,
  defaultMessage: string = "An error occurred. Please try again later."
): string {
  if (isDevelopment()) {
    // In development, show full error details for debugging
    if (error instanceof Error) {
      return error.message || defaultMessage;
    }
    return String(error) || defaultMessage;
  }

  // In production, sanitize error messages
  if (error instanceof Error) {
    const sanitized = sanitizeErrorMessage(error.message);
    // Only return sanitized message if it's meaningful, otherwise use default
    if (sanitized && sanitized.length > 0 && sanitized !== "An error occurred") {
      return sanitized;
    }
  }

  return defaultMessage;
}

/**
 * Sanitizes error details for logging (removes sensitive info but keeps useful context)
 * @param error - The error object
 * @returns Sanitized error object safe for logging
 */
export function sanitizeErrorForLogging(error: unknown): {
  message: string;
  name?: string;
  code?: string;
  type?: string;
} {
  if (error instanceof Error) {
    return {
      message: sanitizeErrorMessage(error.message),
      name: error.name,
      code: (error as any).code,
      type: error.constructor.name,
    };
  }

  return {
    message: sanitizeErrorMessage(String(error)),
  };
}

/**
 * Checks if an error message contains sensitive information
 * @param errorMessage - The error message to check
 * @returns True if sensitive patterns are detected
 */
export function containsSensitiveInfo(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }

  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

